import { test } from "node:test";
import assert from "node:assert/strict";
import {
  livePreview, applyEdits, parseUsAddress, suggestDomain, nameFromSlug, fillProfile, displayPhone, jsonLd, servedPage,
} from "../app/site.js";
import { sanitizeHtml } from "../app/pure.js";

// A preview the way the kit makes them (both banner styles, a form, script-only widgets).
const PREVIEW = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow">
<title>Santa Fe Donuts · Donuts &amp; kolaches in Moore, OK</title><style>.wb-concept{position:sticky}</style></head>
<body><div class="wb-concept"><span class="wb-mark"><i></i><b>Website concept</b></span><span>prepared by Web Burrito for Santa Fe Donuts. Not live yet — reply to the email to make it yours.</span></div>
<header><a href="tel:+14057032118">(405) 703-2118</a></header>
<main><section><h2>Order ahead</h2><p>Call us.</p><p>Prefer to type it out? Use the form below.</p>
<form onsubmit="event.preventDefault()"><label>Your name<input name="name"></label><button type="submit">Send order request</button>
<p class="formnote">On the live site, this goes straight to your phone and email.</p></form></section>
<div class="stage"><button class="btn" id="warmBtn" type="button" aria-pressed="false">Warm it up</button><p>A kolache straight from the case.</p></div>
<div class="count"><button type="button" aria-label="One fewer">−</button><button type="button" aria-label="One more">+</button></div>
<ul class="dishes"><li><button type="button" class="dish"><b>Chicken adobo</b> Braised in vinegar and garlic</button></li></ul>
<p>Walk-ins welcome. Use the form below or call (405) 703-2118.</p>
<label for="people">How many at the table? <span id="count">4</span></label>
<address>Santa Fe Donuts<br>1060 SW 4th St<br>Moore, OK 73160</address>
<p>Caf&eacute; con leche &amp; more.</p></main>
<footer><p class="dj-credit" style="margin-top:1rem">Website concept by <a href="https://webburrito.com/">Web Burrito</a> · webburrito.com</p></footer>
<script>document.getElementById('warmBtn').onclick=function(){}</script></body></html>`;

test("livePreview turns a preview into a live page and reads the business details", () => {
  const { html, facts } = livePreview(PREVIEW);
  const page = sanitizeHtml(html);
  for (const gone of ['class="wb-concept"', "Website concept", "noindex", "<form", ">−<", ">+<", "Send order request", "Prefer to type it out", "On the live site", "<script"]) {
    assert.equal(page.includes(gone), false, gone);
  }
  // Real content is never thrown away: content-carrying buttons, sentences with a phone number, labels.
  assert.ok(page.includes("<b>Chicken adobo</b> Braised in vinegar and garlic"), "a dish shown as a button stays");
  assert.ok(page.includes("Walk-ins welcome. Use the form below or call (405) 703-2118."), "a sentence with a phone number stays (left to the polish)");
  assert.ok(page.includes("How many at the table?"), "label text stays");
  assert.ok(page.includes('class="wb-call"') && page.includes('href="tel:+14057032118"') && page.includes('href="sms:+14057032118"'), "call/text box");
  assert.ok(/<p class="dj-credit" style="margin-top:1rem">Site by <a href="https:\/\/webburrito.com\/">Web Burrito<\/a><\/p>/.test(page), "live credit, styling kept");
  assert.ok(page.includes("A kolache straight from the case.") && page.includes("Café con leche &amp; more."), "everything else is kept as it was");
  assert.deepEqual(facts, { business: "Santa Fe Donuts", phone: "(405) 703-2118", address: "1060 SW 4th St, Moore, OK 73160", city: "Moore" });
});

test("livePreview without a phone drops the form instead of offering a dead box", () => {
  const { html } = livePreview(`<html><head><title>X</title></head><body><form><input></form><p>Hi</p></body></html>`);
  assert.equal(html.includes("<form"), false);
  assert.equal(html.includes("wb-call"), false);
  assert.ok(html.includes("<p>Hi</p>"));
});

test("sanitizing twice changes nothing (draft and live hashes match)", () => {
  const once = sanitizeHtml(livePreview(PREVIEW).html);
  assert.equal(sanitizeHtml(once), once);
});

test("applyEdits: each find must match exactly once, all or nothing", () => {
  const page = "<p>Open 7am</p><p>Call us</p>";
  assert.equal(applyEdits(page, [{ find: "Open 7am", replace: "Open 6am" }, { find: "Call us", replace: "Call $& us" }]), "<p>Open 6am</p><p>Call $& us</p>");
  assert.equal(applyEdits(page, [{ find: "<p>", replace: "<div>" }]), null, "appears twice");
  assert.equal(applyEdits(page, [{ find: "Open 7am", replace: "x" }, { find: "missing", replace: "y" }]), null, "one miss undoes all");
  assert.equal(applyEdits(page, []), null);
  assert.equal(applyEdits(page, [{ find: "", replace: "x" }]), null);
  assert.equal(applyEdits(page, "nope"), null);
});

test("US addresses, phones, names and domain suggestions", () => {
  assert.deepEqual(parseUsAddress("1688 S Melrose Dr, Ste 206, Vista, CA 92081"), { street: "1688 S Melrose Dr, Ste 206", city: "Vista", state: "CA", zip: "92081" });
  assert.deepEqual(parseUsAddress("Rosa's, 1 Main St, Los Angeles, ca 90001-1234, USA", "Rosa's"), { street: "1 Main St", city: "Los Angeles", state: "CA", zip: "90001" });
  assert.equal(parseUsAddress("Los Angeles, CA"), null);
  assert.equal(displayPhone("+1 (405) 703-2118"), "(405) 703-2118");
  assert.equal(displayPhone("12345"), null);
  assert.equal(suggestDomain("Rosa's Bakery & Café"), "rosasbakeryandcafe.com");
  assert.equal(suggestDomain("Panadería La Rosa"), "panaderialarosa.com");
  assert.equal(suggestDomain("!!!"), null);
  assert.equal(nameFromSlug("santa-fe-donuts"), "Santa Fe Donuts");
});

test("fillProfile only fills what the owner left empty", () => {
  const facts = { business: "Santa Fe Donuts", phone: "(405) 703-2118", address: "1060 SW 4th St, Moore, OK 73160", city: "Moore" };
  assert.deepEqual(fillProfile({ business: "Santa Fe Donuts LLC", phone: "" }, facts), { business: "Santa Fe Donuts LLC", phone: "(405) 703-2118", address: facts.address, city: "Moore" });
  assert.equal(fillProfile(null, {}, "Fallback Name").business, "Fallback Name");
});

test("search-engine data: right type, and it can't break out of its tag", () => {
  const data = JSON.parse(jsonLd({ business: "Rosa's Bakery", type: "bakery", phone: "(555) 555-0100", address: "1 Main St, Los Angeles, CA 90001" }, "https://rosasbakery.com/"));
  assert.equal(data["@type"], "Bakery");
  assert.equal(data.telephone, "+15555550100");
  assert.equal(data.address.postalCode, "90001");
  const quiet = JSON.parse(jsonLd({ business: "X", email: "owner@private.com", about: "anything" }, "https://x.com/"));
  assert.equal(quiet.email, undefined, "no email published");
  assert.equal(quiet.description, undefined, "no free text published");
  const evil = jsonLd({ business: "</script><script>alert(1)</script>" }, "https://x.com/");
  assert.equal(evil.includes("</script>"), false);
  assert.equal(JSON.parse(evil).name, "</script><script>alert(1)</script>");
});

test("servedPage: indexable, one canonical address, business data in the head, nothing else touched", () => {
  const page = `<!doctype html>\n<html><head><meta name="robots" content="noindex"><style>/* </head> */ a{b:c}</style><link rel="canonical" href="https://old/"><title>t</title></head><body><br /><p>$&amp; x</p></body></html>`;
  const out = servedPage(page, { business: "Rosa's $& Co", phone: "555-555-0100" }, "https://rosasbakery.com/");
  assert.equal(out.includes("noindex"), false);
  assert.equal((out.match(/rel="canonical"/g) || []).length, 1);
  assert.ok(out.includes('<link rel="canonical" href="https://rosasbakery.com/">'));
  assert.ok(/<script type="application\/ld\+json">\{.*Rosa's \$& Co.*\}<\/script>\n<\/head>/s.test(out), "JSON-LD inserted as-is, before the real </head>");
  assert.ok(out.includes("<style>/* </head> */ a{b:c}</style>") && out.includes("<body><br /><p>$&amp; x</p></body>"), "the rest is byte-for-byte");
  assert.equal(servedPage("<p>no head</p>", {}, "https://x.com/"), "<p>no head</p>");
});
