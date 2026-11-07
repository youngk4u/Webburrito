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

// ---------- social media pages ----------
import { parseSocial, socialLink, readMessageStream, pageShare } from "../app/pure.js";

test("social pages: links and @handles become clean links on known sites", () => {
  const { list, bad } = parseSocial("@rosasbakery, https://m.facebook.com/RosasBakery?ref=page_internal\ntiktok.com/@rosas_bakery yelp.com/biz/rosas-bakery-los-angeles");
  assert.deepEqual(bad, []);
  assert.deepEqual(list, [
    { site: "Instagram", url: "https://www.instagram.com/rosasbakery/", handle: "@rosasbakery" },
    { site: "Facebook", url: "https://www.facebook.com/RosasBakery" },
    { site: "TikTok", url: "https://www.tiktok.com/@rosas_bakery", handle: "@rosas_bakery" },
    { site: "Yelp", url: "https://www.yelp.com/biz/rosas-bakery-los-angeles" },
  ]);
  assert.equal(socialLink("facebook.com/profile.php?id=100063625123456").url, "https://www.facebook.com/profile.php?id=100063625123456");
  assert.equal(socialLink("http://twitter.com/rosas").url, "https://x.com/rosas");
  assert.equal(socialLink("threads.net/@rosas").url, "https://www.threads.com/@rosas");
});

test("social pages: anything else is refused, never passed through", () => {
  for (const t of ["rosasbakery", "javascript:alert(1)", "https://evil.example/instagram.com/x", "https://instagram.com.evil.example/x",
    "instagram.com/p/C1x2", "facebook.com/share/1AbCd", "x.com/home", "https://user:pw@instagram.com/x", "instagram.com:8080/x", "data:text/html,hi",
    'instagram.com/a"onmouseover="x']) {
    assert.equal(socialLink(t), null, t);
  }
  const { list, bad } = parseSocial("@ok, nope.example/page");
  assert.equal(list.length, 1);
  assert.deepEqual(bad, ["nope.example/page"]);
});

test("social pages: saved lists parse again, duplicates go, at most 5", () => {
  const saved = parseSocial("@a1, @a2, @a3, @a4, @a5, @a6, instagram.com/a1").list;
  assert.equal(saved.length, 5);
  assert.deepEqual(parseSocial(saved).list, saved);
  assert.deepEqual(parseProfile({ business: "X", social: saved }).social, saved);
  assert.deepEqual(parseProfile({ business: "X" }).social, []);
  assert.deepEqual(parseProfile({ business: "X", social: { url: "x" } }).social, []);
});

// A stream of server-sent events, cut into chunks at awkward places (mid-line, mid-character).
function sse(events, cut = 7) {
  const s = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const bytes = new TextEncoder().encode(s);
  return (async function* () { for (let i = 0; i < bytes.length; i += cut) yield bytes.slice(i, i + cut); })();
}

test("a streamed answer reads the same as a whole one, and reports progress", async () => {
  const seen = [];
  const out = await readMessageStream(sse([
    { type: "message_start", message: { usage: { input_tokens: 25, output_tokens: 1 } } },
    { type: "ping" },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "<!doctype html><p>Pan dulce ¡rico! " } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "y café</p>" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "edit_page", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"edits": [{"find": "a", ' } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"replace": "b"}]}' } },
    { type: "content_block_stop", index: 1 },
    { type: "some_new_event", whatever: true },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } },
    { type: "message_stop" },
  ]), (p) => seen.push([p.chars, p.block.type, p.block.name || null]));
  assert.equal(out.stop, "tool_use");
  assert.deepEqual(out.usage, { input_tokens: 25, output_tokens: 42 });
  assert.equal(out.content[0].text, "<!doctype html><p>Pan dulce ¡rico! y café</p>");
  assert.deepEqual(out.content[1], { type: "tool_use", id: "t1", name: "edit_page", input: { edits: [{ find: "a", replace: "b" }] } });
  assert.deepEqual(seen.map((s) => s[1]), ["text", "text", "text", "tool_use", "tool_use", "tool_use"]);
  assert.ok(seen.at(-1)[0] > seen[1][0], "chars grow");
  assert.equal(seen[3][2], "edit_page");
});

test("an error partway through a stream is thrown; a cut-off tool input reads as empty", async () => {
  await assert.rejects(readMessageStream(sse([
    { type: "message_start", message: { usage: {} } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
  ])), (e) => e.streamError === "overloaded_error");
  const cut = await readMessageStream(sse([
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "rewrite_page", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"html": "<!doctype' } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "max_tokens" } },
  ], 3));
  assert.equal(cut.stop, "max_tokens");
  assert.deepEqual(cut.content[0].input, {});
});

test("the progress share of a new page grows and never reaches 100%", () => {
  const steps = [0, 1000, 13000, 26000, 40000, 1e7].map(pageShare);
  assert.deepEqual(steps.slice(0, 4), [0.05, 0.08, 0.48, 0.9]);
  for (let i = 1; i < steps.length; i++) assert.ok(steps[i] >= steps[i - 1]);
  assert.equal(steps.at(-1), 0.97);
});
