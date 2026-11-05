// Validation for /api/lead (the "Free preview" form on the home page). No Firebase imports.

// Longest value kept for each form field. Longer text is cut, not rejected, so a
// real request is never lost over length.
export const FIELDS = { business: 120, city: 80, name: 80, phone: 40, language: 20, message: 2000 };

const ID = /^[A-Za-z0-9_-]{8,40}$/;
const REF = /^[A-Za-z0-9_.-]{1,40}$/;
const TZ = /^[A-Za-z0-9_/+-]{1,50}$/;
const PAGE = /^\/[A-Za-z0-9_\-/]{0,100}$/;
// Control characters except tab and newline.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Returns { lead, spam } or null if the body isn't a usable request.
 * spam = the hidden "hp_note" field was filled in (bots fill every field; people never see it).
 */
export function parseLead(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const lead = {};
  for (const [key, max] of Object.entries(FIELDS)) {
    const v = body[key] ?? "";
    if (typeof v !== "string") return null;
    lead[key] = v.replace(CONTROL, "").trim().slice(0, max);
  }
  if (!lead.business) return null;
  const opt = (v, re) => (typeof v === "string" && re.test(v) ? v : null);
  lead.visitor = opt(body.visitor, ID);
  lead.tz = opt(body.tz, TZ);
  lead.ref = opt(body.ref, REF);
  lead.page = opt(body.page, PAGE);
  lead.internal = body.internal === true;
  const spam = typeof body.hp_note === "string" && body.hp_note.trim() !== "";
  return { lead, spam };
}
