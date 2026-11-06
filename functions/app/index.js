// The customer platform API, served at https://webburrito.com/api/app/* (rewrite in firebase.json).
//
//   GET  /config            public settings for the customer page (Square app id, prices, free tries)
//   POST /profile           save business details
//   POST /claim             start from a Web Burrito preview (the page decrypts it with the passcode)
//   POST /build             AI builds or edits the draft (3 free tries, then a monthly allowance by plan)
//   POST /undo              go back to the draft before the last change
//   POST /domain-check      is a domain free, and its price
//   POST /subscribe         card + plan + domain: starts the Square subscription and the launch
//   POST /status            moves the launch forward (payment -> domain -> check -> live)
//   POST /publish           check the draft and make it the live site
//   POST /email             forwarding addresses (Super and Loaded plans)
//   POST /card              replace the card on file
//   POST /cancel            cancel at the end of the paid period
//   POST /square-webhook    Square events (signed)
//   POST /admin/*           setup-square, setup-hosting, retry, offline, sweep (admins only)
//
// Every POST except the webhook needs a Firebase sign-in (ID token, verified email).

import { onRequest } from "firebase-functions/https";
import { logger } from "firebase-functions";
import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import {
  SECRETS, SQUARE_APPLICATION_ID, SQUARE_ENVIRONMENT, SQUARE_LOCATION_ID, SQUARE_WEBHOOK_SIGNATURE_KEY,
  SQUARE_WEBHOOK_URL, CLOUDFLARE_ACCOUNT_ID, FREE_BUILDS, FREE_BUILDS_PER_DAY_TOTAL, MAX_DOMAIN_PRICE, PAST_DUE_GRACE_DAYS, isLive,
} from "./config.js";
import {
  PLANS, BILLING, text, parseProfile, parseContact, parseDomain, domainBuyable, squareSignatureOk, cleanHtml,
  monthKey, dayKey, pageHash, parseForwards, registrarPhone,
} from "./pure.js";
import { square, cf, idem, ApiError } from "./clients.js";
import { buildSite } from "./ai.js";
import { advance, publishDraft, takeOffline, setupHosting, withLease, markPaid, userRef, draftRef, configRef, Step } from "./launch.js";

if (!getApps().length) initializeApp();
const db = getFirestore();

class UserError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (res, status, error) => res.status(status).json({ ok: false, error });

export const app = onRequest(
  { region: "us-central1", timeoutSeconds: 540, memory: "512MiB", secrets: SECRETS, invoker: "public", maxInstances: 5, concurrency: 20 },
  async (req, res) => {
    res.set("Cache-Control", "no-store");
    const path = req.path.replace(/^\/api\/app(?=\/)/, "");
    try {
      if (path === "/config" && req.method === "GET") return res.json(await publicConfig());
      if (path === "/square-webhook") return await squareWebhook(req, res);
      if (req.method !== "POST") return res.set("Allow", "POST").status(405).json({ ok: false });
      const body = readJson(req, path === "/claim" ? 700_000 : 20_000);
      if (!body) return fail(res, 400, "Bad request.");
      const user = await signedIn(req, body);
      if (!user) return fail(res, 401, "Please sign in again.");
      if (path.startsWith("/admin/")) {
        if (!user.admin) return fail(res, 403, "Admins only.");
        const route = ADMIN[path];
        return route ? await route(user, body, res) : fail(res, 404, "Not found.");
      }
      const route = ROUTES[path];
      if (!route) return fail(res, 404, "Not found.");
      await ensureUser(user);
      return await route(user, body, res);
    } catch (err) {
      if (err instanceof UserError) return fail(res, err.status, err.message);
      if (err instanceof Step) return fail(res, 409, err.message);
      logger.error("app failed", { path, err: String(err), detail: err instanceof ApiError ? err.detail : undefined });
      return fail(res, 500, "Something went wrong. Try again in a minute.");
    }
  },
);

function readJson(req, max) {
  const raw = req.rawBody;
  if (raw && raw.length > max) return null;
  try {
    if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
    return JSON.parse(raw ? raw.toString("utf8") : "");
  } catch {
    return null;
  }
}

async function signedIn(req, body) {
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.get("authorization") || "")?.[1];
  const token = bearer || (typeof body._auth === "string" ? body._auth : null);
  if (!token || token.length > 4096) return null;
  try {
    const t = await getAuth().verifyIdToken(token);
    const email = String(t.email || "").toLowerCase();
    if (!email || t.email_verified !== true) return null;
    const admin = (await db.collection("admins").doc(email).get()).exists;
    return { uid: t.uid, email, name: text(t.name || "", 80), admin };
  } catch {
    return null;
  }
}

async function ensureUser(user) {
  const ref = userRef(user.uid);
  const snap = await ref.get();
  if (!snap.exists) await ref.set({ email: user.email, name: user.name, createdAt: FieldValue.serverTimestamp() });
}
const getUser = async (uid) => (await userRef(uid).get()).data() || {};
const isPaid = (u) => ["active", "past_due", "canceling"].includes(u.plan?.status) && u.plan?.paid;

async function publicConfig() {
  const cfg = (await configRef().get()).data() || {};
  return {
    square: { applicationId: SQUARE_APPLICATION_ID.value(), locationId: SQUARE_LOCATION_ID.value(), environment: SQUARE_ENVIRONMENT.value() },
    plans: PLANS,
    freeBuilds: FREE_BUILDS.value(),
    testMode: !isLive(),
    ready: {
      payments: Boolean(cfg.plans?.[SQUARE_ENVIRONMENT.value()] && SQUARE_APPLICATION_ID.value()),
      hosting: Boolean(cfg.workerReady),
      domains: Boolean(CLOUDFLARE_ACCOUNT_ID.value()),
    },
  };
}

async function log(uid, role, msg, extra = {}) {
  await userRef(uid).collection("messages").add({ role, text: text(msg, 2000), at: FieldValue.serverTimestamp(), ...extra });
}

// ---------- customer routes ----------
const ROUTES = {
  async "/profile"(user, body, res) {
    const profile = parseProfile(body.profile);
    if (!profile) throw new UserError(400, "Add your business name.");
    await userRef(user.uid).set({ profile, profileAt: FieldValue.serverTimestamp() }, { merge: true });
    res.json({ ok: true });
  },

  async "/claim"(user, body, res) {
    const slug = text(body.slug, 80);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new UserError(400, "That preview link doesn't look right.");
    const html = cleanHtml(body.html);
    if (!html) throw new UserError(400, "Couldn't read that preview.");
    await saveDraft(user.uid, html, "preview");
    await userRef(user.uid).set({ claimedSlug: slug }, { merge: true });
    await log(user.uid, "builder", `Started from your preview (webburrito.com/${slug}).`);
    res.json({ ok: true });
  },

  async "/build"(user, body, res) {
    const request = text(body.request, 2000);
    const u = await getUser(user.uid);
    if (!u.profile?.business) throw new UserError(400, "Fill in your business details first.");
    const reserve = await reserveBuild(user.uid);
    const draft = (await draftRef(user.uid).get()).data();
    const msgs = await userRef(user.uid).collection("messages").orderBy("at", "desc").limit(30).get();
    const history = msgs.docs.filter((d) => d.get("role") === "owner").slice(0, 8).map((d) => d.get("text")).filter(Boolean).reverse();
    await log(user.uid, "owner", request || "Make our website.");
    try {
      const out = await buildSite({ profile: u.profile, current: draft?.html || null, request, history });
      await saveDraft(user.uid, out.html, "ai", draft);
      await log(user.uid, "builder", draft?.html ? "Done. Your changes are in the preview." : "Here's your site. Ask for any changes.", {
        tokens: (out.usage.input_tokens || 0) + (out.usage.output_tokens || 0),
      });
      res.json({ ok: true, left: reserve.left });
    } catch (err) {
      await refundBuild(user.uid, reserve);
      const msg = err instanceof ApiError ? "The builder is busy right now. Try again in a minute." : err.message;
      await log(user.uid, "builder", `That didn't work: ${msg}`, { failed: true });
      logger.error("build failed", { uid: user.uid, err: String(err) });
      throw new UserError(502, msg);
    }
  },

  async "/undo"(user, body, res) {
    const prev = (await userRef(user.uid).collection("site").doc("previous").get()).data();
    if (!prev?.html) throw new UserError(400, "Nothing to undo.");
    await saveDraft(user.uid, prev.html, "undo");
    await log(user.uid, "builder", "Went back to the version before your last change.");
    res.json({ ok: true });
  },

  async "/domain-check"(user, body, res) {
    const domain = parseDomain(body.domain);
    if (!domain) throw new UserError(400, "Type a name like rosasbakery.com (one word, ending in .com, .net, .org, .us, .co, .shop or .biz).");
    const taken = (await db.collection("domainIndex").doc(domain).get()).data();
    if (taken && taken.uid !== user.uid) return res.json({ ok: true, domain, available: false, why: "taken" });
    const r = await cf("POST", "/accounts/{account}/registrar/domain-check", { domains: [domain] });
    const verdict = domainBuyable(r.body?.result?.domains?.[0], MAX_DOMAIN_PRICE.value());
    let suggestions = [];
    if (!verdict.ok) {
      const label = domain.split(".")[0];
      const s = await cf("GET", `/accounts/{account}/registrar/domain-search?q=${encodeURIComponent(label)}&limit=12`, null, { allow: [400, 404] });
      suggestions = (s.body?.result?.domains || [])
        .filter((e) => parseDomain(e.name) && domainBuyable(e, MAX_DOMAIN_PRICE.value()).ok)
        .slice(0, 5)
        .map((e) => ({ domain: e.name, price: Number(e.pricing?.registration_cost) }));
    }
    res.json({ ok: true, domain, available: verdict.ok, price: verdict.cost ?? null, renew: verdict.renew ?? null, why: verdict.ok ? null : verdict.why, suggestions });
  },

  async "/subscribe"(user, body, res) {
    const plan = PLANS[body.plan] ? body.plan : null;
    const billing = BILLING.includes(body.billing) ? body.billing : null;
    const domain = parseDomain(body.domain);
    const contact = parseContact(body.contact);
    const cardToken = text(body.cardToken, 400);
    const checkoutId = /^[A-Za-z0-9_-]{8,40}$/.test(body.checkoutId || "") ? body.checkoutId : null;
    if (!plan || !billing) throw new UserError(400, "Pick a plan.");
    if (!domain) throw new UserError(400, "Pick a domain name.");
    if (!contact) throw new UserError(400, "Fill in the domain owner's name, email, phone and full US address.");
    if (!cardToken || !checkoutId) throw new UserError(400, "Card details are missing.");
    const cfg = (await configRef().get()).data() || {};
    const variation = cfg.plans?.[SQUARE_ENVIRONMENT.value()]?.[plan]?.[billing];
    if (!variation || !cfg.workerReady) throw new UserError(503, "Sign-ups open soon. Call or text (310) 279-8278 and we'll set you up.");

    const u = await getUser(user.uid);
    if (!u.profile?.business) throw new UserError(400, "Fill in your business details first.");
    if (!(await draftRef(user.uid).get()).exists) throw new UserError(400, "Make your site first, then pick a plan.");

    // One plan per account: claim the checkout, then the domain.
    await db.runTransaction(async (tx) => {
      const ref = userRef(user.uid);
      const snap = await tx.get(ref);
      const status = snap.get("plan.status");
      const stale = status === "starting" && (snap.get("plan.startingAt")?.toMillis?.() || 0) < Date.now() - 10 * 60e3;
      if (!stale && ["starting", "pending_payment", "active", "past_due", "canceling"].includes(status) && snap.get("plan.checkoutId") !== checkoutId) {
        throw new UserError(409, "You already have a plan. Manage it from your page.");
      }
      const idx = db.collection("domainIndex").doc(domain);
      const owner = (await tx.get(idx)).data();
      if (owner && owner.uid !== user.uid) throw new UserError(409, `${domain} is taken. Pick another name.`);
      tx.set(idx, { uid: user.uid, at: FieldValue.serverTimestamp() });
      tx.set(ref, { plan: { status: "starting", startingAt: new Date(), checkoutId, id: plan, billing } }, { merge: true });
    });

    try {
      const check = await cf("POST", "/accounts/{account}/registrar/domain-check", { domains: [domain] });
      const verdict = domainBuyable(check.body?.result?.domains?.[0], MAX_DOMAIN_PRICE.value());
      if (!verdict.ok) throw new UserError(409, `${domain} can't be bought (${verdict.why}). Pick another name.`);

      let customerId = u.plan?.customerId || u.square?.customerId;
      if (!customerId) {
        customerId = (await square("POST", "/v2/customers", {
          idempotency_key: `${checkoutId}-cust`,
          given_name: contact.first,
          family_name: contact.last,
          email_address: user.email,
          phone_number: registrarPhone(contact.phone).replace(".", ""),
          company_name: u.profile.business,
          reference_id: user.uid,
        })).customer.id;
        await userRef(user.uid).set({ square: { customerId } }, { merge: true });
      }
      const card = (await square("POST", "/v2/cards", {
        idempotency_key: `${checkoutId}-card`,
        source_id: cardToken,
        ...(body.verificationToken ? { verification_token: text(body.verificationToken, 2000) } : {}),
        card: {
          customer_id: customerId,
          cardholder_name: `${contact.first} ${contact.last}`,
          billing_address: { address_line_1: contact.street, locality: contact.city, administrative_district_level_1: contact.state, postal_code: contact.zip, country: "US" },
          reference_id: user.uid,
        },
      })).card;
      const sub = (await square("POST", "/v2/subscriptions", {
        idempotency_key: `${checkoutId}-sub`,
        location_id: SQUARE_LOCATION_ID.value(),
        plan_variation_id: variation,
        customer_id: customerId,
        card_id: card.id,
        timezone: "America/Los_Angeles",
        source: { name: "Web Burrito" },
      })).subscription;

      await db.collection("subIndex").doc(sub.id).set({ uid: user.uid });
      await userRef(user.uid).set({
        plan: {
          id: plan, billing, status: "pending_payment", paid: false, checkoutId, customerId,
          subscriptionId: sub.id, cardId: card.id, cardLast4: card.last_4 || "", cardBrand: card.card_brand || "",
          price: PLANS[plan][billing], startedAt: FieldValue.serverTimestamp(),
        },
        domain: { name: domain, state: "chosen", contact, cost: verdict.cost, error: null },
        launch: { state: "waiting_payment", error: null },
      }, { merge: true });
      logger.info("subscription started", { uid: user.uid, plan, billing, domain });
    } catch (err) {
      // Nothing was charged if we got here before the subscription; let them try again.
      const s = await userRef(user.uid).get();
      if (!s.get("plan.subscriptionId")) {
        await userRef(user.uid).set({ plan: { status: null, checkoutId: null } }, { merge: true });
        await db.collection("domainIndex").doc(domain).delete();
      }
      if (err instanceof ApiError && err.service === "square") {
        throw new UserError(402, /CARD|CVV|EXPIR|DECLIN|VERIFY|ADDRESS|POSTAL/i.test(err.detail) ? "The card didn't go through. Check the details or try another card." : "Payment couldn't be set up. Try again in a minute.");
      }
      throw err;
    }
    const state = await advance(user.uid, "subscribe");
    res.json({ ok: true, state });
  },

  async "/status"(user, body, res) {
    const u = await getUser(user.uid);
    if (!u.plan?.subscriptionId || u.launch?.state === "live" && u.domain?.attached) return res.json({ ok: true, state: u.launch?.state || null });
    res.json({ ok: true, state: await advance(user.uid, "status") });
  },

  async "/publish"(user, body, res) {
    const u = await getUser(user.uid);
    if (!isPaid(u) || u.domain?.state !== "registered") throw new UserError(400, "Your site goes live after your first payment.");
    const r = await withLease(user.uid, () => publishDraft(user.uid, u));
    if (r === "busy") throw new UserError(409, "Your site is being set up right now. Try again in a minute.");
    if (r.ok) await userRef(user.uid).set({ launch: { state: "live", reasons: [] } }, { merge: true });
    res.json({ ok: true, published: r.ok, reasons: r.reasons });
  },

  async "/email"(user, body, res) {
    const u = await getUser(user.uid);
    const max = PLANS[u.plan?.id]?.emails || 0;
    if (!isPaid(u) || !max) throw new UserError(400, "Business email addresses come with The Super and The Loaded.");
    if (!u.domain?.zoneId) throw new UserError(400, "Your domain isn't ready yet.");
    const forwards = parseForwards(body.forwards, max);
    if (!forwards) throw new UserError(400, `Use up to ${max} addresses like info, each forwarding to a real email address.`);
    await syncEmail(u.domain, forwards);
    await userRef(user.uid).set({ email: { forwards, updatedAt: FieldValue.serverTimestamp() } }, { merge: true });
    res.json({ ok: true });
  },

  async "/card"(user, body, res) {
    const u = await getUser(user.uid);
    if (!u.plan?.subscriptionId) throw new UserError(400, "No plan yet.");
    const cardToken = text(body.cardToken, 400);
    const zip = text(body.zip, 10);
    if (!cardToken) throw new UserError(400, "Card details are missing.");
    try {
      const card = (await square("POST", "/v2/cards", {
        idempotency_key: idem("card"),
        source_id: cardToken,
        ...(body.verificationToken ? { verification_token: text(body.verificationToken, 2000) } : {}),
        card: { customer_id: u.plan.customerId, ...(zip ? { billing_address: { postal_code: zip, country: "US" } } : {}), reference_id: user.uid },
      })).card;
      await square("PUT", `/v2/subscriptions/${encodeURIComponent(u.plan.subscriptionId)}`, { subscription: { card_id: card.id } });
      await userRef(user.uid).set({ plan: { cardId: card.id, cardLast4: card.last_4 || "", cardBrand: card.card_brand || "" } }, { merge: true });
    } catch (err) {
      if (err instanceof ApiError && err.service === "square") throw new UserError(402, "That card didn't work. Check the details or try another card.");
      throw err;
    }
    res.json({ ok: true });
  },

  async "/cancel"(user, body, res) {
    const u = await getUser(user.uid);
    if (!u.plan?.subscriptionId || !["active", "past_due", "pending_payment"].includes(u.plan.status)) throw new UserError(400, "No plan to cancel.");
    const sub = (await square("POST", `/v2/subscriptions/${encodeURIComponent(u.plan.subscriptionId)}/cancel`, {})).subscription;
    await userRef(user.uid).set({ plan: { status: "canceling", cancelDate: sub?.canceled_date || null } }, { merge: true });
    logger.info("cancel requested", { uid: user.uid, until: sub?.canceled_date });
    res.json({ ok: true, until: sub?.canceled_date || null });
  },
};

async function saveDraft(uid, html, source, previous) {
  const prev = previous === undefined ? (await draftRef(uid).get()).data() : previous;
  if (prev?.html) await userRef(uid).collection("site").doc("previous").set(prev);
  await draftRef(uid).set({ html, hash: pageHash(html), source, updatedAt: FieldValue.serverTimestamp(), version: FieldValue.increment(1) }, { merge: true });
}

// Free tries before paying, then a monthly allowance by plan. Counted before the build runs.
async function reserveBuild(uid) {
  const usage = db.collection("usage").doc(dayKey());
  return db.runTransaction(async (tx) => {
    const ref = userRef(uid);
    const u = (await tx.get(ref)).data() || {};
    const day = (await tx.get(usage)).data() || {};
    if (isPaid(u)) {
      const month = monthKey();
      const used = u.builds?.month === month ? u.builds.monthCount || 0 : 0;
      const limit = PLANS[u.plan.id]?.editsPerMonth || 20;
      if (used >= limit) throw new UserError(429, `You've used this month's ${limit} AI changes. Text (310) 279-8278 for more.`);
      tx.set(ref, { builds: { month, monthCount: used + 1 } }, { merge: true });
      return { kind: "month", left: limit - used - 1 };
    }
    const used = u.builds?.free || 0;
    const limit = FREE_BUILDS.value();
    if (used >= limit) throw new UserError(402, `You've used your ${limit} free tries. Pick a plan to keep building.`);
    if ((day.free || 0) >= FREE_BUILDS_PER_DAY_TOTAL.value()) throw new UserError(429, "The builder is very busy today. Try again tomorrow, or text (310) 279-8278.");
    tx.set(ref, { builds: { free: used + 1 } }, { merge: true });
    tx.set(usage, { free: FieldValue.increment(1) }, { merge: true });
    return { kind: "free", left: limit - used - 1 };
  });
}
async function refundBuild(uid, reserve) {
  if (reserve.kind === "free") {
    await userRef(uid).set({ builds: { free: FieldValue.increment(-1) } }, { merge: true });
    await db.collection("usage").doc(dayKey()).set({ free: FieldValue.increment(-1) }, { merge: true });
  } else {
    await userRef(uid).set({ builds: { monthCount: FieldValue.increment(-1) } }, { merge: true });
  }
}

// Business email addresses: Cloudflare Email Routing forwards name@theirdomain to their inbox.
async function syncEmail(domain, forwards) {
  const zone = domain.zoneId;
  try {
    await cf("POST", `/zones/${zone}/email/routing/dns`, { name: domain.name });
  } catch {
    await cf("POST", `/zones/${zone}/email/routing/enable`, {}, { allow: [400, 409] });
  }
  for (const to of new Set(forwards.map((f) => f.to))) {
    await cf("POST", "/accounts/{account}/email/routing/addresses", { email: to }, { allow: [400, 409] });
  }
  const rules = (await cf("GET", `/zones/${zone}/email/routing/rules?per_page=50`)).body?.result || [];
  for (const r of rules.filter((r) => String(r.name || "").startsWith("wb:"))) {
    await cf("DELETE", `/zones/${zone}/email/routing/rules/${r.id || r.tag}`);
  }
  for (const f of forwards) {
    await cf("POST", `/zones/${zone}/email/routing/rules`, {
      name: `wb:${f.local}`,
      enabled: true,
      matchers: [{ type: "literal", field: "to", value: `${f.local}@${domain.name}` }],
      actions: [{ type: "forward", value: [f.to] }],
    });
  }
}

// ---------- Square webhooks ----------
async function squareWebhook(req, res) {
  if (req.method !== "POST") return res.status(405).send("");
  const raw = req.rawBody ? req.rawBody.toString("utf8") : "";
  const sig = req.get("x-square-hmacsha256-signature");
  if (!squareSignatureOk(sig, SQUARE_WEBHOOK_SIGNATURE_KEY.value(), SQUARE_WEBHOOK_URL.value(), raw)) return res.status(401).send("");
  let ev;
  try { ev = JSON.parse(raw); } catch { return res.status(400).send(""); }
  const id = text(String(ev.event_id || ""), 100);
  if (!id) return res.status(400).send("");
  const seen = db.collection("squareEvents").doc(id);
  try {
    await seen.create({ type: text(ev.type, 80), at: FieldValue.serverTimestamp() });
  } catch (err) {
    if (err.code === 6) return res.status(200).send(""); // already handled
    throw err;
  }
  try {
    await onSquareEvent(ev);
  } catch (err) {
    await seen.delete();
    logger.error("webhook failed", { type: ev.type, err: String(err) });
    return res.status(500).send("");
  }
  res.status(200).send("");
}

async function uidFor(subscriptionId) {
  if (!subscriptionId) return null;
  return (await db.collection("subIndex").doc(String(subscriptionId)).get()).get("uid") || null;
}

async function onSquareEvent(ev) {
  const obj = ev.data?.object || {};
  if (ev.type === "invoice.payment_made") {
    const uid = await uidFor(obj.invoice?.subscription_id);
    if (!uid) return;
    await markPaid(uid, obj.invoice.id);
    await advance(uid, "webhook");
  } else if (ev.type === "invoice.scheduled_charge_failed") {
    const uid = await uidFor(obj.invoice?.subscription_id);
    if (!uid) return;
    const u = await getUser(uid);
    if (u.plan?.status === "active") {
      await userRef(uid).set({ plan: { status: "past_due", pastDueSince: u.plan.pastDueSince || FieldValue.serverTimestamp() } }, { merge: true });
    } else if (u.plan?.status === "pending_payment") {
      // The very first charge failed: nothing has been bought yet. Tell the customer what to do.
      await userRef(uid).set({ launch: { state: "payment_failed", error: "Your card was declined. Pay the invoice Square emailed you, or change your card below and text (310) 279-8278." } }, { merge: true });
    }
  } else if (ev.type === "subscription.updated" || ev.type === "subscription.created") {
    const sub = obj.subscription || {};
    const uid = await uidFor(sub.id);
    if (!uid) return;
    if (["CANCELED", "DEACTIVATED"].includes(sub.status)) {
      await userRef(uid).set({ plan: { status: "canceled", endedAt: FieldValue.serverTimestamp() } }, { merge: true });
      await takeOffline(uid, "canceled");
    } else if (sub.status === "PAUSED") {
      await userRef(uid).set({ plan: { status: "paused" } }, { merge: true });
      await takeOffline(uid, "paused");
    }
  }
}

// ---------- admin ----------
const ADMIN = {
  async "/admin/setup-square"(user, body, res) {
    const env = SQUARE_ENVIRONMENT.value();
    const cfg = (await configRef().get()).data() || {};
    if (cfg.plans?.[env]) return res.json({ ok: true, plans: cfg.plans[env], note: "Already set up." });
    const planObjects = Object.entries(PLANS).map(([key, p]) => ({
      type: "SUBSCRIPTION_PLAN", id: `#plan_${key}`, subscription_plan_data: { name: `Web Burrito site: ${p.name}` },
    }));
    const made = await square("POST", "/v2/catalog/batch-upsert", { idempotency_key: idem("plans"), batches: [{ objects: planObjects }] });
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
    const made2 = await square("POST", "/v2/catalog/batch-upsert", { idempotency_key: idem("vars"), batches: [{ objects: variations }] });
    const varId = Object.fromEntries((made2.id_mappings || []).map((m) => [m.client_object_id, m.object_id]));
    const plans = Object.fromEntries(Object.keys(PLANS).map((k) => [k, { monthly: varId[`#${k}_monthly`], yearly: varId[`#${k}_yearly`] }]));
    if (Object.values(plans).some((p) => !p.monthly || !p.yearly)) throw new Error("Square didn't return all plan ids");
    await configRef().set({ plans: { [env]: plans }, plansAt: FieldValue.serverTimestamp() }, { merge: true });
    res.json({ ok: true, plans });
  },

  async "/admin/setup-hosting"(user, body, res) {
    res.json({ ok: true, ...(await setupHosting()) });
  },

  async "/admin/retry"(user, body, res) {
    const uid = text(body.uid, 128);
    if (!uid) throw new UserError(400, "Which customer?");
    res.json({ ok: true, state: await advance(uid, `admin ${user.email}`) });
  },

  async "/admin/offline"(user, body, res) {
    const uid = text(body.uid, 128);
    if (!uid) throw new UserError(400, "Which customer?");
    await takeOffline(uid, `admin ${user.email}`);
    res.json({ ok: true });
  },

  async "/admin/sweep"(user, body, res) {
    const cutoff = Date.now() - PAST_DUE_GRACE_DAYS.value() * 86400e3;
    const late = await db.collection("users").where("plan.status", "==", "past_due").limit(100).get();
    let offline = 0;
    for (const d of late.docs) {
      const since = d.get("plan.pastDueSince")?.toMillis?.() || Date.now();
      if (since < cutoff && d.get("live.state") === "live") {
        await takeOffline(d.id, "unpaid");
        offline += 1;
      }
    }
    res.json({ ok: true, pastDue: late.size, offline });
  },
};
