// Getting a paid customer's site online: buy the domain, check the site, publish it, and
// point the domain at it.
//
// Rules this file keeps:
// - Every step can run again safely. A launch is moved forward by the customer's page, the
//   Square webhook (marks paid and queues) and the `launcher` job that runs every minute.
// - Only one run per customer at a time: a lease with a token. The lease (10 minutes) is
//   longer than a function can run (9 minutes), and only the holder can release it.
// - No long waits inside a request: each run does what it can and returns; the next run
//   picks up from the saved state.
// - A site that's been taken offline for a reason (unpaid, refund, dispute, admin) stays
//   offline until that reason is cleared. Publishing re-checks this right before going live.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { cf, square, ApiError } from "./clients.js";
import { reviewSite } from "./ai.js";
import { domainBuyable, registrantFor, pageHash, sanitizeHtml, pageFits, monthKey, dayKey, PLANS, BILLING } from "./pure.js";
import { servedPage } from "./site.js";
import {
  MAX_DOMAIN_PRICE, MAX_DOMAINS_PER_DAY, SITES_WORKER_NAME, SQUARE_LOCATION_ID, SQUARE_ENVIRONMENT, CLOUDFLARE_ACCOUNT_ID,
  PAST_DUE_GRACE_DAYS, LAUNCH_RETRY_SECONDS, isLive,
} from "./config.js";

const db = () => getFirestore();
export const userRef = (uid) => db().collection("users").doc(uid);
export const draftRef = (uid) => userRef(uid).collection("site").doc("draft");
export const liveRef = (uid) => userRef(uid).collection("site").doc("live");
export const configRef = () => db().collection("config").doc("platform");
const env = () => SQUARE_ENVIRONMENT.value();
const ms = (t) => t?.toMillis?.() ?? (t instanceof Date ? t.getTime() : 0);

// Plan statuses during which the customer has paid for the current period.
export const PAID_STATUSES = ["active", "past_due", "canceling"];
// Statuses that end a plan for good.
export const ENDED_STATUSES = ["canceled", "refunded", "disputed"];
// States where the launch waits for the customer or Web Burrito, not for the job.
const PARKED = ["live", "needs_changes", "needs_domain", "needs_attention", "payment_failed", "suspended", "no_plan"];

/** The customer's current plan, or null if it belongs to the other Square environment. */
export const currentPlan = (u) => (u?.plan?.env === env() ? u.plan : null);
export const isPaid = (u) => Boolean(currentPlan(u)?.paid && PAID_STATUSES.includes(u.plan.status));

// ---------- lease ----------
async function acquire(uid, seconds = 600) {
  const ref = userRef(uid);
  const token = randomUUID();
  const got = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (ms(snap.get("lease.until")) > Date.now()) return false;
    tx.set(ref, { lease: { token, until: new Date(Date.now() + seconds * 1000) } }, { merge: true });
    return true;
  });
  return got ? token : null;
}
async function release(uid, token) {
  const ref = userRef(uid);
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.get("lease.token") === token) tx.set(ref, { lease: { token: null, until: null } }, { merge: true });
  });
}
/** Runs fn while holding the customer's lease; returns "busy" if someone else holds it. */
export async function withLease(uid, fn) {
  const token = await acquire(uid);
  if (!token) return "busy";
  try {
    return await fn();
  } finally {
    await release(uid, token);
  }
}

// The launcher job picks customers whose launch.nextAt has passed (oldest first).
const step = () => LAUNCH_RETRY_SECONDS.value() * 1000;
async function setLaunch(uid, state, extra = {}) {
  const { delayMs = state === "waiting_payment" ? 2 * step() : step(), ...rest } = extra;
  const queued = rest.queued ?? !PARKED.includes(state);
  await userRef(uid).set({
    launch: { state, at: FieldValue.serverTimestamp(), error: null, ...rest, queued, nextAt: queued ? new Date(Date.now() + delayMs) : null },
  }, { merge: true });
}
/** Asks the `launcher` job to move this customer forward now. */
export const queue = (uid) => userRef(uid).set({ launch: { queued: true, nextAt: new Date() } }, { merge: true });

/** A problem that stops the launch; `state` is what the customer's page shows. */
export class Step extends Error {
  constructor(message, state = "needs_attention") {
    super(message);
    this.state = state;
  }
}

// ---------- payment ----------
/** The subscription's paid invoice, if there is one. */
export async function paidInvoice(subscriptionId, customerId) {
  const sub = (await square("GET", `/v2/subscriptions/${encodeURIComponent(subscriptionId)}`)).subscription;
  let ids = sub?.invoice_ids || [];
  if (!ids.length && customerId) {
    const found = await square("POST", "/v2/invoices/search", {
      query: { filter: { location_ids: [SQUARE_LOCATION_ID.value()], customer_ids: [customerId] }, sort: { field: "INVOICE_SORT_DATE", order: "DESC" } },
      limit: 10,
    });
    ids = (found.invoices || []).filter((i) => i.subscription_id === subscriptionId).map((i) => i.id);
  }
  for (const id of ids.slice(0, 5)) {
    const inv = (await square("GET", `/v2/invoices/${encodeURIComponent(id)}`)).invoice;
    if (inv?.status === "PAID") return inv;
  }
  return null;
}

/**
 * Records a payment on the current subscription. Never brings back a plan that has ended,
 * and never turns "canceling" back into "active" (the payment just covers the last period).
 */
export async function markPaid(uid, subscriptionId, invoiceId) {
  return db().runTransaction(async (tx) => {
    const ref = userRef(uid);
    const u = (await tx.get(ref)).data() || {};
    const plan = currentPlan(u);
    if (!plan || plan.subscriptionId !== subscriptionId) return false;
    if (ENDED_STATUSES.includes(plan.status) || plan.status === "paused") return false;
    const status = plan.status === "canceling" ? "canceling" : "active";
    tx.set(ref, {
      plan: { status, paid: true, paidAt: FieldValue.serverTimestamp(), lastInvoiceId: invoiceId || null, pastDueSince: null, firstChargeFailedAt: null },
      launch: { queued: true, nextAt: new Date(), ...(u.launch?.state === "payment_failed" ? { state: "paid", error: null } : {}) },
      ...(u.live?.suspended === "unpaid" ? { live: { suspended: null } } : {}),
    }, { merge: true });
    return true;
  });
}

// ---------- domain ----------
async function getRegistration(domain) {
  const r = await cf("GET", `/accounts/{account}/registrar/registrations/${domain}`, null, { allow: [404] });
  return r.status === 404 ? null : r.body?.result || {};
}
async function registrationStatus(domain) {
  const r = await cf("GET", `/accounts/{account}/registrar/registrations/${domain}/registration-status`, null, { allow: [404] });
  return r.status === 404 ? null : r.body?.result || null;
}
/** The domain's Cloudflare zone id, creating the zone if registration didn't. */
async function ensureZone(domain) {
  const find = async () => (await cf("GET", `/zones?name=${encodeURIComponent(domain)}&account.id={account}`)).body?.result?.[0]?.id || null;
  let id = await find();
  if (!id) {
    const made = await cf("POST", "/zones", { name: domain, account: { id: CLOUDFLARE_ACCOUNT_ID.value() }, type: "full" }, { allow: [400, 409] });
    id = made.body?.result?.id || (await find());
  }
  return id;
}
export const domainIndex = (domain) => db().collection("domainIndex").doc(domain);

async function finishDomain(uid, domain) {
  // Mark it as registered for this customer for good: the name can't be released or reassigned.
  await domainIndex(domain).set({ uid, registered: true, registeredAt: FieldValue.serverTimestamp() }, { merge: true });
  let autoRenew = false;
  try {
    await cf("PUT", `/accounts/{account}/registrar/domains/${domain}`, { auto_renew: true, locked: true });
    autoRenew = true;
  } catch (err) {
    // The registration request already asks for auto-renew; this only double-checks it.
    logger.warn("auto-renew not confirmed", { domain, err: String(err) });
  }
  const zoneId = await ensureZone(domain);
  await userRef(uid).set({
    domain: { state: "registered", registeredAt: FieldValue.serverTimestamp(), autoRenew, zoneId, error: null },
  }, { merge: true });
  return Boolean(zoneId);
}

/** Moves the domain toward "registered". Returns true when it's registered with a zone. */
async function ensureDomain(uid, u, { approveDomain = false } = {}) {
  const d = u.domain || {};
  if (!d.name) throw new Step("Pick a domain name.", "needs_domain");
  // A preview claimed with the shared passcode instead of its personal link waits until Web
  // Burrito has checked it's the owner (admin: "Approve and launch") before a domain is bought.
  if (u.claim?.verified === false && d.state !== "registered" && !approveDomain) {
    throw new Step("Your domain will be registered after a quick check by Web Burrito (usually within a day).", "needs_attention");
  }
  if (!isLive()) {
    if (d.state !== "registered") await userRef(uid).set({ domain: { state: "registered", test: true, zoneId: null, autoRenew: false, error: null } }, { merge: true });
    return true;
  }
  if (d.state === "unavailable" || d.state === "failed") throw new Step(d.error || `${d.name} can't be registered. Pick another name.`, "needs_domain");
  // A domain is only ever used for the customer it's reserved for (reserve it now if nobody has).
  const mine = await db().runTransaction(async (tx) => {
    const ref = domainIndex(d.name);
    const idx = (await tx.get(ref)).data();
    if (idx && idx.uid !== uid) return false;
    if (!idx) tx.set(ref, { uid, at: FieldValue.serverTimestamp() });
    return true;
  });
  if (!mine) {
    const msg = `${d.name} can't be used. Pick another name.`;
    await userRef(uid).set({ domain: { state: "failed", error: msg } }, { merge: true });
    throw new Step(msg, "needs_domain");
  }
  if (d.state === "registered") return d.zoneId ? true : Boolean(await finishDomain(uid, d.name));

  // Already registered for this customer (a run that timed out, or coming back after a cancel)?
  if (await getRegistration(d.name)) return finishDomain(uid, d.name);

  if (d.state === "pending") {
    const st = await registrationStatus(d.name);
    const age = Date.now() - ms(d.pendingAt);
    if (st?.state === "succeeded") return finishDomain(uid, d.name);
    if (st?.state === "failed" || st?.state === "blocked") {
      const msg = `${d.name} couldn't be registered (${st?.error?.message || st.state}). Pick another name.`;
      await userRef(uid).set({ domain: { state: "failed", error: msg } }, { merge: true });
      throw new Step(msg, "needs_domain");
    }
    if (st?.state === "action_required") {
      // Cloudflare is waiting on someone (often the registrant confirming their email): keep checking.
      const what = st?.error?.message || st?.context?.action || "a confirmation step";
      await userRef(uid).set({ domain: { error: `Cloudflare is waiting for: ${what}. Check the domain owner's email.` } }, { merge: true });
      if (age > 3 * 86400e3) throw new Step(`Registering ${d.name} is waiting for: ${what}. Web Burrito has been told.`, "needs_attention");
      return false;
    }
    if (!st && age > 5 * 60e3) {
      // No registration was ever started (the request never reached Cloudflare): try again below.
      await userRef(uid).set({ domain: { state: "chosen", pendingAt: null } }, { merge: true });
    } else {
      if (age > 86400e3) throw new Step(`Registering ${d.name} is taking longer than it should. Web Burrito has been told.`, "needs_attention");
      if (age > 30 * 60e3) await userRef(uid).set({ domain: { error: "Registration is taking longer than usual. It will go live on its own when it's done." } }, { merge: true });
      return false;
    }
  }

  // Not started yet: check it, respect the daily cap, then register.
  const check = await cf("POST", "/accounts/{account}/registrar/domain-check", { domains: [d.name] });
  const ok = domainBuyable(check.body?.result?.domains?.[0], MAX_DOMAIN_PRICE.value());
  if (!ok.ok) {
    const msg = `${d.name} can't be bought (${ok.why}). Pick another name.`;
    await userRef(uid).set({ domain: { state: "unavailable", error: msg } }, { merge: true });
    throw new Step(msg, "needs_domain");
  }
  if (!d.contact) throw new Step("The domain owner's details are missing.", "needs_attention");
  const usage = db().collection("usage").doc(dayKey());
  const allowed = await db().runTransaction(async (tx) => {
    const n = (await tx.get(usage)).get("domains") || 0;
    if (n >= MAX_DOMAINS_PER_DAY.value() && !approveDomain) return false;
    tx.set(usage, { domains: FieldValue.increment(1) }, { merge: true });
    return true;
  });
  if (!allowed) throw new Step("Your domain will be registered after a quick check by Web Burrito (usually within a day).", "needs_attention");

  let r;
  try {
    r = await cf("POST", "/accounts/{account}/registrar/registrations",
      { domain_name: d.name, auto_renew: true, contacts: { registrant: registrantFor(d.contact) } }, { timeoutMs: 40_000 });
  } catch (err) {
    if (err instanceof ApiError && err.status === 429) return false; // busy: try again next run
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) throw err; // our setup, not their name: Web Burrito sees it
    if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
      const msg = `${d.name} couldn't be registered (${err.detail}). Pick another name.`;
      await userRef(uid).set({ domain: { state: "failed", error: msg } }, { merge: true });
      throw new Step(msg, "needs_domain");
    }
    // No answer: it may or may not have gone through. The next run checks before trying again.
    await userRef(uid).set({ domain: { state: "pending", pendingAt: FieldValue.serverTimestamp(), cost: ok.cost } }, { merge: true });
    logger.warn("domain registration unclear", { uid, domain: d.name, err: String(err) });
    return false;
  }
  logger.info("domain registration started", { uid, domain: d.name, status: r.status });
  if (r.status === 201) return finishDomain(uid, d.name);
  await userRef(uid).set({ domain: { state: "pending", pendingAt: FieldValue.serverTimestamp(), cost: ok.cost } }, { merge: true });
  return false;
}

/** Points the domain (and www) at the sites Worker. Safe to repeat. */
async function ensureHostnames(uid, u) {
  const { name, zoneId } = u.domain || {};
  if (!name || !zoneId || u.domain.attached || u.domain.test) return;
  for (const hostname of [name, `www.${name}`]) {
    await cf("PUT", "/accounts/{account}/workers/domains",
      { environment: "production", hostname, service: SITES_WORKER_NAME.value(), zone_id: zoneId });
  }
  await userRef(uid).set({ domain: { attached: true } }, { merge: true });
}

// ---------- publishing ----------
async function kvPut(domain, record) {
  const ns = (await configRef().get()).get("kvNamespaceId");
  if (!ns) throw new Step("Site hosting isn't set up yet. Web Burrito has been told.", "needs_attention");
  const key = `${isLive() ? "site" : "test"}:${domain}`; // test-mode pages are never served
  await cf("PUT", `/accounts/{account}/storage/kv/namespaces/${ns}/values/${encodeURIComponent(key)}`,
    JSON.stringify(record), { raw: true, headers: { "Content-Type": "text/plain" } });
}

const OFFLINE_WHY = {
  unpaid: "Your site is offline because a payment didn't go through. Pay the invoice Square emailed you to bring it back.",
  refunded: "Your site is offline because the payment was refunded.",
  disputed: "Your site is offline because the payment is disputed. Contact Web Burrito.",
  admin: "Your site was taken offline by Web Burrito. Contact us to bring it back.",
};

/**
 * Checks the draft and, if it passes, makes it the live site. Returns { ok, reasons }.
 * A draft that already passed (same content) isn't checked again. Call it under the lease.
 */
export async function publishDraft(uid) {
  let u = (await userRef(uid).get()).data() || {};
  if (u.live?.suspended) throw new Step(OFFLINE_WHY[u.live.suspended] || OFFLINE_WHY.admin, "suspended");
  if (!isPaid(u)) throw new Step("Your site goes live after your first payment.", "no_plan");
  const draft = (await draftRef(uid).get()).data();
  if (!draft?.html) throw new Step("There's no site to publish yet.", "needs_changes");
  const html = sanitizeHtml(draft.html);
  if (!pageFits(html) || html.length > 150_000) throw new Step("The page is too big to publish. Ask for a simpler page, or undo the last change.", "needs_changes");
  const hash = pageHash(html);
  // The check covers the page and the business details shown to Google with it (name, phone,
  // address): change either and it's checked again.
  const p = u.profile || {};
  const key = pageHash(`${hash}|${p.business || ""}|${p.phone || ""}|${p.address || ""}|${p.city || ""}|${u.domain?.name || ""}`);
  let review = u.review?.key === key ? u.review : null;
  // The exact page Web Burrito made from a preview: review quotes from its listings are allowed.
  const madeByWebBurrito = (u.trustedHashes || []).includes(hash);
  if (!review) {
    // Each check counts toward the plan's monthly allowance (with some room for re-checks).
    const month = monthKey();
    const limit = (PLANS[u.plan.id]?.editsPerMonth || 20) + 10;
    const used = u.reviews?.month === month ? u.reviews.count || 0 : 0;
    if (used >= limit) throw new Step(`You've used this month's site checks. Text (310) 279-8278 for more.`, "needs_changes");
    await setLaunch(uid, "checking");
    const r = await reviewSite({ profile: u.profile || {}, html, domain: u.domain?.name || "", madeByWebBurrito, listingLines: u.claim?.listingLines || [] });
    if (r.transient) {
      // The checker's answer couldn't be read. Try a few more times, then ask Web Burrito. Those
      // calls are paid too, so there's also a monthly limit that a new page or profile can't reset.
      const tries = (u.reviewRetry?.hash === key ? u.reviewRetry.n || 0 : 0) + 1;
      const failed = (u.reviews?.month === month ? u.reviews.failed || 0 : 0) + 1;
      const fresh = u.reviews?.month === month ? {} : { count: 0 }; // a new month starts both counts at 0
      await userRef(uid).set({ reviewRetry: { hash: key, n: tries }, reviews: { month, failed, ...fresh } }, { merge: true });
      if (tries >= 5 || failed >= 15) throw new Step("The site check isn't finishing. Web Burrito has been told and will look at it.", "needs_attention");
      throw new Step("The site check didn't finish. It will try again in a minute.", "checking");
    }
    review = { hash, key, ok: r.ok, reasons: r.reasons, at: new Date() };
    const fresh = u.reviews?.month === month ? {} : { failed: 0 }; // a new month starts both counts at 0
    await userRef(uid).set({ review, reviews: { month, count: used + 1, ...fresh } }, { merge: true });
  }
  if (!review.ok) {
    await setLaunch(uid, "needs_changes", { reasons: review.reasons });
    return { ok: false, reasons: review.reasons };
  }
  await setLaunch(uid, "publishing");
  u = (await userRef(uid).get()).data() || {};
  if (u.live?.suspended || !isPaid(u)) throw new Step(OFFLINE_WHY[u.live?.suspended] || "Your plan isn't active.", "suspended");
  const served = servedPage(html, p, `https://${u.domain.name}/`); // the details that were checked
  await kvPut(u.domain.name, { state: "live", html: served, business: u.profile?.business || "", at: Date.now() });
  // If it was taken offline (or the plan ended) while we were publishing, put the offline page back.
  const after = (await userRef(uid).get()).data() || {};
  if (after.live?.suspended || !isPaid(after)) {
    await kvPut(u.domain.name, { state: "offline", business: u.profile?.business || "", at: Date.now() });
    throw new Step(OFFLINE_WHY[after.live?.suspended] || "Your plan isn't active.", "suspended");
  }
  await liveRef(uid).set({ html, hash, publishedAt: FieldValue.serverTimestamp() });
  await userRef(uid).set({ live: { hash, url: isLive() ? `https://${u.domain.name}/` : null, test: !isLive(), publishedAt: FieldValue.serverTimestamp(), state: "live" } }, { merge: true });
  return { ok: true, reasons: [] };
}

/**
 * Takes the site offline. With `suspend` (unpaid, refunded, disputed, admin) it stays offline
 * until that's cleared; without it (plan ended) it just goes offline.
 */
export async function takeOffline(uid, why, { suspend = null } = {}) {
  // Mark it first, so a publish already running sees it and backs off.
  await userRef(uid).set({ live: { ...(suspend ? { suspended: suspend } : {}), offlineReason: why } }, { merge: true });
  let token = null;
  for (let i = 0; i < 3 && !token; i++) {
    token = await acquire(uid, 120);
    if (!token) await new Promise((r) => setTimeout(r, 1500));
  }
  try {
    await offlineLocked(uid, why, suspend);
  } finally {
    if (token) await release(uid, token);
  }
}
async function offlineLocked(uid, why, suspend) {
  const u = (await userRef(uid).get()).data() || {};
  if (u.domain?.name) {
    await kvPut(u.domain.name, { state: "offline", business: u.profile?.business || "", at: Date.now() }).catch((err) => {
      if (!(err instanceof Step)) throw err; // hosting not set up: nothing is online anyway
    });
  }
  if (ENDED_STATUSES.includes(u.plan?.status) && u.domain?.state === "registered" && u.domain?.autoRenew && !u.domain?.test) {
    try {
      await cf("PUT", `/accounts/{account}/registrar/domains/${u.domain.name}`, { auto_renew: false });
      await userRef(uid).set({ domain: { autoRenew: false } }, { merge: true });
    } catch (err) {
      logger.warn("auto-renew not turned off", { uid, err: String(err) });
    }
  }
  if (u.live?.state === "live") {
    await userRef(uid).set({ live: { state: "offline", offlineAt: FieldValue.serverTimestamp() } }, { merge: true });
  }
  logger.info("site offline", { uid, why, suspend });
}

/** Lifts a suspension (admin "Put back online", or a payment for "unpaid") and re-queues. */
export async function restore(uid) {
  await userRef(uid).set({ live: { suspended: null }, launch: { queued: true, nextAt: new Date() } }, { merge: true });
}

/**
 * Moves a paid customer's launch forward as far as it can go right now.
 * Returns the launch state ("live", "waiting_payment", "domain_pending", ...) or "busy".
 */
export async function advance(uid, reason, opts = {}) {
  const r = await withLease(uid, () => advanceLocked(uid, reason, opts));
  return r;
}

async function advanceLocked(uid, reason, opts) {
  let attempts = 0;
  try {
    let u = (await userRef(uid).get()).data() || {};
    attempts = u.launch?.attempts || 0;
    const plan = currentPlan(u);
    if (!plan?.subscriptionId) {
      await setLaunch(uid, "no_plan");
      return "no_plan";
    }
    if (u.live?.suspended) {
      await setLaunch(uid, "suspended", { error: OFFLINE_WHY[u.live.suspended] || OFFLINE_WHY.admin });
      return "suspended";
    }
    if (ENDED_STATUSES.includes(plan.status) || plan.status === "paused") {
      await userRef(uid).set({ launch: { queued: false, nextAt: null } }, { merge: true });
      return plan.status;
    }
    if (!plan.paid) {
      const inv = await paidInvoice(plan.subscriptionId, plan.customerId);
      if (!inv) {
        if (plan.firstChargeFailedAt) {
          // Look again every half hour for a week, in case the webhook for a late payment is missed.
          const recent = Date.now() - ms(plan.firstChargeFailedAt) < 7 * 86400e3;
          await setLaunch(uid, "payment_failed", { queued: recent, delayMs: 30 * step(), error: "Your card was declined. Pay the invoice Square emailed you, or change your card below and text (310) 279-8278." });
          return "payment_failed";
        }
        // Keep checking for two days, then leave it to the webhook.
        const waiting = Date.now() - ms(plan.startedAt || plan.startingAt) < 2 * 86400e3;
        await setLaunch(uid, "waiting_payment", { queued: waiting });
        return "waiting_payment";
      }
      await markPaid(uid, plan.subscriptionId, inv.id);
      u = (await userRef(uid).get()).data() || {};
    }
    if (!PAID_STATUSES.includes(u.plan.status)) return u.plan.status;

    await setLaunch(uid, "domain");
    if (!(await ensureDomain(uid, u, opts))) {
      await setLaunch(uid, "domain_pending");
      return "domain_pending";
    }
    u = (await userRef(uid).get()).data() || {};
    if (u.live?.state !== "live") {
      const r = await publishDraft(uid);
      if (!r.ok) return "needs_changes";
      u = (await userRef(uid).get()).data() || {};
    }
    await ensureHostnames(uid, u);
    await setLaunch(uid, "live", { reasons: [], attempts: 0 });
    logger.info("launch advanced", { uid, reason, state: "live" });
    return "live";
  } catch (err) {
    const state = err instanceof Step ? err.state : "needs_attention";
    const message = err instanceof Step ? err.message : "Something went wrong while setting up your site. Web Burrito has been told and will fix it.";
    if (!(err instanceof Step)) logger.error("launch failed", { uid, reason, err: String(err) });
    // Unexpected errors are retried with growing gaps (1, 2, 4 ... 60 minutes); the admin sees them.
    const retry = err instanceof Step ? {} : { queued: true, attempts: attempts + 1, delayMs: Math.min(2 ** attempts, 60) * step() };
    await setLaunch(uid, state, { error: message, detail: err instanceof Step ? null : String(err).slice(0, 300), ...retry });
    return state;
  }
}

// ---------- the every-minute job ----------
/** Finds checkouts whose subscription call got no clear answer, and settles them. */
export async function reconcileCheckout(uid) {
  return withLease(uid, async () => {
    const u = (await userRef(uid).get()).data() || {};
    const plan = currentPlan(u);
    if (plan?.status !== "starting") return "nothing";
    const age = Date.now() - ms(plan.startingAt);
    if (plan.subAttemptAt && plan.customerId) {
      const found = await square("POST", "/v2/subscriptions/search", {
        query: { filter: { customer_ids: [plan.customerId], location_ids: [SQUARE_LOCATION_ID.value()] } },
      });
      // Only the one this checkout made: same card, same plan, created after the attempt began.
      const since = ms(plan.subAttemptAt) - 120e3;
      const sub = (found.subscriptions || []).find((s) => s.card_id === plan.cardId && s.plan_variation_id === plan.variationId
        && Date.parse(s.created_at || 0) >= since && ["ACTIVE", "PENDING"].includes(s.status));
      if (sub) {
        await adoptSubscription(uid, sub.id);
        return "adopted";
      }
    }
    // Never reached the subscription step (the request died first): nothing to find after 5 minutes.
    // Otherwise give Square 15 minutes to show the subscription before starting over.
    if (age > (plan.subAttemptAt ? 15 : 5) * 60e3) {
      await resetCheckout(uid, u.domain?.name);
      return "reset";
    }
    return "waiting";
  });
}

/** Saves a subscription as the customer's current one. */
export async function adoptSubscription(uid, subscriptionId) {
  const batch = db().batch();
  batch.set(db().collection("subIndex").doc(subscriptionId), { uid, env: env() });
  batch.set(userRef(uid), {
    plan: { status: "pending_payment", subscriptionId, paid: false, payingUntil: null, startedAt: FieldValue.serverTimestamp() },
    launch: { state: "waiting_payment", queued: true, nextAt: new Date(), error: null },
  }, { merge: true });
  await batch.commit();
}

/** Undoes a checkout that never reached Square (or definitely failed there). */
export async function resetCheckout(uid, domain) {
  await userRef(uid).set({ plan: { status: null, checkoutId: null, subAttemptAt: null, payingUntil: null } }, { merge: true });
  if (domain) {
    const owner = (await domainIndex(domain).get()).data();
    // A name that was ever registered for this customer stays theirs.
    if (owner?.uid === uid && !owner.registered) await domainIndex(domain).delete();
  }
}

/** Every minute: move queued launches forward, settle unclear checkouts, enforce unpaid grace. */
export async function tick({ budgetMs = 420_000 } = {}) {
  const end = Date.now() + budgetMs;
  const out = { advanced: 0, reconciled: 0, offline: 0, errors: 0 };
  const each = async (docs, fn) => {
    for (const d of docs) {
      if (Date.now() > end) return;
      try {
        await fn(d);
      } catch (err) {
        out.errors += 1;
        logger.error("launcher step failed", { uid: d.id, err: String(err) });
      }
    }
  };
  try {
    await autoSetup(out);
  } catch (err) {
    out.errors += 1;
    logger.error("auto setup failed", { err: String(err) }); // never stops the launches below
  }
  const due = await db().collection("users").where("launch.nextAt", "<=", new Date()).orderBy("launch.nextAt").limit(25).get();
  await each(due.docs, async (d) => {
    if (ms(d.get("lease.until")) > Date.now()) return;
    await advance(d.id, "job");
    out.advanced += 1;
  });
  const starting = await db().collection("users").where("plan.status", "==", "starting").limit(25).get();
  await each(starting.docs, async (d) => {
    await reconcileCheckout(d.id);
    out.reconciled += 1;
  });
  const cutoff = Date.now() - PAST_DUE_GRACE_DAYS.value() * 86400e3;
  const late = await db().collection("users").where("plan.status", "==", "past_due").limit(100).get();
  await each(late.docs, async (d) => {
    if (ms(d.get("plan.pastDueSince")) < cutoff && !d.get("live.suspended")) {
      await takeOffline(d.id, "unpaid", { suspend: "unpaid" });
      out.offline += 1;
    }
  });
  return out;
}

// ---------- one-time setup (runs by itself from the launcher; also buttons on /admin/) ----------
const WORKER_SOURCE = readFileSync(new URL("./sites-worker.js", import.meta.url), "utf8");
const WORKER_HASH = pageHash(WORKER_SOURCE);

/**
 * Creates or finishes the one-time setup that's missing (Square plans for this environment, the
 * sites Worker), and re-uploads the Worker when its code changed. At most one run every 10
 * minutes, claimed in a transaction so two runs never overlap.
 */
async function autoSetup(out) {
  const cfg = (await configRef().get()).data() || {};
  const needPlans = !cfg.plans?.[env()];
  const needHosting = Boolean(CLOUDFLARE_ACCOUNT_ID.value()) && (!cfg.workerReady || cfg.workerHash !== WORKER_HASH);
  if (!needPlans && !needHosting) return;
  const mine = await db().runTransaction(async (tx) => {
    const now = (await tx.get(configRef())).data() || {};
    if (Date.now() - ms(now.autoSetupAt) < 10 * 60e3) return false;
    tx.set(configRef(), { autoSetupAt: new Date() }, { merge: true });
    return true;
  });
  if (!mine) return;
  for (const [need, run, name] of [[needPlans, setupSquarePlans, "square plans"], [needHosting, setupHosting, "site hosting"]]) {
    if (!need) continue;
    try {
      await run();
      logger.info("set up by itself", { what: name });
    } catch (err) {
      out.errors += 1;
      // New Square keys only after Square refused (4xx); after a timeout the same keys find the
      // plans it may already have made, instead of making a second set.
      const refused = err instanceof ApiError && err.status >= 400 && err.status < 500;
      await configRef().set({ autoSetupError: `${name}: ${String(err).slice(0, 300)}`, ...(name === "square plans" && refused ? { setupAttempt: FieldValue.increment(1) } : {}) }, { merge: true });
      logger.error("setup failed", { what: name, err: String(err) });
    }
  }
}

/** The six Square plan variations (3 plans x monthly/yearly) for the current environment. */
export async function setupSquarePlans() {
  const cfg = (await configRef().get()).data() || {};
  if (cfg.plans?.[env()]) return { plans: cfg.plans[env()], note: "Already set up." };
  // Fixed keys per environment and attempt: a retry after a lost answer gets the same objects back
  // (no duplicates); after a real failure the next attempt uses new keys.
  const attempt = cfg.setupAttempt || 0;
  const planObjects = Object.entries(PLANS).map(([key, p]) => ({
    type: "SUBSCRIPTION_PLAN", id: `#plan_${key}`, subscription_plan_data: { name: `Web Burrito site: ${p.name}` },
  }));
  const made = await square("POST", "/v2/catalog/batch-upsert", { idempotency_key: `wb-plans-${env()}-${attempt}`, batches: [{ objects: planObjects }] });
  const planId = Object.fromEntries((made.id_mappings || []).map((m) => [m.client_object_id, m.object_id]));
  const variations = Object.entries(PLANS).flatMap(([key, p]) => BILLING.map((b) => ({
    type: "SUBSCRIPTION_PLAN_VARIATION",
    id: `#${key}_${b}`,
    subscription_plan_variation_data: {
      name: `${p.name}, ${b}`,
      subscription_plan_id: planId[`#plan_${key}`],
      phases: [{ cadence: b === "monthly" ? "MONTHLY" : "ANNUAL", ordinal: 0, pricing: { type: "STATIC", price_money: { amount: p[b], currency: "USD" } } }],
    },
  })));
  const made2 = await square("POST", "/v2/catalog/batch-upsert", { idempotency_key: `wb-vars-${env()}-${attempt}`, batches: [{ objects: variations }] });
  const varId = Object.fromEntries((made2.id_mappings || []).map((m) => [m.client_object_id, m.object_id]));
  const plans = Object.fromEntries(Object.keys(PLANS).map((k) => [k, { monthly: varId[`#${k}_monthly`], yearly: varId[`#${k}_yearly`] }]));
  if (Object.values(plans).some((p) => !p.monthly || !p.yearly)) throw new Error("Square didn't return all plan ids");
  await configRef().set({ plans: { [env()]: plans }, plansAt: FieldValue.serverTimestamp(), autoSetupError: null }, { merge: true });
  return { plans };
}

// ---------- one-time hosting setup ----------
export async function setupHosting() {
  const cfg = configRef();
  let ns = (await cfg.get()).get("kvNamespaceId");
  if (!ns) {
    const list = await cf("GET", "/accounts/{account}/storage/kv/namespaces?per_page=100");
    ns = (list.body?.result || []).find((n) => n.title === "webburrito-sites")?.id;
    if (!ns) ns = (await cf("POST", "/accounts/{account}/storage/kv/namespaces", { title: "webburrito-sites" })).body?.result?.id;
    if (!ns) throw new Error("Couldn't create the KV namespace");
  }
  const source = WORKER_SOURCE;
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify({
    main_module: "worker.js",
    compatibility_date: "2025-01-01",
    bindings: [{ type: "kv_namespace", name: "SITES", namespace_id: ns }],
  })], { type: "application/json" }));
  form.append("worker.js", new Blob([source], { type: "application/javascript+module" }), "worker.js");
  await cf("PUT", `/accounts/{account}/workers/scripts/${SITES_WORKER_NAME.value()}`, form, { raw: true, timeoutMs: 60_000 });
  await cfg.set({ kvNamespaceId: ns, workerReady: true, workerHash: WORKER_HASH, workerUploadedAt: FieldValue.serverTimestamp(), autoSetupError: null }, { merge: true });
  return { kvNamespaceId: ns };
}
