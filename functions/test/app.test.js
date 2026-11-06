import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  parseProfile, parseContact, registrantFor, parseDomain, domainBuyable, squareSignatureOk, cleanHtml, parseReview,
  parseForwards, registrarPhone, PLANS,
} from "../app/pure.js";

test("profile needs a business name and trims fields", () => {
  assert.equal(parseProfile({ city: "LA" }), null);
  const p = parseProfile({ business: "  Rosa's Bakery\u0000 ", phone: "(323) 555-0100", about: "x".repeat(5000) });
  assert.equal(p.business, "Rosa's Bakery");
  assert.equal(p.about.length, 2000);
  assert.equal(p.type, "");
});

const contact = { first: "Rosa", last: "Diaz", email: "rosa@example.com", phone: "(323) 555-0100", street: "1 Main St", city: "Los Angeles", state: "ca", zip: "90001", org: "Rosa's" };
test("domain owner contact is validated and mapped for the registrar", () => {
  const c = parseContact(contact);
  assert.equal(c.state, "CA");
  assert.equal(registrarPhone(c.phone), "+1.3235550100");
  const r = registrantFor(c);
  assert.equal(r.phone, "+1.3235550100");
  assert.equal(r.postal_info.name, "Rosa Diaz");
  assert.equal(r.postal_info.organization, "Rosa's");
  assert.deepEqual(r.postal_info.address, { street: "1 Main St", city: "Los Angeles", state: "CA", postal_code: "90001", country_code: "US" });
  for (const bad of [{ zip: "9000" }, { state: "California" }, { email: "nope" }, { phone: "555-0100" }, { first: "" }]) {
    assert.equal(parseContact({ ...contact, ...bad }), null, JSON.stringify(bad));
  }
});

test("domains: one label, allowed endings, cleaned up", () => {
  assert.equal(parseDomain("https://www.RosasBakery.com/"), "rosasbakery.com");
  assert.equal(parseDomain("rosas-bakery.net"), "rosas-bakery.net");
  for (const bad of ["rosas bakery.com", "shop.rosas.com", "rosas.xyz", "-rosas.com", "ro--sas.com", "rosas", ""]) assert.equal(parseDomain(bad), null, bad);
});

test("only standard domains under the price cap can be auto-bought", () => {
  const std = { registrable: true, tier: "standard", pricing: { currency: "USD", registration_cost: "10.44", renewal_cost: "10.44" } };
  assert.deepEqual(domainBuyable(std, 15), { ok: true, cost: 10.44, renew: 10.44 });
  assert.equal(domainBuyable({ ...std, tier: "premium" }, 15).ok, false);
  assert.equal(domainBuyable({ ...std, pricing: { ...std.pricing, registration_cost: "20" } }, 15).ok, false);
  assert.equal(domainBuyable({ ...std, pricing: { ...std.pricing, renewal_cost: "99" } }, 15).ok, false);
  assert.equal(domainBuyable({ ...std, pricing: { ...std.pricing, currency: "EUR" } }, 15).ok, false);
  assert.equal(domainBuyable({ registrable: false, reason: "domain_unavailable" }, 15).why, "domain_unavailable");
  assert.equal(domainBuyable(undefined, 15).ok, false);
});

test("Square webhook signatures", () => {
  const key = "k", url = "https://webburrito.com/api/app/square-webhook", body = '{"event_id":"1"}';
  const sig = createHmac("sha256", key).update(url + body).digest("base64");
  assert.equal(squareSignatureOk(sig, key, url, body), true);
  assert.equal(squareSignatureOk(sig, key, url, body + " "), false);
  assert.equal(squareSignatureOk(sig, "other", url, body), false);
  assert.equal(squareSignatureOk("", key, url, body), false);
  assert.equal(squareSignatureOk(sig.slice(0, -2), key, url, body), false);
});

test("cleanHtml takes the page out of Claude's answer", () => {
  assert.equal(cleanHtml("```html\n<html><body>x</body></html>\n```"), "<!doctype html>\n<html><body>x</body></html>");
  assert.equal(cleanHtml("Here you go:\n<!DOCTYPE html><html></html> thanks"), "<!DOCTYPE html><html></html>");
  assert.equal(cleanHtml("<div>no html tag</div>"), null);
  assert.equal(cleanHtml("<html><body>never closed"), null);
  assert.equal(cleanHtml(`<html>${"x".repeat(400_001)}</html>`), null);
  assert.equal(cleanHtml(null), null);
});

test("review verdicts", () => {
  assert.deepEqual(parseReview('{"ok": true, "problems": []}'), { ok: true, reasons: [] });
  assert.deepEqual(parseReview('Sure: {"ok": false, "problems": ["Says #1 in LA"]}'), { ok: false, reasons: ["Says #1 in LA"] });
  assert.equal(parseReview('{"ok": true, "problems": ["something"]}').ok, false);
  // An answer that can't be read is "try again", never a pass or a counted failure.
  for (const garbled of ["no json", '{"problems": []}', '{"ok": "yes"}', ""]) {
    const r = parseReview(garbled);
    assert.equal(r.ok, false, garbled);
    assert.equal(r.transient, true, garbled);
  }
  assert.equal(parseReview('{"ok": false, "problems": ["x"]}').transient, undefined);
});

import { shortHash } from "../app/pure.js";
test("shortHash: short, stable, different for different input", () => {
  assert.match(shortHash("cnon:abc"), /^[0-9a-f]{10}$/);
  assert.equal(shortHash("cnon:abc"), shortHash("cnon:abc"));
  assert.notEqual(shortHash("cnon:abc"), shortHash("cnon:abd"));
  // Idempotency keys stay within Square's 45 characters with the longest checkout id.
  assert.ok(`${"x".repeat(30)}-c-${shortHash("t")}`.length <= 45);
});

test("email forwards", () => {
  assert.deepEqual(parseForwards([{ local: "Info", to: "Rosa@Gmail.com" }], 3), [{ local: "info", to: "rosa@gmail.com" }]);
  assert.equal(parseForwards([{ local: "info", to: "a@b.co" }, { local: "info", to: "c@d.co" }], 3), null);
  assert.equal(parseForwards([{ local: "a", to: "a@b.co" }, { local: "b", to: "a@b.co" }], 1), null);
  assert.equal(parseForwards([{ local: "bad name", to: "a@b.co" }], 3), null);
  assert.equal(parseForwards("x", 3), null);
});

test("plan prices match the website", () => {
  assert.deepEqual(Object.values(PLANS).map((p) => [p.monthly, p.yearly]), [[2000, 19900], [3500, 34900], [6900, 69900]]);
});

import { sanitizeHtml, riskyDomain } from "../app/pure.js";
test("sanitizeHtml removes scripts, handlers, forms and frames but keeps the page", () => {
  const out = sanitizeHtml(`<html><head><base href="x"><meta http-equiv="refresh" content="0;url=https://e"><link rel="stylesheet" href="https://fonts.googleapis.com/a"><link rel="import" href="x"></head>
<body onload="a()"><a href="javascript:alert(1)">x</a><a HREF = " JavaScript:alert(1)">y</a><img src=x onerror=alert(1) alt="ok"><svg onload="x()"><script>alert(2)</script></svg>
<form action="https://e"><input name=pw type=password></form><iframe srcdoc="<script>x</script>"></iframe><a href="tel:+1555">call</a><p onclick='a()' class="c">t</p></body></html>`);
  for (const bad of ["<script", "onload", "onerror", "onclick", "javascript:", "<form", "<input", "<iframe", "<base", "http-equiv", 'rel="import"']) {
    assert.equal(out.toLowerCase().includes(bad.toLowerCase()), false, bad);
  }
  for (const good of ['href="tel:+1555"', 'alt="ok"', 'class="c"', "fonts.googleapis.com"]) assert.ok(out.includes(good), good);
});

test("sanitizeHtml: tricks that slip past simple filters", () => {
  const out = sanitizeHtml(`<!doctype html><html><head>
<meta http-equiv="Refresh" content="0;url=https://evil.example"><meta name="viewport" content="width=device-width"><meta property="og:title" content="Rosa">
<meta content="0;url=https://evil.example" http-equiv="refresh"></head><body>
<a href="&#106;avascript:alert(1)">a</a><a href="java	script:alert(1)">b</a><a href="data:text/html,<script>x</script>">c</a>
<svg><a xlink:href="javascript:alert(1)"><text>d</text></a></svg><img src="data:image/png;base64,AAAA" alt="pixel">
<button formaction="https://evil.example">e</button><object data="x"></object><embed src="x"><template><script>x</script></template>
<a href="https://maps.google.com/?q=1" target="_blank">map</a><a href="sms:+15555550100">text</a></body></html>`);
  const low = out.toLowerCase();
  for (const bad of ["refresh", "evil.example", "javascript", "data:text", "<object", "<embed", "<template", "formaction", "<script"]) {
    assert.equal(low.includes(bad), false, bad);
  }
  for (const good of ['name="viewport"', 'property="og:title"', 'src="data:image/png', 'href="https://maps.google.com/?q=1"', 'href="sms:+15555550100"']) {
    assert.ok(out.includes(good), good);
  }
  assert.ok(out.startsWith("<!doctype html>"));
});

test("look-alike domains are refused, ordinary shop names aren't", () => {
  for (const d of ["paypal-refund.co", "chase-verify.com", "mylogin.net", "googlereviews.biz", "irsgov-help.us",
    "wells-fargo-alerts.com", "chase-bank.net", "bank-of-america-help.com", "irs-refund.us", "apple-support.co", "paypa1.com", "g00gle.shop"]) {
    assert.equal(riskyDomain(d), true, d);
  }
  for (const d of ["rosasbakery.com", "upsidedonuts.com", "applevalleytires.com", "chasesbakery.com", "securelocks.com",
    "unlockpros.com", "autorecoverytowing.com", "walletrepair.biz"]) {
    assert.equal(riskyDomain(d), false, d);
  }
});
