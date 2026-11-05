import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLead, FIELDS } from "../lead.js";

const form = { business: "Panadería La Rosa", city: "Columbus, OH", name: "Rosa", phone: "(614) 555-0100", language: "Español", message: "Pan dulce\nOpen 6am", hp_note: "" };

test("accepts a normal request and keeps accents and line breaks", () => {
  const { lead, spam } = parseLead(form);
  assert.equal(spam, false);
  assert.equal(lead.business, "Panadería La Rosa");
  assert.equal(lead.message, "Pan dulce\nOpen 6am");
  assert.equal(lead.internal, false);
});

test("only the business name is required", () => {
  assert.equal(parseLead({ business: "Tacos Gonzalez" }).lead.city, "");
  assert.equal(parseLead({ ...form, business: "   " }), null);
  assert.equal(parseLead({ city: "LA" }), null);
});

test("rejects non-objects and non-string fields", () => {
  for (const b of [null, "x", 5, [form]]) assert.equal(parseLead(b), null);
  assert.equal(parseLead({ ...form, phone: 6145550100 }), null);
  assert.equal(parseLead({ ...form, message: { $gt: "" } }), null);
});

test("trims, strips control characters, and cuts long text instead of rejecting", () => {
  const { lead } = parseLead({ ...form, business: "  Bad\u0000 Name\u0007 ", message: "x".repeat(5000) });
  assert.equal(lead.business, "Bad Name");
  assert.equal(lead.message.length, FIELDS.message);
});

test("honeypot marks spam", () => {
  assert.equal(parseLead({ ...form, hp_note: "http://spam.example" }).spam, true);
});

test("optional context fields are validated", () => {
  const { lead } = parseLead({ ...form, visitor: "a1b2c3d4e5f6a1b2c3d4e5f6", tz: "America/Los_Angeles", ref: "flyer", page: "/", internal: true });
  assert.deepEqual([lead.visitor, lead.tz, lead.ref, lead.page, lead.internal], ["a1b2c3d4e5f6a1b2c3d4e5f6", "America/Los_Angeles", "flyer", "/", true]);
  const bad = parseLead({ ...form, visitor: "<x>", tz: "a b", ref: "%3Cscript%3E", page: "javascript:alert(1)", internal: "yes" }).lead;
  assert.deepEqual([bad.visitor, bad.tz, bad.ref, bad.page, bad.internal], [null, null, null, null, false]);
});
