// Pure helpers for /api/track (no Firebase imports, so they're easy to unit test).

// "claim": they tapped "Make it mine" on the preview (the strongest buying signal).
export const EVENTS = new Set(["load", "fail", "unlock", "time", "claim"]);

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ID = /^[A-Za-z0-9_-]{8,40}$/;
const REF = /^[A-Za-z0-9_.-]{1,40}$/;
const TZ = /^[A-Za-z0-9_/+-]{1,50}$/;
const RESERVED = new Set(["api", "admin", "assets", "img", "brand", "guides", "industries", "tools", "functions"]);

// Link unfurlers (iMessage, WhatsApp, Slack...) don't run JavaScript, so they never get
// here. This catches the few crawlers and test tools that do.
const BOT = /bot\b|bot\/|crawl|spider|slurp|facebookexternalhit|headless|lighthouse|pagespeed|pingdom|uptime|monitor|curl\/|wget|python-requests/i;

export const MAX_SECONDS = 4 * 60 * 60;

/** Validates the beacon body. Returns a clean object, or null if it should be ignored. */
export function parseEvent(body) {
  if (!body || typeof body !== "object") return null;
  const { event, slug, visitor, session } = body;
  if (!EVENTS.has(event)) return null;
  if (typeof slug !== "string" || slug.length > 80 || !SLUG.test(slug) || RESERVED.has(slug)) return null;
  if (typeof visitor !== "string" || !ID.test(visitor)) return null;
  if (typeof session !== "string" || !ID.test(session)) return null;
  return {
    event,
    slug,
    visitor,
    session,
    internal: body.internal === true,
    ref: typeof body.ref === "string" && REF.test(body.ref) ? body.ref : null,
    tz: typeof body.tz === "string" && TZ.test(body.tz) ? body.tz : null,
    referrer: referrerHost(body.referrer),
    seconds: clampInt(body.seconds, 0, MAX_SECONDS),
    scroll: clampInt(body.scroll, 0, 100),
  };
}

function clampInt(n, lo, hi) {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

function referrerHost(r) {
  if (typeof r !== "string" || !r || r.length > 500) return null;
  try {
    const host = new URL(r).hostname.toLowerCase();
    return host && host.length <= 100 ? host : null;
  } catch {
    return null;
  }
}

export function isBot(ua) {
  return !ua || BOT.test(ua);
}

/** First language from Accept-Language, e.g. "es-US". */
export function language(header) {
  const first = String(header || "").split(",")[0].split(";")[0].trim();
  return /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(first) ? first : null;
}

/** Rough, human-readable device / browser / in-app browser from a User-Agent string. */
export function describeUA(ua = "") {
  let app = null;
  if (/Instagram/.test(ua)) app = "Instagram";
  else if (/MessengerForiOS|FBAN\/Messenger|Orca-Android|MessengerLite/.test(ua)) app = "Messenger";
  else if (/FBAN|FBAV|FB_IAB|FBIOS/.test(ua)) app = "Facebook";
  else if (/TikTok|musical_ly|BytedanceWebview/i.test(ua)) app = "TikTok";
  else if (/KAKAOTALK/i.test(ua)) app = "KakaoTalk";
  else if (/\bLine\//.test(ua)) app = "LINE";
  else if (/Snapchat/.test(ua)) app = "Snapchat";
  else if (/LinkedInApp/.test(ua)) app = "LinkedIn";
  else if (/\bGSA\//.test(ua)) app = "Google app";

  let device = "Other";
  if (/iPad/.test(ua)) device = "iPad";
  else if (/iPhone|iPod/.test(ua)) device = "iPhone";
  else if (/Android/.test(ua)) device = /Mobile/.test(ua) ? "Android phone" : "Android tablet";
  else if (/CrOS/.test(ua)) device = "Chromebook";
  else if (/Macintosh|Mac OS X/.test(ua)) device = "Mac";
  else if (/Windows/.test(ua)) device = "Windows PC";
  else if (/Linux/.test(ua)) device = "Linux PC";

  let browser = "Other";
  if (/EdgA?\/|EdgiOS\//.test(ua)) browser = "Edge";
  else if (/SamsungBrowser\//.test(ua)) browser = "Samsung Internet";
  else if (/OPR\/|Opera/.test(ua)) browser = "Opera";
  else if (/FxiOS\/|Firefox\//.test(ua)) browser = "Firefox";
  else if (/CriOS\/|Chrome\//.test(ua)) browser = "Chrome";
  else if (/Safari\//.test(ua) || /AppleWebKit/.test(ua)) browser = "Safari";

  return { device, browser, app };
}

/** Validates a POST /api/mine body: { visitor, mine, token }. */
export function parseMine(body) {
  if (!body || typeof body !== "object") return null;
  const { visitor, mine, token } = body;
  if (typeof visitor !== "string" || !ID.test(visitor) || typeof mine !== "boolean") return null;
  return { visitor, mine, token: typeof token === "string" && token.length <= 4096 ? token : null };
}

// Firestore Timestamps (and Dates or numbers, for tests) as milliseconds.
const ms = (t) => (t == null ? null : typeof t.toMillis === "function" ? t.toMillis() : t instanceof Date ? t.getTime() : typeof t === "number" ? t : null);
const earlier = (a, b) => (ms(b) != null && (ms(a) == null || ms(b) < ms(a)) ? b : a);
const later = (a, b) => (ms(b) != null && (ms(a) == null || ms(b) > ms(a)) ? b : a);

/**
 * Rebuilds one preview's totals and its per-device docs from its visit docs, skipping
 * visits marked as yours. Used after visits are marked (or unmarked) as yours, so the
 * counts match what record() would have produced if they'd been marked from the start.
 * Returns { totals, visitors } or null when no countable visits are left.
 */
export function summarize(visits) {
  const totals = { visits: 0, visitors: 0, opens: 0, failedTries: 0, seconds: 0, claims: 0 };
  let firstSeenAt = null, lastSeenAt = null, firstOpenedAt = null, lastOpenedAt = null, lastClaimAt = null;
  const visitors = {};
  for (const v of visits) {
    if (!v || v.internal === true) continue;
    totals.visits += 1;
    totals.failedTries += v.failedTries || 0;
    totals.seconds += v.seconds || 0;
    if (v.unlocked) {
      totals.opens += 1;
      firstOpenedAt = earlier(firstOpenedAt, v.unlockedAt);
      lastOpenedAt = later(lastOpenedAt, v.unlockedAt);
    }
    if (v.claimed) {
      totals.claims += 1;
      lastClaimAt = later(lastClaimAt, v.claimedAt);
    }
    firstSeenAt = earlier(firstSeenAt, v.startedAt);
    lastSeenAt = later(lastSeenAt, v.lastSeenAt);
    if (!v.visitor) continue;
    const w = visitors[v.visitor];
    if (!w) {
      visitors[v.visitor] = { visits: 1, firstSeenAt: v.startedAt ?? null, lastSeenAt: v.lastSeenAt ?? null, device: v.device ?? null, browser: v.browser ?? null, app: v.app ?? null };
    } else {
      w.visits += 1;
      w.firstSeenAt = earlier(w.firstSeenAt, v.startedAt);
      if (later(w.lastSeenAt, v.lastSeenAt) !== w.lastSeenAt) {
        Object.assign(w, { lastSeenAt: v.lastSeenAt, device: v.device ?? null, browser: v.browser ?? null, app: v.app ?? null });
      }
    }
  }
  if (!totals.visits) return null;
  totals.visitors = Object.keys(visitors).length;
  for (const [k, t] of Object.entries({ firstSeenAt, lastSeenAt, firstOpenedAt, lastOpenedAt, lastClaimAt })) if (t != null) totals[k] = t;
  return { totals, visitors };
}
