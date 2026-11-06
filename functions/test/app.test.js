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
  assert.equal(parseReview("no json").ok, false);
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
