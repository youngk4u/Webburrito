// Page tools for customer sites: turning a Web Burrito preview into a live site, quick AI edits,
// search-engine data, and small parsers. No network, no database: easy to test.

import { parseDocument, DomUtils } from "htmlparser2";
import render from "dom-serializer";
import { decodeHTML } from "entities";

const { findAll, findOne, removeElement, replaceElement, getAttributeValue, getInnerHTML } = DomUtils;
// Raw mode keeps every byte we don't touch exactly as it was.
const RAW = { decodeEntities: false };
const parse = (html) => parseDocument(String(html || ""), RAW);
const out = (node) => render(node, RAW);
const fragment = (html) => parse(html).children[0];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const clean = (s) => decodeHTML(String(s || "")).replace(/\s+/g, " ").trim();
const hasClass = (el, name) => String(el.attribs?.class || "").split(/\s+/).includes(name);
const textOf = (el) => clean(getInnerHTML(el, RAW).replace(/<br\s*\/?>/gi, ", ").replace(/<[^>]+>/g, " "));

/** "(405) 703-2118" from anything with 10 US digits; null otherwise. */
export function displayPhone(s) {
  const d = String(s || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : null;
}
const telOf = (s) => {
  const d = String(s || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return d.length === 10 ? `+1${d}` : null;
};

/** "1060 SW 4th St, Moore, OK 73160" -> { street, city, state, zip }, or null. */
export function parseUsAddress(s, business = "") {
  let t = clean(s).replace(/,?\s*(USA|United States)$/i, "");
  // Addresses on our previews sometimes start with the business name.
  if (business && t.toLowerCase().startsWith(`${business.toLowerCase()},`)) t = t.slice(business.length + 1).trim();
  const m = /^(.+?),\s*([^,]+?),\s*([A-Za-z]{2})\.?\s+(\d{5})(?:-\d{4})?$/.exec(t);
  if (!m) return null;
  return { street: m[1].trim(), city: m[2].trim(), state: m[3].toUpperCase(), zip: m[4] };
}

/** A .com to suggest from a business name: "Rosa's Bakery" -> "rosasbakery.com". */
export function suggestDomain(name) {
  const base = String(name || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/&/g, "and").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "");
  return base && base.length <= 50 ? `${base}.com` : null;
}

/** "santa-fe-donuts" -> "Santa Fe Donuts" (a fallback name when a preview has no title). */
export const nameFromSlug = (slug) => String(slug || "").split("-").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

/**
 * Turns a Web Burrito preview (a "concept" page) into the live site: no concept banner, the live
 * footer credit, no noindex, order forms become a call/text box (live sites can't send forms),
 * and buttons that only worked with scripts are taken out. Also reads the business details off
 * the page so the owner doesn't have to type them. Returns { html, facts }.
 */
export function livePreview(html) {
  const doc = parse(html);
  const all = (test) => findAll((el) => el.type === "tag" && test(el), doc.children);

  const title = findOne((el) => el.name === "title", doc.children, true);
  const business = title ? clean(getInnerHTML(title, RAW)).split(/\s+[·|—–-]\s+/)[0].trim() : "";
  const telLink = findOne((el) => el.name === "a" && /^tel:/i.test(getAttributeValue(el, "href") || ""), doc.children, true);
  const phone = telLink ? displayPhone(getAttributeValue(telLink, "href")) : null;
  const tel = telLink ? telOf(getAttributeValue(telLink, "href")) : null;
  const addressEl = findOne((el) => el.name === "address", doc.children, true);
  const address = addressEl ? textOf(addressEl) : "";
  const parts = parseUsAddress(address, business);

  // Both kit versions: wb-* (current) and dj-* (early previews).
  for (const el of all((e) => hasClass(e, "wb-concept") || hasClass(e, "dj-concept"))) removeElement(el);
  for (const el of all((e) => e.name === "meta" && /^robots$/i.test(e.attribs?.name || ""))) removeElement(el);
  for (const el of all((e) => hasClass(e, "wb-credit") || hasClass(e, "dj-credit"))) {
    // Keep the element (and its styling); only the words change.
    el.children = fragment(`<p>Site by <a href="https://webburrito.com/">Web Burrito</a></p>`).children;
    for (const c of el.children) c.parent = el;
  }
  // Notes that only made sense with the preview's form ("Use the form below"). Only an element
  // that is nothing but such a note goes: short, no phone number. Sentences inside other text are
  // left to the polish pass, so no real content is lost here.
  const FORM_NOTE = /^(on the live site\b|prefer to (type|write) it\b|(or )?use (the|this) form\b|(or )?fill (in|out) (the|this) form\b|(or )?leave your details\b)/i;
  const noteOnly = (e) => { const t = textOf(e); return t.length < 120 && !/\d/.test(t) && FORM_NOTE.test(t); };
  for (const el of all((e) => hasClass(e, "formnote") || (["p", "small", "span", "li"].includes(e.name) && noteOnly(e)))) {
    removeElement(el);
  }
  for (const form of all((e) => e.name === "form")) {
    if (!tel) { removeElement(form); continue; }
    replaceElement(form, fragment(
      `<div class="wb-call" style="margin:1rem 0;padding:1.1rem 1.25rem;border:2px solid currentColor;border-radius:14px">` +
      `<p style="margin:0 0 .4rem;font-weight:700">Call or text us</p>` +
      `<p style="margin:0"><a href="tel:${tel}">${esc(phone)}</a> &nbsp;·&nbsp; <a href="sms:${tel}">Send a text</a></p></div>`,
    ));
  }
  // Buttons outside forms: only ones with no words of their own go ("+", "−", arrows, empty) and
  // short "Send"/"Order" buttons. Menus, services and tabs are often built from buttons, so everything
  // else stays, looking the same; the polish pass removes switches that do nothing on their own.
  // Inputs and selects are dropped by the sanitizer; labels stay as text.
  const ACTION = /^(send|submit|order|request|book|reserve|search|go|get (a )?quote)\b/i;
  for (const el of all((e) => e.name === "button")) {
    const t = textOf(el);
    if (/^[\s+\-−–×✕<>‹›«»←→↑↓]*$/.test(t) || (t.length < 30 && ACTION.test(t))) removeElement(el);
  }

  const facts = {
    business: business.slice(0, 120),
    phone: phone || "",
    address: (parts ? `${parts.street}, ${parts.city}, ${parts.state} ${parts.zip}` : address).slice(0, 200),
    city: parts?.city || "",
  };
  return { html: out(doc), facts };
}

/**
 * The lines of a claimed preview that come from the business's public listings (ratings, review
 * counts, reviewer quotes), so later checks know Web Burrito put them there. Up to 40 lines.
 */
export function listingLinesOf(html) {
  const doc = parse(html);
  const LISTING = /\b(yelp|google|tripadvisor|facebook|reviews?|reviewers?|stars?|rated|rating)\b/i;
  const lines = new Set();
  for (const el of findAll((e) => e.type === "tag" && ["p", "li", "blockquote", "figcaption", "span", "small", "div", "h3", "h4"].includes(e.name), doc.children)) {
    if (el.children.some((c) => c.type === "tag" && ["p", "li", "div", "blockquote"].includes(c.name))) continue; // innermost text only
    const t = textOf(el);
    if (t.length > 8 && t.length <= 300 && LISTING.test(t)) lines.add(t);
    if (lines.size >= 40) break;
  }
  return [...lines];
}

/** Fills only the empty fields of a business profile from facts read off a preview. */
export function fillProfile(profile, facts, fallbackName = "") {
  const p = { ...(profile || {}) };
  for (const k of ["business", "phone", "address", "city"]) if (!p[k] && facts?.[k]) p[k] = facts[k];
  if (!p.business && fallbackName) p.business = fallbackName;
  return p;
}

// ---------- quick edits ----------
/**
 * Applies find-and-replace edits in order. Each `find` must appear exactly once at that point,
 * otherwise nothing is applied (returns null) and the caller asks for the whole page instead.
 */
export function applyEdits(page, edits) {
  if (typeof page !== "string" || !Array.isArray(edits) || !edits.length || edits.length > 40) return null;
  let s = page;
  for (const e of edits) {
    const find = typeof e?.find === "string" ? e.find : "";
    const replace = typeof e?.replace === "string" ? e.replace : null;
    if (!find || replace === null) return null;
    const i = s.indexOf(find);
    if (i < 0 || s.indexOf(find, i + 1) >= 0) return null;
    s = s.slice(0, i) + replace + s.slice(i + find.length);
  }
  return s;
}

// ---------- what search engines read ----------
const TYPES = [
  [/bakery|bake shop|panader|donut|doughnut|pastr|cake/, "Bakery"],
  [/taco|taquer|restaurant|cafe|café|diner|grill|kitchen|bbq|pupus|pizza|food truck|catering|cuisine/, "Restaurant"],
  [/barber|salon|hair|braid/, "HairSalon"],
  [/nail/, "NailSalon"],
  [/auto|mechanic|tire|smog|body shop|collision|upholster/, "AutoRepair"],
  [/plumb/, "Plumber"], [/electric/, "Electrician"], [/locksmith/, "Locksmith"], [/roof/, "RoofingContractor"],
  [/hvac|air condition|heating/, "HVACBusiness"], [/florist|flower/, "Florist"], [/dry clean|laundr/, "DryCleaningOrLaundry"],
  [/meat|carnicer|butcher|market|grocery/, "GroceryStore"], [/bike|bicycle/, "BikeStore"], [/preschool|daycare|child ?care/, "ChildCare"],
];
const schemaType = (p) => TYPES.find(([re]) => re.test(`${p.type || ""} ${p.business || ""}`.toLowerCase()))?.[1] || "LocalBusiness";

/** schema.org data for the business (name, phone, address), as a JSON string safe inside HTML. */
export function jsonLd(profile, url) {
  const p = profile || {};
  const a = parseUsAddress(p.address || "", p.business || "");
  const data = {
    "@context": "https://schema.org",
    "@type": schemaType(p),
    name: p.business || undefined,
    url,
    telephone: telOf(p.phone) || undefined,
    address: a
      ? { "@type": "PostalAddress", streetAddress: a.street, addressLocality: a.city, addressRegion: a.state, postalCode: a.zip, addressCountry: "US" }
      : p.city ? { "@type": "PostalAddress", addressLocality: p.city, addressCountry: "US" } : undefined,
  };
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

/**
 * The page as it's served on the customer's domain: always indexable, one canonical address,
 * and the business details for Google in schema.org form. Everything else stays byte-for-byte the
 * page that was checked: tags are spliced in and out by position, not re-written.
 */
export function servedPage(html, profile, url) {
  const doc = parseDocument(String(html || ""), { ...RAW, withStartIndices: true, withEndIndices: true });
  const head = findOne((e) => e.name === "head", doc.children, true);
  if (!head || head.endIndex == null) return html;
  const cuts = findAll((e) => e.type === "tag" && ((e.name === "meta" && /^robots$/i.test(e.attribs?.name || "")) || (e.name === "link" && /^canonical$/i.test(e.attribs?.rel || ""))), doc.children)
    .map((e) => [e.startIndex, e.endIndex + 1]);
  const at = head.endIndex + 1 - "</head>".length; // where </head> starts
  if (html.slice(at, head.endIndex + 1).toLowerCase() !== "</head>") return html;
  const add = `<link rel="canonical" href="${esc(url)}">\n<script type="application/ld+json">${jsonLd(profile, url)}</script>\n`;
  let s = html.slice(0, at) + add + html.slice(at);
  for (const [a, b] of cuts.sort((x, y) => y[0] - x[0])) if (b <= at) s = s.slice(0, a) + s.slice(b); // all inside <head>, before the insert
  return s;
}
