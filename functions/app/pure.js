// Pure helpers for the customer platform (no Firebase or network), so they're easy to test.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import sanitize from "sanitize-html";

// Plans and prices, matching webburrito.com. Prices in cents.
export const PLANS = {
  regular: { name: "The Regular", monthly: 2000, yearly: 19900, emails: 0, editsPerMonth: 20 },
  super: { name: "The Super", monthly: 3500, yearly: 34900, emails: 3, editsPerMonth: 40 },
  loaded: { name: "The Loaded", monthly: 6900, yearly: 69900, emails: 10, editsPerMonth: 100 },
};
export const BILLING = ["monthly", "yearly"];
export const ALLOWED_TLDS = ["com", "net", "org", "us", "co", "shop", "biz"];

/** Trimmed text without control characters, cut to `max`. Non-strings become "". */
export function text(v, max) {
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, max);
}

/** The business details a customer fills in. Only `business` is required. */
export function parseProfile(b) {
  if (!b || typeof b !== "object") return null;
  const p = {
    business: text(b.business, 120),
    type: text(b.type, 80),
    city: text(b.city, 80),
    address: text(b.address, 200),
    phone: text(b.phone, 40),
    email: text(b.email, 120),
    hours: text(b.hours, 400),
    about: text(b.about, 2000),
    services: text(b.services, 2000),
    language: text(b.language, 40),
  };
  return p.business ? p : null;
}

const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[A-Za-z]{2,}$/;
export const isEmail = (s) => typeof s === "string" && s.length <= 120 && EMAIL.test(s);

/** Phone in the registrar's +1.5555555555 form, or null. US/Canada numbers only for now. */
export function registrarPhone(s) {
  const d = String(s || "").replace(/\D/g, "");
  const ten = d.length === 11 && d[0] === "1" ? d.slice(1) : d;
  return ten.length === 10 ? `+1.${ten}` : null;
}

/** Domain owner contact for the registration (ICANN requires a real one). */
export function parseContact(b) {
  if (!b || typeof b !== "object") return null;
  const c = {
    first: text(b.first, 60),
    last: text(b.last, 60),
    org: text(b.org, 120),
    email: text(b.email, 120),
    phone: text(b.phone, 40),
    street: text(b.street, 120),
    city: text(b.city, 80),
    state: text(b.state, 40).toUpperCase(),
    zip: text(b.zip, 10),
  };
  if (!c.first || !c.last || !isEmail(c.email) || !registrarPhone(c.phone)) return null;
  if (!c.street || !c.city || !/^[A-Z]{2}$/.test(c.state) || !/^\d{5}(-\d{4})?$/.test(c.zip)) return null;
  return c;
}

export function registrantFor(c) {
  return {
    email: c.email,
    phone: registrarPhone(c.phone),
    postal_info: {
      name: `${c.first} ${c.last}`,
      ...(c.org ? { organization: c.org } : {}),
      address: { street: c.street, city: c.city, state: c.state, postal_code: c.zip, country_code: "US" },
    },
  };
}

/** Lowercase domain like "rosasbakery.com", or null. One label + an allowed extension. */
export function parseDomain(s) {
  const d = String(s || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  const m = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.([a-z]{2,10})$/.exec(d);
  if (!m || m[1].includes("--") || !ALLOWED_TLDS.includes(m[2])) return null;
  return d;
}

/** Whether a Cloudflare domain-check entry may be bought automatically. */
export function domainBuyable(entry, maxPrice) {
  if (!entry || entry.registrable !== true) return { ok: false, why: entry?.reason || "not available" };
  if (entry.tier && entry.tier !== "standard") return { ok: false, why: "premium domain" };
  const cost = Number(entry.pricing?.registration_cost);
  const renew = Number(entry.pricing?.renewal_cost);
  if (entry.pricing?.currency && entry.pricing.currency !== "USD") return { ok: false, why: "not priced in USD" };
  if (!Number.isFinite(cost) || cost <= 0 || cost > maxPrice) return { ok: false, why: "price over the limit" };
  if (Number.isFinite(renew) && renew > maxPrice) return { ok: false, why: "renewal price over the limit" };
  return { ok: true, cost, renew: Number.isFinite(renew) ? renew : null };
}

/** Square webhook check: base64(HMAC-SHA256(key, notificationUrl + rawBody)). */
export function squareSignatureOk(signature, key, url, rawBody) {
  if (!signature || !key || !url || rawBody == null) return false;
  const want = createHmac("sha256", key).update(url + rawBody).digest("base64");
  const a = Buffer.from(String(signature)), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The HTML Claude returned, without code fences; null if it isn't a whole page. */
export function cleanHtml(out) {
  if (typeof out !== "string") return null;
  let s = out.trim();
  const fence = /```(?:html)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  const start = s.search(/<!doctype html|<html[\s>]/i);
  if (start < 0) return null;
  s = s.slice(start);
  const end = s.toLowerCase().lastIndexOf("</html>");
  if (end < 0) return null;
  s = s.slice(0, end + 7);
  if (!/^<!doctype/i.test(s)) s = "<!doctype html>\n" + s;
  return pageFits(s) ? s : null;
}

/** Pages must fit in one Firestore document (1 MiB) with room to spare. */
export const MAX_PAGE_CHARS = 300_000;
export const pageFits = (s) => typeof s === "string" && s.length <= MAX_PAGE_CHARS && Buffer.byteLength(s, "utf8") <= 900_000;

// Tags that are removed with everything inside them, and the <meta>/<link> kinds that may stay.
const DROP_TAGS = new Set(["script", "iframe", "object", "embed", "applet", "form", "input", "textarea", "select", "base", "frame", "frameset", "portal", "template"]);
const META_NAMES = new Set(["viewport", "description", "theme-color", "robots", "color-scheme", "format-detection", "author"]);
const LINK_RELS = new Set(["stylesheet", "preconnect", "icon", "apple-touch-icon", "shortcut icon", "preload", "dns-prefetch"]);

/**
 * Removes anything a page could use to run code, redirect visitors or collect data: scripts,
 * event handlers, javascript: links, forms and inputs, frames and embeds, <base>, any
 * http-equiv <meta> (refresh redirects), and <link> other than stylesheets/fonts/icons.
 * It parses the HTML (sanitize-html) rather than pattern-matching it, so odd quoting can't
 * hide a tag. Customer sites are also served with script-src 'none' and form-action 'none'.
 */
export function sanitizeHtml(html) {
  const out = sanitize(String(html || ""), {
    allowedTags: false,
    allowedAttributes: false,
    allowVulnerableTags: true, // <style> is allowed on purpose; <script> is dropped below
    allowedSchemes: ["http", "https", "mailto", "tel", "sms"],
    allowedSchemesByTag: { img: ["http", "https", "data"] },
    allowedSchemesAppliedToAttributes: ["href", "src", "cite", "action", "formaction", "poster", "xlink:href", "background"],
    allowProtocolRelative: true,
    exclusiveFilter: (f) =>
      DROP_TAGS.has(f.tag) ||
      (f.tag === "meta" && ("http-equiv" in f.attribs || !("charset" in f.attribs || META_NAMES.has(String(f.attribs.name || "").toLowerCase()) || String(f.attribs.property || "").startsWith("og:")))) ||
      (f.tag === "link" && !LINK_RELS.has(String(f.attribs.rel || "").toLowerCase().trim())),
    transformTags: {
      "*": (tagName, attribs) => ({
        tagName,
        attribs: Object.fromEntries(Object.entries(attribs).filter(([k]) => !/^on/i.test(k) && !["srcdoc", "formaction"].includes(k.toLowerCase()))),
      }),
    },
    // Attribute names are lowercased like a browser does (HREF is href), so every link gets checked;
    // browsers restore SVG names like viewBox themselves.
    parser: { lowerCaseTags: true, lowerCaseAttributeNames: true },
  });
  return /^\s*<html[\s>]/i.test(out) ? `<!doctype html>\n${out.trim()}` : out;
}

// Domains that look like a bank, a big brand, a government office or a sign-in page are
// refused outright, whatever the site says.
const RISKY = /(paypal|venmo|zelle|cashapp|chasebank|chaseonline|chasealert|wellsfargo|bankofamerica|citibank|capitalone|americanexpress|amexcard|coinbase|binance|metamask|microsoft|office365|google|gmail|icloud|appleid|applesupport|applecare|amazon|facebook|instagram|whatsapp|tiktok|netflix|irsgov|irsrefund|irstax|usps|fedex|upsdelivery|medicare|socialsecurity|login|signin|verify|verification|password|accountalert|accountverify|walletconnect|refundcenter|support24)/;
export function riskyDomain(d) {
  const label = String(d || "").toLowerCase().split(".")[0];
  // Read hyphens and look-alike digits the way a person would: "paypa1", "wells-fargo".
  const plain = label.replace(/-/g, "").replace(/0/g, "o").replace(/1/g, "l").replace(/3/g, "e").replace(/4/g, "a").replace(/5/g, "s").replace(/7/g, "t");
  return RISKY.test(plain) || RISKY.test(plain.replace(/l/g, "i"));
}

/** "2026-11" in UTC, for monthly edit limits. */
export const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);
export const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);

/** The review's JSON verdict, or a failing verdict if it can't be read. */
export function parseReview(out) {
  const m = typeof out === "string" ? /\{[\s\S]*\}/.exec(out) : null;
  try {
    const v = JSON.parse(m ? m[0] : "");
    const reasons = Array.isArray(v.problems) ? v.problems.map((p) => text(String(p), 300)).filter(Boolean).slice(0, 8) : [];
    if (typeof v.ok !== "boolean") throw new Error("no verdict");
    return { ok: v.ok === true && reasons.length === 0, reasons };
  } catch {
    return { ok: false, transient: true, reasons: ["The site check didn't finish. Trying again in a minute."] };
  }
}

/** Short hash for idempotency keys (a new card token means a new Square request). */
export const shortHash = (v) => createHash("sha256").update(String(v)).digest("hex").slice(0, 10);

/** Short stable hash of a page, so a page that already passed the check isn't checked twice. */
export function pageHash(html) {
  return createHmac("sha256", "webburrito").update(String(html)).digest("hex").slice(0, 32);
}

/** Forwarding addresses for the Super and Loaded plans: local parts like "info". */
export function parseForwards(list, max) {
  if (!Array.isArray(list) || list.length > max) return null;
  const out = [];
  for (const item of list) {
    const local = text(item?.local, 40).toLowerCase();
    const to = text(item?.to, 120).toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9._-]{0,38}[a-z0-9])?$/.test(local) || !isEmail(to)) return null;
    if (out.some((o) => o.local === local)) return null;
    out.push({ local, to });
  }
  return out;
}
