// Cloud Functions for webburrito.com.
//
// api  ->  served at https://webburrito.com/api/* through the Hosting rewrite in firebase.json.
//   POST /api/track   beacon from the passcode gate on every preview page
//   POST /api/lead    "Free preview" form on the home page
//   POST /api/mine    admins only: "That was me" / "Not me" on a visit in /admin/
//   GET  /api/ping    health check ("ok")
//
// Data written (read it on /admin/):
//   previews/{slug}                     totals per preview: opens, visitors, visits, wrong passcodes, time
//   previews/{slug}/visitors/{visitor}  one doc per device that opened the link (for unique counts)
//   visits/{slug}_{session}             one doc per browser-tab session: device, app, when, how long
//   leads/{id}                          one doc per "Free preview" request (status: new | done)
//   mine/{visitor}                      browsers an admin marked as their own
// Visits from your own devices (flagged "internal" by /admin/, or from a browser in mine/)
// are kept in visits/ but left out of the totals.

import { onRequest } from "firebase-functions/https";
import { setGlobalOptions } from "firebase-functions/options";
import { logger } from "firebase-functions";
import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { parseEvent, parseMine, summarize, isBot, describeUA, language } from "./track.js";
import { parseLead } from "./lead.js";

// maxInstances caps cost if someone floods the endpoint.
setGlobalOptions({ region: "us-central1", maxInstances: 3 });

if (!getApps().length) initializeApp();
const db = getFirestore();
const auth = getAuth();

// The customer platform (webburrito.com/app/): accounts, AI builder, payments, domains, launch.
// Both functions are left out of deploys until PLATFORM=on in functions/.env (functions/app/config.js).
export { app, launcher } from "./app/index.js";

// invoker "public": the website (through Firebase Hosting) calls this without signing in,
// so anyone must be allowed to invoke it. Every request is validated below.
export const api = onRequest({ timeoutSeconds: 30, invoker: "public" }, async (req, res) => {
  res.set("Cache-Control", "no-store");
  const path = req.path.replace(/^\/api(?=\/)/, "");

  if (path === "/ping") {
    res.status(200).send("ok");
    return;
  }
  if (path !== "/track" && path !== "/lead" && path !== "/mine") {
    res.status(404).send("Not found");
    return;
  }
  if (req.method !== "POST") {
    res.set("Allow", "POST").status(405).send("");
    return;
  }

  const ua = String(req.get("user-agent") || "").slice(0, 400);
  if (path === "/lead") {
    await saveLead(req, res, ua);
    return;
  }
  if (path === "/mine") {
    await setMine(req, res);
    return;
  }
  const event = parseEvent(readBody(req, 2048));
  if (!event || isBot(ua)) {
    res.status(204).send(""); // ignore quietly; nothing for a bot or bad client to learn
    return;
  }

  try {
    await record(event, { ...describeUA(ua), lang: language(req.get("accept-language")), ua });
    res.status(204).send("");
  } catch (err) {
    logger.error("track failed", { slug: event.slug, event: event.event, err: String(err) });
    res.status(500).send("");
  }
});

// The home page form. Every request that passes validation is saved (no bot filter
// here, so a real customer is never dropped); the hidden honeypot field catches bots.
async function saveLead(req, res, ua) {
  const parsed = parseLead(readBody(req, 16384));
  if (!parsed) {
    res.status(400).json({ ok: false });
    return;
  }
  if (parsed.spam) {
    res.status(200).json({ ok: true }); // look successful so the bot moves on
    return;
  }
  try {
    const ref = await db.collection("leads").add({
      ...parsed.lead,
      ...describeUA(ua),
      lang: language(req.get("accept-language")),
      ua,
      status: "new",
      createdAt: FieldValue.serverTimestamp(),
    });
    logger.info("new lead", { id: ref.id, business: parsed.lead.business });
    res.status(200).json({ ok: true });
  } catch (err) {
    logger.error("lead failed", { err: String(err) });
    res.status(500).json({ ok: false });
  }
}

// "That was me" (mine: true) or "Not me" (mine: false) on a visit in /admin/. Marks every
// visit from that browser, remembers the browser so its future visits are marked too, and
// recounts the totals of the previews it visited. Only signed-in admins can call it.
async function setMine(req, res) {
  const body = parseMine(readBody(req, 8192));
  if (!body) {
    res.status(400).json({ ok: false });
    return;
  }
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.get("authorization") || "");
  const email = await adminEmail(body.token || bearer?.[1]);
  if (!email) {
    res.status(403).json({ ok: false });
    return;
  }
  try {
    const { visitor, mine } = body;
    const mineRef = db.collection("mine").doc(visitor);
    if (mine) await mineRef.set({ by: email, at: FieldValue.serverTimestamp() });
    else await mineRef.delete();

    const snap = await db.collection("visits").where("visitor", "==", visitor).get();
    const slugs = new Set();
    let writer = db.batch(), pending = 0, changed = 0;
    for (const d of snap.docs) {
      if ((d.get("internal") === true) === mine) continue;
      writer.update(d.ref, { internal: mine });
      slugs.add(d.get("slug"));
      changed += 1;
      if (++pending === 400) {
        await writer.commit();
        writer = db.batch();
        pending = 0;
      }
    }
    if (pending) await writer.commit();
    for (const slug of slugs) await recount(slug);
    logger.info("mine updated", { visitor, mine, by: email, visits: changed, previews: slugs.size });
    res.status(200).json({ ok: true, visits: changed, previews: slugs.size });
  } catch (err) {
    logger.error("mine failed", { err: String(err) });
    res.status(500).json({ ok: false });
  }
}

// The admin's email if `token` is a valid Firebase ID token of a verified admin, else null.
async function adminEmail(token) {
  if (!token) return null;
  try {
    const t = await auth.verifyIdToken(token);
    const email = String(t.email || "").toLowerCase();
    if (!email || t.email_verified !== true) return null;
    return (await db.collection("admins").doc(email).get()).exists ? email : null;
  } catch {
    return null;
  }
}

// Rebuilds previews/{slug} and its visitors/ docs from the visits that still count.
async function recount(slug) {
  if (typeof slug !== "string" || !slug) return;
  const previewRef = db.collection("previews").doc(slug);
  await db.runTransaction(async (tx) => {
    const visitsSnap = await tx.get(db.collection("visits").where("slug", "==", slug));
    const peopleSnap = await tx.get(previewRef.collection("visitors"));
    const sum = summarize(visitsSnap.docs.map((d) => d.data()));
    const keep = new Set(sum ? Object.keys(sum.visitors) : []);
    for (const d of peopleSnap.docs) if (!keep.has(d.id)) tx.delete(d.ref);
    if (!sum) {
      tx.delete(previewRef);
      return;
    }
    tx.set(previewRef, { slug, ...sum.totals });
    for (const [id, w] of Object.entries(sum.visitors)) tx.set(previewRef.collection("visitors").doc(id), w);
  });
}

// sendBeacon posts text/plain; fetch() may post JSON. Accept both, up to `max` bytes.
function readBody(req, max) {
  const raw = req.rawBody;
  if (raw && raw.length > max) return null;
  try {
    if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) && !raw) return req.body;
    const text = raw ? raw.toString("utf8") : typeof req.body === "string" ? req.body : "";
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function record(e, meta) {
  const now = FieldValue.serverTimestamp();
  const inc = FieldValue.increment;
  const previewRef = db.collection("previews").doc(e.slug);
  const visitorRef = previewRef.collection("visitors").doc(e.visitor);
  const visitRef = db.collection("visits").doc(`${e.slug}_${e.session}`);
  const mineRef = db.collection("mine").doc(e.visitor);

  await db.runTransaction(async (tx) => {
    const [visitSnap, visitorSnap, previewSnap, mineSnap] = await tx.getAll(visitRef, visitorRef, previewRef, mineRef);
    const visit = visitSnap.exists ? visitSnap.data() : null;
    const preview = previewSnap.exists ? previewSnap.data() : null;
    // Whether this visit is yours is settled when it starts (or later with "That was me"),
    // so its totals stay consistent for the rest of the visit.
    const internal = visit ? visit.internal === true : e.internal || mineSnap.exists;

    const v = { lastSeenAt: now }; // changes to the visit doc
    const p = {}; // changes to the preview totals

    if (!visit) {
      Object.assign(v, {
        slug: e.slug,
        visitor: e.visitor,
        session: e.session,
        internal,
        startedAt: now,
        device: meta.device,
        browser: meta.browser,
        app: meta.app,
        lang: meta.lang,
        ua: meta.ua,
        tz: e.tz,
        ref: e.ref,
        referrer: e.referrer,
        loads: 0,
        failedTries: 0,
        unlocked: false,
        seconds: 0,
        scroll: 0,
      });
      p.visits = inc(1);
      if (!internal) {
        const who = { lastSeenAt: now, visits: inc(1), device: meta.device, browser: meta.browser, app: meta.app };
        if (!visitorSnap.exists) {
          who.firstSeenAt = now;
          p.visitors = inc(1);
        }
        tx.set(visitorRef, who, { merge: true });
      }
    }

    switch (e.event) {
      case "load":
        v.loads = inc(1);
        break;
      case "fail":
        v.failedTries = inc(1);
        p.failedTries = inc(1);
        break;
      case "unlock":
        if (!visit?.unlocked) {
          v.unlocked = true;
          v.unlockedAt = now;
          p.opens = inc(1);
          p.lastOpenedAt = now;
          if (!preview?.firstOpenedAt) p.firstOpenedAt = now;
        }
        break;
      case "time": {
        const before = visit?.seconds || 0;
        if (e.seconds > before) {
          v.seconds = e.seconds;
          p.seconds = inc(e.seconds - before);
        }
        if (e.scroll > (visit?.scroll || 0)) v.scroll = e.scroll;
        break;
      }
    }

    tx.set(visitRef, v, { merge: true });
    if (!internal) {
      p.slug = e.slug;
      p.lastSeenAt = now;
      if (!preview) p.firstSeenAt = now;
      tx.set(previewRef, p, { merge: true });
    }
  });
}
