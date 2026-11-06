// Getting a paid customer's site online: buy the domain, check the site, publish it, and
// point the domain at it. Every step is safe to run again, and a lease on the customer's
// record stops two requests (say the Square webhook and the dashboard) from running it at once.

import { readFileSync } from "node:fs";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { cf, square } from "./clients.js";
import { reviewSite } from "./ai.js";
import { domainBuyable, registrantFor, pageHash } from "./pure.js";
import { MAX_DOMAIN_PRICE, SITES_WORKER_NAME, SQUARE_LOCATION_ID, isLive } from "./config.js";

const db = () => getFirestore();
export const userRef = (uid) => db().collection("users").doc(uid);
export const draftRef = (uid) => userRef(uid).collection("site").doc("draft");
export const liveRef = (uid) => userRef(uid).collection("site").doc("live");
export const configRef = () => db().collection("config").doc("platform");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- lease ----------
async function acquire(uid, seconds = 240) {
  const ref = userRef(uid);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const until = snap.get("launch.lockUntil")?.toMillis?.() || 0;
    if (until > Date.now()) return false;
    tx.set(ref, { launch: { lockUntil: new Date(Date.now() + seconds * 1000) } }, { merge: true });
    return true;
  });
}
const release = (uid) => userRef(uid).set({ launch: { lockUntil: null } }, { merge: true });

/** Runs fn while holding the customer's lease; returns "busy" if someone else holds it. */
export async function withLease(uid, fn) {
  if (!(await acquire(uid))) return "busy";
  try {
    return await fn();
  } finally {
    await release(uid);
  }
}

async function setLaunch(uid, state, extra = {}) {
  await userRef(uid).set({ launch: { state, at: FieldValue.serverTimestamp(), error: null, ...extra } }, { merge: true });
}

// ---------- payment ----------
/** Looks up the subscription's first invoice. Returns the invoice if it's paid, else null. */
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
  for (const id of ids) {
    const inv = (await square("GET", `/v2/invoices/${encodeURIComponent(id)}`)).invoice;
    if (inv?.status === "PAID") return inv;
  }
  return null;
}

export async function markPaid(uid, invoiceId) {
  await userRef(uid).set({
    plan: { status: "active", paid: true, paidAt: FieldValue.serverTimestamp(), lastInvoiceId: invoiceId || null, pastDueSince: null },
  }, { merge: true });
}

// ---------- domain ----------
async function registrationState(domain) {
  const r = await cf("GET", `/accounts/{account}/registrar/registrations/${domain}/registration-status`, null, { allow: [404] });
  if (r.status === 404) return null;
  return r.body?.result || null;
}

async function finishDomain(uid, domain) {
  // Turn on auto-renew (off by default for API registrations) and find the new zone.
  let autoRenew = false;
  try {
    await cf("PUT", `/accounts/{account}/registrar/domains/${domain}`, { auto_renew: true, locked: true });
    autoRenew = true;
  } catch (err) {
    logger.warn("auto-renew not set", { domain, err: String(err) });
  }
  let zoneId = null;
  for (let i = 0; i < 6 && !zoneId; i++) {
    const z = await cf("GET", `/zones?name=${encodeURIComponent(domain)}&account.id={account}`);
    zoneId = z.body?.result?.[0]?.id || null;
    if (!zoneId) await sleep(3000);
  }
  await userRef(uid).set({
    domain: { state: "registered", registeredAt: FieldValue.serverTimestamp(), autoRenew, zoneId, error: null },
  }, { merge: true });
  return zoneId;
}

/** Makes sure the customer's domain is registered. Returns true when it is. */
async function ensureDomain(uid, u) {
  const d = u.domain || {};
  if (!d.name) throw new Step("Pick a domain name first.");
  if (!isLive()) {
    // Test mode: pretend the domain was bought.
    if (d.state !== "registered") await userRef(uid).set({ domain: { state: "registered", test: true, zoneId: null, autoRenew: false, error: null } }, { merge: true });
    return true;
  }
  if (d.state === "registered" && d.zoneId) return true;
  if (d.state === "registered") return Boolean(await finishDomain(uid, d.name));

  // Already started (here or in an earlier request): follow it to the end.
  let status = await registrationState(d.name);
  if (!status && d.state !== "pending") {
    const check = await cf("POST", "/accounts/{account}/registrar/domain-check", { domains: [d.name] });
    const entry = check.body?.result?.domains?.[0];
    const ok = domainBuyable(entry, MAX_DOMAIN_PRICE.value());
    if (!ok.ok) {
      await userRef(uid).set({ domain: { state: "unavailable", error: `${d.name} can't be bought (${ok.why}). Pick another name.` } }, { merge: true });
      throw new Step(`${d.name} can't be bought anymore (${ok.why}). Pick another name.`, "needs_domain");
    }
    if (!d.contact) throw new Step("The domain owner's contact details are missing.", "needs_domain");
    await userRef(uid).set({ domain: { state: "pending", requestedAt: FieldValue.serverTimestamp(), cost: ok.cost } }, { merge: true });
    const r = await cf("POST", "/accounts/{account}/registrar/registrations",
      { domain_name: d.name, contacts: { registrant: registrantFor(d.contact) } }, { timeoutMs: 40_000 });
    logger.info("domain registration started", { uid, domain: d.name, status: r.status });
    if (r.status === 201) return Boolean(await finishDomain(uid, d.name));
    status = await registrationState(d.name);
  }
  for (let i = 0; i < 8; i++) {
    if (status?.state === "succeeded" || status?.completed && !status?.error) return Boolean(await finishDomain(uid, d.name));
    if (status?.state === "failed" || status?.state === "blocked" || status?.state === "action_required") {
      const msg = status?.error?.message || status.state;
      await userRef(uid).set({ domain: { state: "failed", error: msg } }, { merge: true });
      throw new Step(`The domain registration didn't go through (${msg}). Web Burrito has been told.`, "needs_attention");
    }
    await sleep(5000);
    status = await registrationState(d.name);
  }
  return false; // still in progress; the next check picks it up
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

/**
 * Checks the draft and, if it passes, makes it the live site. Returns { ok, reasons }.
 * A draft that already passed (same content) isn't checked again.
 */
export async function publishDraft(uid, u) {
  const draft = (await draftRef(uid).get()).data();
  if (!draft?.html) throw new Step("There's no site to publish yet.");
  const hash = draft.hash || pageHash(draft.html);
  let review = u.review?.hash === hash ? u.review : null;
  if (!review) {
    await setLaunch(uid, "checking");
    const r = await reviewSite({ profile: u.profile || {}, html: draft.html });
    review = { hash, ok: r.ok, reasons: r.reasons, at: new Date() };
    await userRef(uid).set({ review }, { merge: true });
  }
  if (!review.ok) {
    await setLaunch(uid, "needs_changes", { reasons: review.reasons });
    return { ok: false, reasons: review.reasons };
  }
  await setLaunch(uid, "publishing");
  await kvPut(u.domain.name, { state: "live", html: draft.html, business: u.profile?.business || "", at: Date.now() });
  await liveRef(uid).set({ html: draft.html, hash, publishedAt: FieldValue.serverTimestamp() });
  await userRef(uid).set({ live: { hash, url: isLive() ? `https://${u.domain.name}/` : null, test: !isLive(), publishedAt: FieldValue.serverTimestamp(), state: "live" } }, { merge: true });
  return { ok: true, reasons: [] };
}

export async function takeOffline(uid, why) {
  const u = (await userRef(uid).get()).data() || {};
  if (u.domain?.name && u.live?.state === "live") {
    await kvPut(u.domain.name, { state: "offline", business: u.profile?.business || "", at: Date.now() });
  }
  if (u.domain?.state === "registered" && u.domain?.autoRenew && !u.domain?.test) {
    try {
      await cf("PUT", `/accounts/{account}/registrar/domains/${u.domain.name}`, { auto_renew: false });
      await userRef(uid).set({ domain: { autoRenew: false } }, { merge: true });
    } catch (err) {
      logger.warn("auto-renew not turned off", { uid, err: String(err) });
    }
  }
  await userRef(uid).set({ live: { state: "offline", offlineReason: why, offlineAt: FieldValue.serverTimestamp() } }, { merge: true });
  logger.info("site offline", { uid, why });
}

/** A problem that stops the launch; `state` is what the customer's page shows. */
export class Step extends Error {
  constructor(message, state = "needs_attention") {
    super(message);
    this.state = state;
  }
}

/**
 * Moves a paid customer's launch forward as far as it can go right now.
 * Returns the launch state ("live", "waiting_payment", "domain_pending", ...) or "busy".
 */
export async function advance(uid, reason) {
  if (!(await acquire(uid))) return "busy";
  try {
    let u = (await userRef(uid).get()).data() || {};
    if (!u.plan?.subscriptionId) return "no_plan";
    if (!u.plan.paid) {
      const inv = await paidInvoice(u.plan.subscriptionId, u.plan.customerId);
      if (!inv) {
        await setLaunch(uid, "waiting_payment");
        return "waiting_payment";
      }
      await markPaid(uid, inv.id);
      u = (await userRef(uid).get()).data();
    }
    if (u.plan.status !== "active") return u.launch?.state || u.plan.status;

    await setLaunch(uid, "domain");
    if (!(await ensureDomain(uid, u))) {
      await setLaunch(uid, "domain_pending");
      return "domain_pending";
    }
    u = (await userRef(uid).get()).data();
    if (u.live?.state !== "live") {
      const r = await publishDraft(uid, u);
      if (!r.ok) return "needs_changes";
      u = (await userRef(uid).get()).data();
    }
    await ensureHostnames(uid, u);
    await setLaunch(uid, "live", { reasons: [] });
    logger.info("launch advanced", { uid, reason, state: "live" });
    return "live";
  } catch (err) {
    const state = err instanceof Step ? err.state : "needs_attention";
    const message = err instanceof Step ? err.message : "Something went wrong while setting up your site. Web Burrito has been told and will fix it.";
    logger.error("launch failed", { uid, reason, err: String(err) });
    await setLaunch(uid, state, { error: message, detail: err instanceof Step ? null : String(err).slice(0, 300) });
    return state;
  } finally {
    await release(uid);
  }
}

// ---------- one-time hosting setup (admin) ----------
export async function setupHosting() {
  const cfg = configRef();
  let ns = (await cfg.get()).get("kvNamespaceId");
  if (!ns) {
    const list = await cf("GET", "/accounts/{account}/storage/kv/namespaces?per_page=100");
    ns = (list.body?.result || []).find((n) => n.title === "webburrito-sites")?.id;
    if (!ns) ns = (await cf("POST", "/accounts/{account}/storage/kv/namespaces", { title: "webburrito-sites" })).body?.result?.id;
    if (!ns) throw new Error("Couldn't create the KV namespace");
  }
  const source = readFileSync(new URL("./sites-worker.js", import.meta.url), "utf8");
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify({
    main_module: "worker.js",
    compatibility_date: "2025-01-01",
    bindings: [{ type: "kv_namespace", name: "SITES", namespace_id: ns }],
  })], { type: "application/json" }));
  form.append("worker.js", new Blob([source], { type: "application/javascript+module" }), "worker.js");
  await cf("PUT", `/accounts/{account}/workers/scripts/${SITES_WORKER_NAME.value()}`, form, { raw: true, timeoutMs: 60_000 });
  await cfg.set({ kvNamespaceId: ns, workerReady: true, workerUploadedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { kvNamespaceId: ns };
}
