// The customer platform API.
//
// The customer page calls the function's own URL (config.apiBase) for anything that can take
// a while, because requests through Firebase Hosting are cut off after 60 seconds; /config and
// the Square webhook go through https://webburrito.com/api/app/* (rewrite in firebase.json).
//
//   GET  /config            public settings for the customer page
//   POST /profile           save business details
//   POST /claim             start from a Web Burrito preview (slug + its personal link's key, or the passcode)
//   POST /build             AI builds or edits the draft (3 free tries, then a monthly allowance)
//   POST /undo              go back to the draft before the last change
//   POST /domain-check      is a domain free, and its price
//   POST /domain            pick a new domain when the first one couldn't be registered
//   POST /subscribe         card + plan + domain: starts the Square subscription
//   POST /status            moves the launch forward (payment -> domain -> check -> live)
//   POST /publish           check the draft and make it the live site
//   POST /email             forwarding addresses (The Super and The Loaded)
//   POST /card              replace the card on file
//   POST /cancel            cancel (at the end of the paid period)
//   POST /square-webhook    Square events (signed)
//   POST /admin/*           setup-square, setup-hosting, retry, offline, restore, tick
//
// `launcher` runs every minute and carries launches forward when nobody has the page open.
//
// Every POST except the webhook needs a Firebase sign-in with a verified email.

import { webcrypto } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { onRequest } from "firebase-functions/https";
import { onSchedule } from "firebase-functions/scheduler";
import { logger } from "firebase-functions";
import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import {
  SECRETS, SQUARE_APPLICATION_ID, SQUARE_ENVIRONMENT, SQUARE_LOCATION_ID, SQUARE_WEBHOOK_SIGNATURE_KEY, SQUARE_WEBHOOK_URL,
  CLOUDFLARE_ACCOUNT_ID, FREE_BUILDS, FREE_BUILDS_PER_DAY_TOTAL, MAX_DOMAIN_PRICE, TEST_EMAILS, SITE_ORIGIN, isLive,
  PLATFORM_ON,
} from "./config.js";
import {
  PLANS, BILLING, text, parseProfile, parseContact, parseDomain, domainBuyable, squareSignatureOk, cleanHtml, sanitizeHtml,
  pageFits, monthKey, dayKey, pageHash, parseForwards, registrarPhone, riskyDomain, shortHash,
} from "./pure.js";
import { square, cf, idem, ApiError } from "./clients.js";
import { buildSite, polishClaim, PREVIEW_WORDING } from "./ai.js";
import { livePreview, fillProfile, nameFromSlug, listingLinesOf } from "./site.js";
import {
  advance, publishDraft, takeOffline, restore, setupHosting, setupSquarePlans, withLease, markPaid, queue, tick, reconcileCheckout,
  adoptSubscription, resetCheckout, userRef, draftRef, configRef, currentPlan, isPaid, Step, PAID_STATUSES, ENDED_STATUSES,
  domainIndex,
} from "./launch.js";

if (!getApps().length) initializeApp();
const db = getFirestore();
const env = () => SQUARE_ENVIRONMENT.value();
const ms = (t) => t?.toMillis?.() ?? (t instanceof Date ? t.getTime() : 0);
// Square customers are kept per environment (sandbox test customers aren't real ones).
const customerKey = (customerId) => `${env()}_${customerId}`;
const squareCustomerOf = (u) => u.squareCustomers?.[env()] || null;
// A plan that's still running (or about to): the account can't start another one.
const OPEN_STATUSES = ["starting", "pending_payment", "paused", ...PAID_STATUSES];

class UserError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
const fail = (res, status, error, extra = {}) => res.status(status).json({ ok: false, error, ...extra });

const ORIGINS = [/^https:\/\/(www\.)?webburrito\.com$/, "https://web-burrito.web.app", "https://web-burrito.firebaseapp.com", "http://127.0.0.1:5050", "http://localhost:5050"];
const OPTIONS = { region: "us-central1", secrets: SECRETS, maxInstances: 5 };

// Both functions exist only when the platform is on (PLATFORM in functions/.env).
export const app = PLATFORM_ON ? onRequest(
  { ...OPTIONS, timeoutSeconds: 540, memory: "512MiB", invoker: "public", concurrency: 20, cors: ORIGINS },
  async (req, res) => {
    res.set("Cache-Control", "no-store");
    const path = req.path.replace(/^\/api\/app(?=\/)/, "");
    try {
      if (path === "/config" && req.method === "GET") {
        // Read by every home page and preview visit: cached at the edge so it rarely wakes this function.
        res.set("Cache-Control", "public, max-age=60, s-maxage=300");
        return res.json(await publicConfig());
      }
      if (path === "/square-webhook") return await squareWebhook(req, res);
      if (req.method !== "POST") return res.set("Allow", "POST").status(405).json({ ok: false });
      const body = readJson(req, 20_000);
      if (!body) return fail(res, 400, "Bad request.");
      const user = await signedIn(req, body);
      if (!user) return fail(res, 401, "Please sign in again.");
      // An account made with a password can build right away, but money, domains and going
      // live wait until its email is confirmed (Google and email-link sign-ins already are).
      if (NEEDS_CONFIRMED_EMAIL.has(path) && !user.verified) {
        return fail(res, 403, `Confirm your email first: open the link we sent to ${user.email}.`, { needsEmail: true });
      }
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
      if (err instanceof UserError) return fail(res, err.status, err.message, err.extra);
      if (err instanceof Step) return fail(res, 409, err.message);
      logger.error("app failed", { path, err: String(err), detail: err instanceof ApiError ? err.detail : undefined });
      return fail(res, 500, "Something went wrong. Try again in a minute.");
    }
  },
) : undefined;

// Every minute: carry launches forward, settle unclear checkouts, take unpaid sites offline.
export const launcher = PLATFORM_ON ? onSchedule({ ...OPTIONS, schedule: "every 1 minutes", timeoutSeconds: 540, memory: "512MiB" }, async () => {
  const out = await tick();
  if (out.advanced || out.reconciled || out.offline || out.errors) logger.info("launcher", out);
}) : undefined;

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

// What needs a confirmed email. Everything else (details, building, claiming a preview) works
// as soon as the account exists. Admins always need one (checked in signedIn).
const NEEDS_CONFIRMED_EMAIL = new Set(["/domain", "/subscribe", "/publish", "/email", "/card", "/cancel"]);

async function signedIn(req, body) {
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.get("authorization") || "")?.[1];
  const token = bearer || (typeof body._auth === "string" ? body._auth : null);
  if (!token || token.length > 4096) return null;
  try {
    const t = await getAuth().verifyIdToken(token);
    const email = String(t.email || "").toLowerCase();
    if (!email) return null;
    const verified = t.email_verified === true;
    // Never an admin on an unconfirmed email: anyone can type someone else's address.
    const admin = verified && (await db.collection("admins").doc(email).get()).exists;
    return { uid: t.uid, email, name: text(t.name || "", 80), verified, admin };
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

/** In test mode only admins and TEST_EMAILS can buy (with Square test cards). */
const canBuy = (user) => isLive() || user.admin || TEST_EMAILS.value().toLowerCase().split(",").map((s) => s.trim()).includes(user.email);

function apiBase() {
  let project = process.env.GCLOUD_PROJECT;
  try { project ||= JSON.parse(process.env.FIREBASE_CONFIG || "{}").projectId; } catch {}
  if (process.env.FUNCTIONS_EMULATOR === "true") return `http://127.0.0.1:5001/${project}/us-central1/app`;
  return `https://us-central1-${project}.cloudfunctions.net/app`;
}

async function publicConfig() {
  const cfg = (await configRef().get()).data() || {};
  return {
    apiBase: apiBase(),
    square: { applicationId: SQUARE_APPLICATION_ID.value(), locationId: SQUARE_LOCATION_ID.value(), environment: env() },
    plans: PLANS,
    freeBuilds: FREE_BUILDS.value(),
    testMode: !isLive(),
    ready: {
      payments: Boolean(cfg.plans?.[env()] && SQUARE_APPLICATION_ID.value()),
      hosting: Boolean(cfg.workerReady),
      domains: Boolean(CLOUDFLARE_ACCOUNT_ID.value()),
    },
  };
}

async function log(uid, role, msg, extra = {}) {
  await userRef(uid).collection("messages").add({ role, text: text(msg, 2000), at: FieldValue.serverTimestamp(), ...extra });
}

/** At most `max` calls per `windowSec` per customer for `key`. */
async function rateLimit(uid, key, max, windowSec) {
  const ref = db.collection("rate").doc(`${uid}_${key}`);
  await db.runTransaction(async (tx) => {
    const d = (await tx.get(ref)).data() || {};
    const fresh = !d.start || Date.now() - d.start > windowSec * 1000;
    if (!fresh && d.n >= max) throw new UserError(429, "That's a lot of tries in a short time. Wait a few minutes and try again.");
    tx.set(ref, fresh ? { start: Date.now(), n: 1 } : { start: d.start, n: d.n + 1 });
  });
}

// ---------- customer routes ----------
const ROUTES = {
  async "/profile"(user, body, res) {
    await rateLimit(user.uid, "profile", 60, 3600);
    const profile = parseProfile(body.profile);
    if (!profile) throw new UserError(400, "Add your business name.");
    await userRef(user.uid).set({ profile, profileAt: FieldValue.serverTimestamp() }, { merge: true });
    res.json({ ok: true });
  },

  async "/claim"(user, body, res) {
    await rateLimit(user.uid, "claim", 20, 3600);
    const slug = text(body.slug, 80);
    const key = text(body.key, 64);
    const passcode = key ? "" : text(body.passcode, 40);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new UserError(400, "That preview link doesn't look right.");
    if (!key && !passcode) throw new UserError(400, "Open your preview from the link we sent you, or type its passcode.");
    const raw = await openPreview(slug, { key, passcode });
    // Only the business's personal link proves it was sent to them. With the shared passcode,
    // Web Burrito checks it's the owner before a domain is bought in their name (launch.js).
    const verified = Boolean(key);
    // Becomes the live version: no concept banner, no noindex, forms -> call/text box...
    const { html: cleaned, facts } = livePreview(raw);
    // ...then one careful pass for wording that only made sense on the preview (a few cents),
    // done once per preview: claiming the same one again reuses it.
    const { html, polished } = await polishOnce(user.uid, slug, cleaned);
    const { hash } = await saveDraft(user.uid, html, "preview");
    const listingLines = listingLinesOf(html); // ratings and reviewer lines Web Burrito collected
    const u = await getUser(user.uid);
    const profile = parseProfile(fillProfile(u.profile, facts, nameFromSlug(slug)));
    // This exact page is Web Burrito's work: its check allows the review quotes from public listings.
    // It's still checked before going live (preview leftovers, the domain, everything else).
    await userRef(user.uid).set({
      claimedSlug: slug, profile, trustedHashes: FieldValue.arrayUnion(hash),
      claim: { slug, polished, listingLines, verified, at: FieldValue.serverTimestamp(), approvedBy: FieldValue.delete(), approvedAt: FieldValue.delete() },
    }, { merge: true });
    await log(user.uid, "builder", `Your site from webburrito.com/${slug} is ready. Check your hours, phone and address, and ask here for any changes.`
      + (verified ? "" : " Because it was opened with the passcode instead of your personal link, Web Burrito confirms you're the owner before it goes live (usually within a day)."));
    res.json({ ok: true, profile });
  },

  async "/build"(user, body, res) {
    await rateLimit(user.uid, "build", 30, 3600);
    const request = text(body.request, 2000);
    const u = await getUser(user.uid);
    if (!u.profile?.business) throw new UserError(400, "Fill in your business details first.");
    const draft = (await draftRef(user.uid).get()).data();
    if (draft?.html && draft.html.length > 150_000) throw new UserError(413, "Your page is too big to change. Undo the last change, or start fresh.");
    const reserve = await reserveBuild(user.uid);
    try {
      const msgs = await userRef(user.uid).collection("messages").orderBy("at", "desc").limit(30).get();
      const history = msgs.docs.filter((d) => d.get("role") === "owner").slice(0, 8).map((d) => d.get("text")).filter(Boolean).reverse();
      await log(user.uid, "owner", request || "Make our website.");
      const out = await buildSite({ profile: u.profile, current: draft?.html || null, request, history });
      await saveDraft(user.uid, out.html, "ai", draft);
      await log(user.uid, "builder", draft?.html ? "Done. Your changes are in the preview." : "Here's your site. Ask for any changes.", {
        tokens: (out.usage.input_tokens || 0) + (out.usage.output_tokens || 0),
      });
      res.json({ ok: true, left: reserve.left });
    } catch (err) {
      // Give the try back only when Claude refused the request outright (nothing was spent).
      if (err instanceof ApiError && err.status >= 400) await refundBuild(user.uid, reserve);
      const msg = err instanceof ApiError ? "The builder is busy right now. Try again in a minute." : err.message;
      await log(user.uid, "builder", `That didn't work: ${msg}`, { failed: true });
      logger.error("build failed", { uid: user.uid, err: String(err) });
      throw new UserError(502, msg);
    } finally {
      await userRef(user.uid).set({ builds: { running: null } }, { merge: true });
    }
  },

  async "/undo"(user, body, res) {
    await rateLimit(user.uid, "undo", 30, 3600);
    const prev = (await userRef(user.uid).collection("site").doc("previous").get()).data();
    if (!prev?.html) throw new UserError(400, "Nothing to undo.");
    await saveDraft(user.uid, prev.html, "undo");
    await log(user.uid, "builder", "Went back to the version before your last change.");
    res.json({ ok: true });
  },

  async "/domain-check"(user, body, res) {
    await rateLimit(user.uid, "domain", 40, 3600);
    const domain = parseDomain(body.domain);
    if (!domain) throw new UserError(400, "Type a name like rosasbakery.com (one word, ending in .com, .net, .org or .us).");
    if (riskyDomain(domain)) return res.json({ ok: true, domain, available: false, why: "not allowed", suggestions: [] });
    const taken = (await domainIndex(domain).get()).data();
    if (taken && taken.uid !== user.uid) return res.json({ ok: true, domain, available: false, why: "taken", suggestions: [] });
    if (taken?.registered) return res.json({ ok: true, domain, available: true, owned: true, price: 0, renew: null, why: null, suggestions: [] });
    const r = await cf("POST", "/accounts/{account}/registrar/domain-check", { domains: [domain] });
    const verdict = domainBuyable(r.body?.result?.domains?.[0], MAX_DOMAIN_PRICE.value());
    let suggestions = [];
    if (!verdict.ok) {
      const label = domain.split(".")[0];
      const s = await cf("GET", `/accounts/{account}/registrar/domain-search?q=${encodeURIComponent(label)}&limit=12`, null, { allow: [400, 404] });
      suggestions = (s.body?.result?.domains || [])
        .filter((e) => parseDomain(e.name) && !riskyDomain(e.name) && domainBuyable(e, MAX_DOMAIN_PRICE.value()).ok)
        .slice(0, 5)
        .map((e) => ({ domain: e.name, price: Number(e.pricing?.registration_cost) }));
    }
    res.json({ ok: true, domain, available: verdict.ok, price: verdict.cost ?? null, renew: verdict.renew ?? null, why: verdict.ok ? null : verdict.why, suggestions });
  },

  // After paying, if the first domain couldn't be registered, the customer picks another.
  async "/domain"(user, body, res) {
    await rateLimit(user.uid, "domain", 40, 3600);
    const domain = parseDomain(body.domain);
    if (!domain || riskyDomain(domain)) throw new UserError(400, "Pick a different name.");
    const mine = (await domainIndex(domain).get()).data();
    if (mine && mine.uid !== user.uid) throw new UserError(409, `${domain} is taken. Pick another name.`);
    if (!mine?.registered) {
      const check = await cf("POST", "/accounts/{account}/registrar/domain-check", { domains: [domain] });
      const verdict = domainBuyable(check.body?.result?.domains?.[0], MAX_DOMAIN_PRICE.value());
      if (!verdict.ok) throw new UserError(409, `${domain} can't be bought (${verdict.why}). Pick another name.`);
    }
    const r = await withLease(user.uid, async () => {
      const u = await getUser(user.uid);
      if (!isPaid(u)) throw new UserError(400, "Your plan isn't active.");
      if (!["unavailable", "failed"].includes(u.domain?.state)) throw new UserError(409, "Your domain is already set.");
      await db.runTransaction(async (tx) => {
        const idx = domainIndex(domain);
        const old = u.domain?.name && u.domain.name !== domain ? domainIndex(u.domain.name) : null;
        const owner = (await tx.get(idx)).data();
        const oldOwner = old ? (await tx.get(old)).data() : null;
        if (owner && owner.uid !== user.uid) throw new UserError(409, `${domain} is taken. Pick another name.`);
        tx.set(idx, { uid: user.uid, at: FieldValue.serverTimestamp() }, { merge: true });
        // Free the name that didn't work out, unless it was ever registered for them.
        if (old && oldOwner?.uid === user.uid && !oldOwner.registered) tx.delete(old);
        tx.set(userRef(user.uid), {
          domain: { name: domain, state: "chosen", error: null, pendingAt: null, attached: false, zoneId: null },
          launch: { queued: true, nextAt: new Date(), state: "domain", error: null },
        }, { merge: true });
      });
      return "ok";
    });
    if (r === "busy") throw new UserError(409, "Your site is being set up right now. Try again in a minute.");
    res.json({ ok: true, state: await advance(user.uid, "new domain") });
  },

  async "/subscribe"(user, body, res) {
    const plan = PLANS[body.plan] ? body.plan : null;
    const billing = BILLING.includes(body.billing) ? body.billing : null;
    const domain = parseDomain(body.domain);
    const contact = parseContact(body.contact);
    const cardToken = text(body.cardToken, 400);
    const checkoutId = /^[A-Za-z0-9_-]{8,30}$/.test(body.checkoutId || "") ? body.checkoutId : null;
    if (!plan || !billing) throw new UserError(400, "Pick a plan.");
    if (!domain || riskyDomain(domain)) throw new UserError(400, "Pick a domain name.");
    if (!contact) throw new UserError(400, "Fill in the domain owner's name, email, phone and full US address.");
    if (!cardToken || !checkoutId) throw new UserError(400, "Card details are missing.");
    if (!canBuy(user)) throw new UserError(403, "Sign-ups open soon. Call or text (310) 279-8278 and we'll set you up.");
    await rateLimit(user.uid, "subscribe", 10, 3600);
    const cfg = (await configRef().get()).data() || {};
    const variation = cfg.plans?.[env()]?.[plan]?.[billing];
    if (!variation || !cfg.workerReady) throw new UserError(503, "Sign-ups open soon. Call or text (310) 279-8278 and we'll set you up.");

    let u = await getUser(user.uid);
    if (!u.profile?.business) throw new UserError(400, "Fill in your business details first.");
    if (!(await draftRef(user.uid).get()).exists) throw new UserError(400, "Make your site first, then pick a plan.");
    if (currentPlan(u)?.status === "starting") {
      await reconcileCheckout(user.uid);
      u = await getUser(user.uid);
    }

    // One plan per account. A plan that ended (or belongs to the other Square environment) is
    // archived, so a new one starts clean.
    const begun = await db.runTransaction(async (tx) => {
      const ref = userRef(user.uid);
      const now = (await tx.get(ref)).data() || {};
      const cur = currentPlan(now);
      const busy = cur && OPEN_STATUSES.includes(cur.status);
      if (busy && cur.checkoutId !== checkoutId) throw new UserError(409, "You already have a plan. Manage it from your page.");
      if (cur?.checkoutId === checkoutId && cur.status !== "starting") throw new UserError(409, "This payment was already made.");
      // A subscription may already be on its way for this checkout (or another tab is paying
      // right now): never start a second one.
      if (cur?.status === "starting" && (cur.subAttemptAt || ms(cur.payingUntil) > Date.now())) return "checking";
      if (["admin", "disputed"].includes(now.live?.suspended)) throw new UserError(403, "Contact Web Burrito to start again: (310) 279-8278.");
      const idx = domainIndex(domain);
      const oldName = now.domain?.name && now.domain.name !== domain ? now.domain.name : null;
      const owner = (await tx.get(idx)).data();
      const oldOwner = oldName ? (await tx.get(domainIndex(oldName))).data() : null;
      if (owner && owner.uid !== user.uid) throw new UserError(409, `${domain} is taken. Pick another name.`);
      if (now.plan && !busy) {
        tx.set(ref.collection("history").doc(), { plan: now.plan, domain: now.domain || null, live: now.live || null, at: FieldValue.serverTimestamp() });
      }
      if (oldName && oldOwner?.uid === user.uid && !oldOwner.registered) tx.delete(domainIndex(oldName));
      tx.set(idx, { uid: user.uid, at: FieldValue.serverTimestamp() }, { merge: true });
      tx.set(ref, {
        plan: {
          status: "starting", startingAt: new Date(), payingUntil: new Date(Date.now() + 120e3), checkoutId, id: plan, billing, env: env(), variationId: variation, paid: false,
          subscriptionId: null, subAttemptAt: null, cardId: null, firstChargeFailedAt: null, customerId: squareCustomerOf(now),
        },
        domain: { name: domain, state: "chosen", contact, error: null, attached: false, zoneId: null, test: null, pendingAt: null, owned: Boolean(owner?.registered) },
        live: null, // a fresh start (a refunded customer can come back)
        launch: { state: "starting", error: null, queued: false, nextAt: null, attempts: 0 },
        review: null,
      }, { merge: true });
      return owner?.registered ? "owned" : "new";
    });
    if (begun === "checking") return res.status(202).json({ ok: true, state: "checking" });

    const undo = async (status, message) => {
      await resetCheckout(user.uid, domain);
      throw new UserError(status, message, { newCheckout: true });
    };
    // A domain they registered with us before is theirs already; anything else must be free.
    let verdict = { ok: true, cost: 0 };
    if (begun !== "owned") {
      const check = await cf("POST", "/accounts/{account}/registrar/domain-check", { domains: [domain] });
      verdict = domainBuyable(check.body?.result?.domains?.[0], MAX_DOMAIN_PRICE.value());
      if (!verdict.ok) await undo(409, `${domain} can't be bought (${verdict.why}). Pick another name.`);
    }

    // Square customer (one per account and Square environment) and the card. Neither charges anything.
    let customerId = squareCustomerOf(u);
    try {
      if (!customerId) {
        customerId = (await square("POST", "/v2/customers", {
          idempotency_key: `cust-${user.uid}`.slice(0, 45),
          given_name: contact.first, family_name: contact.last, email_address: user.email,
          phone_number: registrarPhone(contact.phone).replace(".", ""), company_name: u.profile.business, reference_id: user.uid,
        })).customer.id;
        await db.collection("customerIndex").doc(customerKey(customerId)).set({ uid: user.uid, env: env(), customerId });
        await userRef(user.uid).set({ squareCustomers: { [env()]: customerId }, plan: { customerId } }, { merge: true });
      } else {
        await userRef(user.uid).set({ plan: { customerId } }, { merge: true });
      }
    } catch (err) {
      if (err instanceof ApiError) await undo(502, "Payment couldn't be set up. Try again in a minute.");
      throw err;
    }
    let card;
    try {
      card = (await square("POST", "/v2/cards", {
        // One key per card entered, so a second card isn't mistaken for a repeat of the first.
        idempotency_key: `${checkoutId}-c-${shortHash(cardToken)}`,
        source_id: cardToken,
        ...(body.verificationToken ? { verification_token: text(body.verificationToken, 2000) } : {}),
        card: {
          customer_id: customerId,
          cardholder_name: `${contact.first} ${contact.last}`,
          billing_address: { address_line_1: contact.street, locality: contact.city, administrative_district_level_1: contact.state, postal_code: contact.zip, country: "US" },
          reference_id: user.uid,
        },
      })).card;
    } catch (err) {
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) await undo(402, "The card didn't go through. Check the details or try another card.");
      if (err instanceof ApiError) await undo(502, "Payment couldn't be set up. Try again in a minute.");
      throw err;
    }

    // From here on, a subscription may exist even if we don't hear back, so the checkout is
    // never undone without asking Square first (reconcileCheckout).
    await userRef(user.uid).set({ plan: { subAttemptAt: new Date(), cardId: card.id, cardLast4: card.last_4 || "", cardBrand: card.card_brand || "" } }, { merge: true });
    let sub;
    try {
      sub = (await square("POST", "/v2/subscriptions", {
        idempotency_key: `${checkoutId}-s-${shortHash(card.id)}`,
        location_id: SQUARE_LOCATION_ID.value(),
        plan_variation_id: variation,
        customer_id: customerId,
        card_id: card.id,
        timezone: "America/Los_Angeles",
        source: { name: "Web Burrito" },
      })).subscription;
    } catch (err) {
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) await undo(402, "The payment couldn't be started. Try again, or try another card.");
      logger.warn("subscription answer unclear", { uid: user.uid, err: String(err) });
      return res.status(202).json({ ok: true, state: "checking" }); // the launcher settles it
    }
    await adoptSubscription(user.uid, sub.id);
    await userRef(user.uid).set({ plan: { price: PLANS[plan][billing] }, domain: { cost: verdict.cost ?? null } }, { merge: true });
    logger.info("subscription started", { uid: user.uid, plan, billing, domain, env: env() });
    res.json({ ok: true, state: await advance(user.uid, "subscribe") });
  },

  async "/status"(user, body, res) {
    await rateLimit(user.uid, "status", 400, 3600);
    const u = await getUser(user.uid);
    const plan = currentPlan(u);
    let state = u.launch?.state || null;
    const due = u.launch?.queued && ms(u.launch?.nextAt) <= Date.now();
    if (plan?.status === "starting") await reconcileCheckout(user.uid);
    else if (plan?.subscriptionId && due) state = await advance(user.uid, "status");
    res.json({ ok: true, state, canBuy: canBuy(user) });
  },

  async "/publish"(user, body, res) {
    await rateLimit(user.uid, "publish", 20, 3600);
    const u = await getUser(user.uid);
    if (!isPaid(u) || u.domain?.state !== "registered") throw new UserError(400, "Your site goes live after your first payment.");
    let r;
    try {
      r = await withLease(user.uid, () => publishDraft(user.uid));
    } catch (err) {
      // The check didn't finish: nothing changed online. (The launcher only retries first launches.)
      if (err instanceof Step && err.state === "checking") throw new UserError(503, "The site check didn't finish. Click Publish again in a minute.");
      throw err;
    }
    if (r === "busy") throw new UserError(409, "Your site is being set up right now. Try again in a minute.");
    if (r.ok) await userRef(user.uid).set({ launch: { state: "live", reasons: [], queued: true, nextAt: new Date() } }, { merge: true });
    res.json({ ok: true, published: r.ok, reasons: r.reasons });
  },

  async "/email"(user, body, res) {
    await rateLimit(user.uid, "email", 10, 3600);
    const u = await getUser(user.uid);
    const max = PLANS[currentPlan(u)?.id]?.emails || 0;
    if (!isPaid(u) || !max) throw new UserError(400, "Business email addresses come with The Super and The Loaded.");
    if (!u.domain?.zoneId) throw new UserError(400, "Your domain isn't ready yet.");
    const forwards = parseForwards(body.forwards, max);
    if (!forwards) throw new UserError(400, `Use up to ${max} addresses like info, each forwarding to a real email address.`);
    await syncEmail(u.domain, forwards);
    await userRef(user.uid).set({ email: { forwards, updatedAt: FieldValue.serverTimestamp() } }, { merge: true });
    res.json({ ok: true });
  },

  async "/card"(user, body, res) {
    await rateLimit(user.uid, "card", 10, 3600);
    const u = await getUser(user.uid);
    const plan = currentPlan(u);
    if (!plan?.subscriptionId || ENDED_STATUSES.includes(plan.status)) throw new UserError(400, "No plan yet.");
    const cardToken = text(body.cardToken, 400);
    const zip = text(body.zip, 10);
    if (!cardToken) throw new UserError(400, "Card details are missing.");
    try {
      const card = (await square("POST", "/v2/cards", {
        idempotency_key: idem("card"),
        source_id: cardToken,
        ...(body.verificationToken ? { verification_token: text(body.verificationToken, 2000) } : {}),
        card: { customer_id: plan.customerId, ...(zip ? { billing_address: { postal_code: zip, country: "US" } } : {}), reference_id: user.uid },
      })).card;
      await square("PUT", `/v2/subscriptions/${encodeURIComponent(plan.subscriptionId)}`, { subscription: { card_id: card.id } });
      await userRef(user.uid).set({ plan: { cardId: card.id, cardLast4: card.last_4 || "", cardBrand: card.card_brand || "" } }, { merge: true });
    } catch (err) {
      if (err instanceof ApiError && err.service === "square") throw new UserError(402, "That card didn't work. Check the details or try another card.");
      throw err;
    }
    res.json({ ok: true });
  },

  async "/cancel"(user, body, res) {
    const u = await getUser(user.uid);
    const plan = currentPlan(u);
    if (!plan?.subscriptionId || !["active", "past_due", "pending_payment"].includes(plan.status)) throw new UserError(400, "No plan to cancel.");
    const sub = (await square("POST", `/v2/subscriptions/${encodeURIComponent(plan.subscriptionId)}/cancel`, {})).subscription;
    if (plan.status === "active") {
      // Paid up: the site stays online until the end of the period they paid for.
      await userRef(user.uid).set({ plan: { status: "canceling", cancelDate: sub?.canceled_date || null } }, { merge: true });
      logger.info("cancel requested", { uid: user.uid, until: sub?.canceled_date });
      return res.json({ ok: true, until: sub?.canceled_date || null });
    }
    // Not paid (first payment pending, or a payment failed): it ends now, and the unpaid
    // invoice is voided so nobody pays for a plan that's over.
    await userRef(user.uid).set({
      plan: { status: "canceled", cancelDate: null, endedAt: FieldValue.serverTimestamp() },
      launch: { queued: false, nextAt: null, state: "no_plan", error: null },
    }, { merge: true });
    await voidOpenInvoices(plan.subscriptionId).catch((err) => logger.error("open invoice not voided", { uid: user.uid, err: String(err) }));
    if (plan.status === "past_due") await takeOffline(user.uid, "canceled while unpaid", { suspend: "unpaid" });
    logger.info("canceled unpaid plan", { uid: user.uid, was: plan.status });
    res.json({ ok: true, until: null });
  },
};

/** Voids a subscription's unpaid invoices (an unpaid plan was canceled). */
async function voidOpenInvoices(subscriptionId) {
  const sub = (await square("GET", `/v2/subscriptions/${encodeURIComponent(subscriptionId)}`)).subscription;
  for (const id of (sub?.invoice_ids || []).slice(0, 12)) {
    const inv = (await square("GET", `/v2/invoices/${encodeURIComponent(id)}`)).invoice;
    if (["UNPAID", "SCHEDULED", "PARTIALLY_PAID"].includes(inv?.status)) {
      await square("POST", `/v2/invoices/${encodeURIComponent(id)}/cancel`, { version: inv.version });
    }
  }
}

/**
 * Opens a Web Burrito preview the same way the preview page does: with the secret from its
 * personal link (webburrito.com/<slug>/#k=..., see tools/preview_crypto.py) or with the passcode.
 */
async function openPreview(slug, { key, passcode }) {
  const r = await fetch(`${SITE_ORIGIN.value()}/${slug}/`, { redirect: "error" }).catch(() => null);
  const page = r?.ok ? await r.text() : "";
  const m = /<script type="application\/json" id="payload">([\s\S]*?)<\/script>/.exec(page);
  if (!m) throw new UserError(404, "We couldn't find that preview. Check the link.");
  let P;
  try { P = JSON.parse(m[1]); } catch { throw new UserError(404, "We couldn't find that preview. Check the link."); }
  const b = (s) => Buffer.from(String(s), "base64");
  const subtle = webcrypto.subtle;
  let html;
  try {
    let pageKey;
    if (key) {
      if (!/^[A-Za-z0-9_-]{22}$/.test(key) || !P.lk?.iv || !P.lk?.ct) throw new Error("no link");
      const lk = await subtle.importKey("raw", await subtle.digest("SHA-256", Buffer.from(key, "base64url")), "AES-GCM", false, ["decrypt"]);
      const raw = await subtle.decrypt({ name: "AES-GCM", iv: b(P.lk.iv) }, lk, b(P.lk.ct));
      pageKey = await subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
    } else {
      const base = await subtle.importKey("raw", new TextEncoder().encode(passcode), "PBKDF2", false, ["deriveKey"]);
      pageKey = await subtle.deriveKey({ name: "PBKDF2", salt: b(P.salt), iterations: Math.min(Number(P.iter) || 0, 2_000_000), hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    }
    let buf = Buffer.from(await subtle.decrypt({ name: "AES-GCM", iv: b(P.iv) }, pageKey, b(P.ct)));
    if (P.z === "gz") buf = gunzipSync(buf, { maxOutputLength: 2_000_000 });
    html = buf.toString("utf8");
  } catch {
    throw new UserError(400, key ? "That link didn't open the preview. Open it from the email we sent, or type the passcode." : "That passcode didn't work.");
  }
  const page2 = cleanHtml(html);
  if (!page2) throw new UserError(400, "Couldn't read that preview.");
  return page2;
}

async function saveDraft(uid, html, source, previous) {
  const clean = sanitizeHtml(html);
  if (!pageFits(clean)) throw new UserError(413, "That page is too big. Ask for a simpler page.");
  const prev = previous === undefined ? (await draftRef(uid).get()).data() : previous;
  if (prev?.html) await userRef(uid).collection("site").doc("previous").set(prev);
  const hash = pageHash(clean);
  await draftRef(uid).set({ html: clean, hash, source, updatedAt: FieldValue.serverTimestamp(), version: FieldValue.increment(1) }, { merge: true });
  return { hash };
}

/**
 * The polish pass for a claimed preview, cached per preview (and its content), with a cap per
 * account and a shared daily cap. Returns { html, polished }; on any problem the page as cleaned.
 */
async function polishOnce(uid, slug, cleaned) {
  const ref = db.collection("polishCache").doc(slug);
  const key = shortHash(cleaned);
  const cached = (await ref.get()).data();
  if (cached?.key === key && cached.html) return { html: cached.html, polished: true };
  try {
    await rateLimit(uid, "polish", 5, 86400);
  } catch {
    return { html: cleaned, polished: false };
  }
  if (!(await reserveDaily("polish", 300))) return { html: cleaned, polished: false };
  try {
    const html = await polishClaim(cleaned);
    if (!html) return { html: cleaned, polished: false };
    if (PREVIEW_WORDING.test(html.replace(/<style[\s\S]*?<\/style>/gi, ""))) {
      logger.warn("preview wording left after polish", { slug }); // not cached: the next claim tries again
    } else {
      await ref.set({ key, html, at: FieldValue.serverTimestamp() });
    }
    return { html, polished: true };
  } catch (err) {
    logger.warn("claim polish skipped", { uid, slug, err: String(err) });
    return { html: cleaned, polished: false };
  }
}

/** A shared daily allowance (cost guard): true if there's room left today, and counts one. */
async function reserveDaily(key, max) {
  const ref = db.collection("usage").doc(dayKey());
  return db.runTransaction(async (tx) => {
    const n = (await tx.get(ref)).get(key) || 0;
    if (n >= max) return false;
    tx.set(ref, { [key]: FieldValue.increment(1) }, { merge: true });
    return true;
  });
}

// Free tries before paying, then a monthly allowance by plan. Counted before the build runs,
// and only one build at a time per customer.
async function reserveBuild(uid) {
  const usage = db.collection("usage").doc(dayKey());
  return db.runTransaction(async (tx) => {
    const ref = userRef(uid);
    const u = (await tx.get(ref)).data() || {};
    const day = (await tx.get(usage)).data() || {};
    const running = u.builds?.running?.toMillis?.() || 0;
    if (running > Date.now() - 6 * 60e3) throw new UserError(409, "Still working on your last request. It takes about a minute.");
    if (isPaid(u)) {
      const month = monthKey();
      const used = u.builds?.month === month ? u.builds.monthCount || 0 : 0;
      const limit = PLANS[u.plan.id]?.editsPerMonth || 20;
      if (used >= limit) throw new UserError(429, `You've used this month's ${limit} AI changes. Text (310) 279-8278 for more.`);
      tx.set(ref, { builds: { month, monthCount: used + 1, running: new Date() } }, { merge: true });
      return { kind: "month", left: limit - used - 1 };
    }
    const used = u.builds?.free || 0;
    const limit = FREE_BUILDS.value();
    if (used >= limit) throw new UserError(402, `You've used your ${limit} free tries. Pick a plan to keep building.`);
    if ((day.free || 0) >= FREE_BUILDS_PER_DAY_TOTAL.value()) throw new UserError(429, "The builder is very busy today. Try again tomorrow, or text (310) 279-8278.");
    tx.set(ref, { builds: { free: used + 1, running: new Date() } }, { merge: true });
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
// Only quick work happens here (Square wants an answer within about 10 seconds); the launch
// itself is queued for the launcher job and the customer's page.
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
  let status = 200;
  try {
    status = (await onSquareEvent(ev)) || 200;
  } catch (err) {
    logger.error("webhook failed", { type: ev.type, err: String(err) });
    status = 500;
  }
  if (status !== 200) await seen.delete(); // let Square send it again
  res.status(status).send("");
}

/** The customer for a subscription; retry (503) if it's ours but not saved yet. */
async function ownerOf(subscriptionId) {
  if (!subscriptionId) return { skip: true };
  const uid = (await db.collection("subIndex").doc(String(subscriptionId)).get()).get("uid");
  if (uid) return { uid };
  let sub;
  try {
    sub = (await square("GET", `/v2/subscriptions/${encodeURIComponent(subscriptionId)}`)).subscription;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return { skip: true };
    return { retry: true }; // Square didn't answer: ask it to send the event again
  }
  const cfg = (await configRef().get()).data() || {};
  const ours = new Set(Object.values(cfg.plans?.[env()] || {}).flatMap((p) => [p.monthly, p.yearly]));
  if (!ours.has(sub?.plan_variation_id)) return { skip: true }; // other Square subscriptions aren't ours
  // Ours but not saved yet (the checkout is still finishing): retry for an hour, then flag it.
  if (Date.now() - Date.parse(sub.created_at || 0) < 3600e3) return { retry: true };
  logger.error("subscription with no account", { subscriptionId, customerId: sub.customer_id });
  await db.collection("orphans").doc(String(subscriptionId)).set({ customerId: sub.customer_id || null, at: FieldValue.serverTimestamp() }, { merge: true });
  return { skip: true };
}

/**
 * Who a payment belongs to, and whether it paid for their current subscription (so a refund
 * or chargeback on something else doesn't take their site down). Throws if Square can't answer.
 */
async function ownerOfPayment(paymentId) {
  if (!paymentId) return {};
  const payment = (await square("GET", `/v2/payments/${encodeURIComponent(paymentId)}`)).payment;
  let customerId = payment?.customer_id;
  if (!customerId && payment?.order_id) {
    // Some payments only name the customer on their order.
    const order = await square("GET", `/v2/orders/${encodeURIComponent(payment.order_id)}`).catch((err) => {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    });
    customerId = order?.order?.customer_id;
  }
  if (!customerId) return { payment };
  const uid = (await db.collection("customerIndex").doc(customerKey(customerId)).get()).get("uid");
  if (!uid) return { payment };
  const plan = currentPlan(await getUser(uid));
  if (!plan?.subscriptionId || !payment.order_id) return { uid, payment, current: false };
  const found = await square("POST", "/v2/invoices/search", {
    query: { filter: { location_ids: [SQUARE_LOCATION_ID.value()], customer_ids: [customerId] }, sort: { field: "INVOICE_SORT_DATE", order: "DESC" } },
    limit: 100,
  });
  const inv = (found.invoices || []).find((i) => i.order_id === payment.order_id);
  return { uid, payment, current: Boolean(inv) && inv.subscription_id === plan.subscriptionId };
}

async function onSquareEvent(ev) {
  const obj = ev.data?.object || {};
  if (ev.type === "invoice.payment_made" || ev.type === "invoice.scheduled_charge_failed") {
    const inv = obj.invoice || {};
    const who = await ownerOf(inv.subscription_id);
    if (who.retry) return 503;
    if (!who.uid) return 200;
    const u = await getUser(who.uid);
    const plan = currentPlan(u);
    if (plan?.subscriptionId !== inv.subscription_id) return 200; // an older subscription
    if (ev.type === "invoice.payment_made") {
      const took = await markPaid(who.uid, inv.subscription_id, inv.id);
      // Paid after the plan ended (say an invoice that couldn't be voided): flag it for a refund.
      if (!took && ENDED_STATUSES.includes(plan.status)) {
        await userRef(who.uid).set({ flags: { paidAfterEndAt: FieldValue.serverTimestamp(), paidAfterEndInvoice: text(inv.id, 100) } }, { merge: true });
        logger.error("payment after the plan ended", { uid: who.uid, invoice: inv.id });
      }
    } else if (plan.status === "active") {
      await userRef(who.uid).set({ plan: { status: "past_due", pastDueSince: plan.pastDueSince || FieldValue.serverTimestamp() } }, { merge: true });
    } else if (plan.status === "pending_payment" && !plan.paid) {
      await userRef(who.uid).set({ plan: { firstChargeFailedAt: plan.firstChargeFailedAt || FieldValue.serverTimestamp() } }, { merge: true });
      await queue(who.uid); // shows "payment failed" and keeps checking for a late payment
    }
  } else if (ev.type === "subscription.updated" || ev.type === "subscription.created") {
    const sub = obj.subscription || {};
    const who = await ownerOf(sub.id);
    if (who.retry) return 503;
    if (!who.uid) return 200;
    const u = await getUser(who.uid);
    const plan = currentPlan(u);
    if (plan?.subscriptionId !== sub.id) return 200;
    if (["CANCELED", "DEACTIVATED"].includes(sub.status) && !ENDED_STATUSES.includes(plan.status)) {
      await userRef(who.uid).set({ plan: { status: "canceled", endedAt: FieldValue.serverTimestamp() }, launch: { queued: false, nextAt: null } }, { merge: true });
      await takeOffline(who.uid, "plan ended");
    } else if (sub.status === "PAUSED" && plan.status !== "paused") {
      await userRef(who.uid).set({ plan: { status: "paused", statusBefore: plan.status } }, { merge: true });
      await takeOffline(who.uid, "paused");
    } else if (sub.status === "ACTIVE" && plan.status === "paused") {
      await userRef(who.uid).set({ plan: { status: plan.statusBefore || "active" } }, { merge: true });
      await queue(who.uid);
    }
  } else if (ev.type === "refund.updated" || ev.type === "refund.created") {
    const refund = obj.refund || {};
    if (refund.status !== "COMPLETED") return 200;
    let who;
    try {
      who = await ownerOfPayment(refund.payment_id);
    } catch (err) {
      logger.warn("refund lookup failed", { err: String(err) });
      return 503;
    }
    if (!who.uid) return 200;
    if (!who.current) {
      // A refund on something other than the current plan: note it for Web Burrito, change nothing.
      await userRef(who.uid).set({ flags: { otherRefundAt: FieldValue.serverTimestamp() } }, { merge: true });
      return 200;
    }
    const paid = Number(who.payment?.amount_money?.amount || 0);
    const back = Math.max(Number(refund.amount_money?.amount || 0), Number(who.payment?.refunded_money?.amount || 0));
    if (!paid || back < paid) {
      await userRef(who.uid).set({ plan: { partialRefundAt: FieldValue.serverTimestamp() } }, { merge: true });
      return 200;
    }
    await endForMoney(who.uid, "refunded");
  } else if (ev.type === "dispute.created") {
    let who;
    try {
      who = await ownerOfPayment(obj.dispute?.disputed_payment?.payment_id || obj.dispute?.payment_id);
    } catch (err) {
      logger.warn("dispute lookup failed", { err: String(err) });
      return 503;
    }
    if (!who.uid) return 200;
    if (who.current) await endForMoney(who.uid, "disputed");
    else await userRef(who.uid).set({ flags: { otherDisputeAt: FieldValue.serverTimestamp() } }, { merge: true });
  }
  return 200;
}

/** Refund or chargeback: stop the subscription and take the site down. */
async function endForMoney(uid, why) {
  const u = await getUser(uid);
  const plan = currentPlan(u);
  if (plan?.subscriptionId && !ENDED_STATUSES.includes(plan.status)) {
    await square("POST", `/v2/subscriptions/${encodeURIComponent(plan.subscriptionId)}/cancel`, {}).catch((err) => logger.warn("cancel after refund failed", { uid, err: String(err) }));
  }
  await userRef(uid).set({ plan: { status: why, endedAt: FieldValue.serverTimestamp() }, launch: { queued: false, nextAt: null } }, { merge: true });
  await takeOffline(uid, why, { suspend: why });
}

// ---------- admin ----------
const ADMIN = {
  async "/admin/setup-square"(user, body, res) {
    res.json({ ok: true, ...(await setupSquarePlans()) });
  },

  async "/admin/setup-hosting"(user, body, res) {
    res.json({ ok: true, ...(await setupHosting()) });
  },

  async "/admin/retry"(user, body, res) {
    const uid = text(body.uid, 128);
    if (!uid) throw new UserError(400, "Which customer?");
    // A preview claimed with the passcode waits for this: the admin has checked it's the owner.
    const u = await getUser(uid);
    if (u.claim?.verified === false) {
      await userRef(uid).set({ claim: { verified: true, approvedBy: user.email, approvedAt: FieldValue.serverTimestamp() } }, { merge: true });
    }
    res.json({ ok: true, state: await advance(uid, `admin ${user.email}`, { approveDomain: true }) });
  },

  async "/admin/offline"(user, body, res) {
    const uid = text(body.uid, 128);
    if (!uid) throw new UserError(400, "Which customer?");
    await takeOffline(uid, `admin ${user.email}`, { suspend: "admin" });
    res.json({ ok: true });
  },

  async "/admin/restore"(user, body, res) {
    const uid = text(body.uid, 128);
    if (!uid) throw new UserError(400, "Which customer?");
    await restore(uid);
    res.json({ ok: true, state: await advance(uid, `restored by ${user.email}`) });
  },

  async "/admin/tick"(user, body, res) {
    res.json({ ok: true, ...(await tick({ budgetMs: 45_000 })) });
  },
};
