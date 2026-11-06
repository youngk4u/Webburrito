// Settings for the customer platform (webburrito.com/app/ and /api/app/*).
//
// Secrets are stored in Google Secret Manager. Set each one from your computer; nobody else
// ever sees them:   firebase functions:secrets:set ANTHROPIC_API_KEY
// The other values have defaults below and can be changed in functions/.env (see README).

import { existsSync, readFileSync } from "node:fs";
import { defineSecret, defineString, defineInt } from "firebase-functions/params";

// The platform is off (its functions aren't deployed and its keys aren't asked for) until
// PLATFORM=on in functions/.env. A deploy works out which functions exist before it loads .env
// into the environment, so the file is read here; a running function has it in process.env.
function platformOn() {
  if (process.env.PLATFORM) return process.env.PLATFORM === "on";
  let value = "off";
  // .env.local is only for local tests with the emulator.
  for (const name of [".env", ...(process.env.FUNCTIONS_EMULATOR === "true" ? [".env.local"] : [])]) {
    const file = new URL(`../${name}`, import.meta.url);
    if (!existsSync(file)) continue;
    const m = /^[ \t]*PLATFORM[ \t]*=[ \t]*"?([a-z]+)"?[ \t]*$/m.exec(readFileSync(file, "utf8"));
    if (m) value = m[1];
  }
  return value === "on";
}
export const PLATFORM_ON = platformOn();

// Defined only when the platform is on: a deploy asks for every secret that's defined.
const secret = (name) => (PLATFORM_ON ? defineSecret(name) : null);
export const ANTHROPIC_API_KEY = secret("ANTHROPIC_API_KEY");
export const SQUARE_ACCESS_TOKEN = secret("SQUARE_ACCESS_TOKEN");
export const SQUARE_WEBHOOK_SIGNATURE_KEY = secret("SQUARE_WEBHOOK_SIGNATURE_KEY");
export const CLOUDFLARE_API_TOKEN = secret("CLOUDFLARE_API_TOKEN");
export const SECRETS = PLATFORM_ON ? [ANTHROPIC_API_KEY, SQUARE_ACCESS_TOKEN, SQUARE_WEBHOOK_SIGNATURE_KEY, CLOUDFLARE_API_TOKEN] : [];

// "production" for real money, "sandbox" to test with Square's test cards.
export const SQUARE_ENVIRONMENT = defineString("SQUARE_ENVIRONMENT", { default: "sandbox" });
// From developer.squareup.com -> your app -> Credentials (public, safe to put in .env).
export const SQUARE_APPLICATION_ID = defineString("SQUARE_APPLICATION_ID", { default: "" });
export const SQUARE_LOCATION_ID = defineString("SQUARE_LOCATION_ID", { default: "LAET0GFY9RXSR" });
// Must match the webhook URL saved in the Square developer dashboard exactly.
export const SQUARE_WEBHOOK_URL = defineString("SQUARE_WEBHOOK_URL", { default: "https://webburrito.com/api/app/square-webhook" });

export const CLOUDFLARE_ACCOUNT_ID = defineString("CLOUDFLARE_ACCOUNT_ID", { default: "" });
export const SITES_WORKER_NAME = defineString("SITES_WORKER_NAME", { default: "webburrito-sites" });

export const BUILD_MODEL = defineString("BUILD_MODEL", { default: "claude-sonnet-5-5" });
export const REVIEW_MODEL = defineString("REVIEW_MODEL", { default: "claude-sonnet-5-5" });

// Free AI builds before paying, per account, and a daily cap across everyone (cost guard).
export const FREE_BUILDS = defineInt("FREE_BUILDS", { default: 3 });
export const FREE_BUILDS_PER_DAY_TOTAL = defineInt("FREE_BUILDS_PER_DAY_TOTAL", { default: 150 });
// Most a domain may cost to register (USD). Premium domains are always refused.
export const MAX_DOMAIN_PRICE = defineInt("MAX_DOMAIN_PRICE", { default: 15 });
// Most domains bought automatically per day (a guard against stolen cards). Past this, a
// launch waits for an admin's "Retry launch" on /admin/.
export const MAX_DOMAINS_PER_DAY = defineInt("MAX_DOMAINS_PER_DAY", { default: 10 });
// In test mode only admins and these emails (comma-separated) can "pay" with test cards.
export const TEST_EMAILS = defineString("TEST_EMAILS", { default: "" });
// Where the passcode previews live (the server reads them to start a customer's site).
export const SITE_ORIGIN = defineString("SITE_ORIGIN", { default: "https://webburrito.com" });
// Days a site stays up after a failed payment before it's taken offline.
export const PAST_DUE_GRACE_DAYS = defineInt("PAST_DUE_GRACE_DAYS", { default: 14 });
// Seconds between launch steps that wait on something (payment, domain registration). Errors
// back off from this: 1x, 2x, 4x ... up to 60x.
export const LAUNCH_RETRY_SECONDS = defineInt("LAUNCH_RETRY_SECONDS", { default: 60 });

// Base URLs. Only changed for local testing against stand-in servers.
export const ANTHROPIC_BASE_URL = defineString("ANTHROPIC_BASE_URL", { default: "https://api.anthropic.com" });
export const SQUARE_BASE_URL = defineString("SQUARE_BASE_URL", { default: "" }); // empty = from SQUARE_ENVIRONMENT
export const CLOUDFLARE_BASE_URL = defineString("CLOUDFLARE_BASE_URL", { default: "https://api.cloudflare.com/client/v4" });

// Test mode: until SQUARE_ENVIRONMENT is "production", payments use Square's sandbox and no
// domain is really bought (Cloudflare has no test mode), so the whole flow can be tried for free.
export const isLive = () => SQUARE_ENVIRONMENT.value() === "production";

export function squareBase() {
  const custom = SQUARE_BASE_URL.value();
  if (custom) return custom.replace(/\/$/, "");
  return SQUARE_ENVIRONMENT.value() === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com";
}
