// Pure helpers for the customer platform (no Firebase or network), so they're easy to test.

import { createHmac, timingSafeEqual } from "node:crypto";

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
  if (s.length > 400_000) return null;
  return s;
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
    return { ok: v.ok === true && reasons.length === 0, reasons };
  } catch {
    return { ok: false, reasons: ["The site check didn't finish. Try again in a minute."] };
  }
}

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
