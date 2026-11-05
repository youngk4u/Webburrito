// Cloud Functions for webburrito.com.
//
// api  ->  served at https://webburrito.com/api/* through the Hosting rewrite in firebase.json.
//   POST /api/track   beacon from the passcode gate on every preview page
//   GET  /api/ping    health check ("ok")
//
// Data written (read it on /admin/):
//   previews/{slug}                     totals per preview: opens, visitors, visits, wrong passcodes, time
//   previews/{slug}/visitors/{visitor}  one doc per device that opened the link (for unique counts)
//   visits/{slug}_{session}             one doc per browser-tab session: device, app, when, how long
// Visits from your own devices (flagged "internal" by /admin/) are kept in visits/ but
// left out of the totals.

import { onRequest } from "firebase-functions/https";
import { setGlobalOptions } from "firebase-functions/options";
import { logger } from "firebase-functions";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { parseEvent, isBot, describeUA, language } from "./track.js";

// maxInstances caps cost if someone floods the endpoint.
setGlobalOptions({ region: "us-central1", maxInstances: 3 });

initializeApp();
const db = getFirestore();

export const api = onRequest({ timeoutSeconds: 30 }, async (req, res) => {
  res.set("Cache-Control", "no-store");
  const path = req.path.replace(/^\/api(?=\/)/, "");

  if (path === "/ping") {
    res.status(200).send("ok");
    return;
  }
  if (path !== "/track") {
    res.status(404).send("Not found");
    return;
  }
  if (req.method !== "POST") {
    res.set("Allow", "POST").status(405).send("");
    return;
  }

  const ua = String(req.get("user-agent") || "").slice(0, 400);
  const event = parseEvent(readBody(req));
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

// sendBeacon posts text/plain; fetch() may post JSON. Accept both, max 2 KB.
function readBody(req) {
  const raw = req.rawBody;
  if (raw && raw.length > 2048) return null;
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

  await db.runTransaction(async (tx) => {
    const [visitSnap, visitorSnap, previewSnap] = await tx.getAll(visitRef, visitorRef, previewRef);
    const visit = visitSnap.exists ? visitSnap.data() : null;
    const preview = previewSnap.exists ? previewSnap.data() : null;

    const v = { lastSeenAt: now }; // changes to the visit doc
    const p = {}; // changes to the preview totals

    if (!visit) {
      Object.assign(v, {
        slug: e.slug,
        visitor: e.visitor,
        session: e.session,
        internal: e.internal,
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
      if (!e.internal) {
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
    if (!e.internal) {
      p.slug = e.slug;
      p.lastSeenAt = now;
      if (!preview) p.firstSeenAt = now;
      tx.set(previewRef, p, { merge: true });
    }
  });
}
