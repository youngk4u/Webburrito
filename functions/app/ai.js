// Claude prompts: building or editing a customer's site, and the check before it goes live.

import { readFileSync } from "node:fs";
import { claude } from "./clients.js";
import { BUILD_MODEL, REVIEW_MODEL } from "./config.js";
import { cleanHtml, parseReview } from "./pure.js";

const PHOTOS = JSON.parse(readFileSync(new URL("./photos.json", import.meta.url), "utf8"));

const BUILD_SYSTEM = `You are the designer at Web Burrito, building the website of a real small local business.
You return ONE complete HTML document and nothing else: no explanation, no markdown fences.

Design
- Make it feel made for this business, not a template: colors, type and layout that fit what they sell and who they serve.
- Mobile first: it must read well at 360px wide with no sideways scrolling, and look polished on a desktop.
- Clear hierarchy: who they are and what they do, how to reach them (tap-to-call, directions), hours, services.
- Accessible: real headings in order, alt text on images, text contrast of at least 4.5:1, visible focus styles,
  respect prefers-reduced-motion.
- All CSS in one <style> in the head. Google Fonts via a <link> is allowed (at most two families). No other external
  CSS or JavaScript. Small inline scripts are fine but not needed. Inline SVG icons are fine.
- No <form> elements, iframes or embeds. To contact the business use tel:, sms:, mailto: and Google Maps links
  (https://www.google.com/maps/search/?api=1&query=...).
- Photos: keep any photo URLs that are already in the current page. You may add photos ONLY from the list provided
  (exact URLs). Never make up an image URL. Give every photo a background color or gradient fallback.
- Keep the page under 150 KB.

Honesty (very important)
- Use only facts from the business details, the current page and the owner's messages. Never invent reviews, ratings,
  quotes, prices, awards, years in business, staff names, certifications or guarantees.
- If something useful is missing (like hours), leave it out or say "Call for hours". Don't guess.
- The owner is the one asking for changes. Do what they ask unless it breaks the honesty rules or the rules below;
  in that case leave that part out.
- Never imitate another company's brand, ask visitors for passwords or card numbers, or include anything illegal,
  hateful or adult.

Required
- In the footer, keep exactly: <p class="wb-credit">Site by <a href="https://webburrito.com/">Web Burrito</a></p>
- Remove any "Website concept" banner or "Website concept by Web Burrito" credit from an earlier preview: this is the
  real site now.
- <title> = business name and what they do in their city. Add a one-sentence meta description.
- The <html> element has a lang attribute matching the page's language.`;

// Which photo sets fit which kinds of business (matched against type, name and services).
const PHOTO_MATCH = {
  plumber: /plumb/, electrician: /electric/, "auto-mechanic": /mechanic|auto repair|auto service|\bsmog|garage/,
  "bakery-cake": /\bcakes?\b|pastr|dessert/, donuts: /donut|doughnut/, tacos: /\btaco|taquer/, "barber-shop": /barber/,
  florist: /florist|flower/, "dog-grooming": /groom|\bpets?\b|\bdogs?\b/, handyman: /handyman/, hvac: /hvac|air condition|heating/,
  locksmith: /locksmith/, "tree-service": /\btree|arborist/, "plant-nursery": /nursery|garden center|\bplants?\b/,
  "carpet-cleaning": /carpet/, "house-cleaning": /house ?clean|\bmaid|janitor/, pool: /\bpools?\b/, roofing: /\broof/,
  painter: /painter|painting/, cabinets: /cabinet/, "tire-shop": /\btires?\b/, "auto-body": /body shop|collision|auto body/,
  "filipino-food": /filipin/, butcher: /butcher|\bmeats?\b|carnicer/, "pan-dulce": /panader|pan dulce/, bbq: /\bbbq|barbecue|smokehouse/,
  "fish-market": /\bfish|seafood|marisc/, "dry-cleaning": /dry clean|cleaners|laundr/, "nail-salon": /\bnails?\b/,
  tailor: /tailor|alteration|sewing/, "shoe-repair": /\bshoes?\b|cobbler|\bboots?\b/, braids: /braid/, pupusas: /pupus/,
  "bicycle-shop": /\bbikes?\b|bicycle|cyclery/, "window-tint": /\btint/, "car-interior": /upholster|auto trim/,
  preschool: /preschool|daycare|child ?care/, "mexican-bakery": /panader|mexican bakery/, "wagyu-steak": /steak|wagyu/,
};

export function photoKeys(profile) {
  const t = `${profile.type} ${profile.business} ${profile.services}`.toLowerCase();
  return Object.keys(PHOTO_MATCH).filter((k) => PHOTOS[k] && PHOTO_MATCH[k].test(t)).slice(0, 3);
}

function photoHints(profile) {
  const pick = photoKeys(profile);
  if (!pick.length) return "No stock photos fit this business, so don't add any new photos.";
  return "Photos you may use (exact URLs):\n" + pick.flatMap((k) => PHOTOS[k].map((p) => `- ${p.url} (${p.alt})`)).join("\n");
}

/**
 * Builds a new site (current = null) or edits the current one. Returns { html, usage } or
 * throws if Claude's answer wasn't a usable page.
 */
export async function buildSite({ profile, current, request, history = [] }) {
  const facts = JSON.stringify(profile, null, 2);
  const past = history.length ? `\nEarlier requests from the owner (already done):\n${history.map((h) => `- ${h}`).join("\n")}\n` : "";
  const user = current
    ? `Business details:\n${facts}\n${past}\n${photoHints(profile)}\n\nCurrent page:\n${current}\n\nThe owner asks: ${request}\n\nReturn the whole updated page.`
    : `Business details:\n${facts}\n\n${photoHints(profile)}\n\nThe owner says: ${request || "Make our website."}\n\nReturn the whole page.`;
  const out = await claude({ model: BUILD_MODEL.value(), system: BUILD_SYSTEM, messages: [{ role: "user", content: user }], maxTokens: 32000 });
  const html = cleanHtml(out.text);
  if (!html) throw new Error(out.stop === "max_tokens" ? "The page came out too long. Try asking for a simpler page." : "The builder didn't return a page. Try again.");
  return { html, usage: out.usage };
}

const REVIEW_SYSTEM = `You check small-business websites before they go live on the internet. Reply with JSON only:
{"ok": true|false, "problems": ["short plain-English problem the owner can fix", ...]}

Fail the site (ok=false) only for real problems:
- It pretends to be a well-known company or brand, or a government, bank, or payment service.
- It asks visitors for passwords, card numbers, bank details or ID numbers, or tries to send visitors' data anywhere.
- Adult, hateful, violent or illegal content, or selling things that need a license without saying so (weapons,
  drugs, alcohol delivery, etc.).
- Claims that look made up and could mislead customers: specific awards, ratings, review quotes, "#1 in the city",
  certifications or guarantees that the business details below don't support.
- Obvious breakage: placeholder text like "Lorem ipsum" or "[Your phone]", empty sections, missing business name,
  or a phone number different from the business details.
Don't fail it for design taste, missing hours, or small wording issues. If it's fine, return {"ok": true, "problems": []}.`;

/** The check before a site goes live. Returns { ok, reasons }. */
export async function reviewSite({ profile, html }) {
  const out = await claude({
    model: REVIEW_MODEL.value(),
    system: REVIEW_SYSTEM,
    messages: [{ role: "user", content: `Business details from the owner:\n${JSON.stringify(profile, null, 2)}\n\nThe website:\n${html}` }],
    maxTokens: 1500,
    timeoutMs: 120_000,
  });
  return parseReview(out.text);
}
