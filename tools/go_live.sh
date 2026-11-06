#!/usr/bin/env bash
# Turns on the Web Burrito customer platform (webburrito.com/app/) in one go.
#
#   bash tools/go_live.sh          first time: test mode (Square sandbox, test cards, no domain bought)
#   bash tools/go_live.sh --real   later: real payments and real domains
#
# Run it in Terminal from your copy of the repo (~/webburrito-deploy). It asks for each key with
# hidden typing and stores it in Google Secret Manager. Keys are never shown or written to a file.
# The rest happens by itself: settings, commit, deploy, Square plans and site hosting.
set -euo pipefail
cd "$(dirname "$0")/.."

REAL=0
[ "${1:-}" = "--real" ] && REAL=1
ENV_FILE=functions/.env
bold() { printf '\n\033[1m%s\033[0m\n' "$1"; }
pause() { read -r -p "Press Enter when that's done. " _; }
need() { command -v "$1" >/dev/null || { echo "Install $1 first ($2)."; exit 1; }; }

need firebase "npm install -g firebase-tools"
need git "it comes with Xcode's command line tools: xcode-select --install"
[ -f "$ENV_FILE" ] || { echo "Run this from the Web Burrito repo folder."; exit 1; }

bold "1. Checking this folder and your Firebase sign-in"
# Only functions/.env may be changed (left by an earlier run that stopped): nothing else rides along.
other=$(git status --porcelain | grep -v " $ENV_FILE\$" || true)
[ -z "$other" ] || { echo "This folder has other changes (below). Use a clean copy (~/webburrito-deploy)."; echo "$other"; exit 1; }
git checkout -q main
# Settings left by an earlier run that stopped are asked again below, so start from the repo's.
git diff --quiet -- "$ENV_FILE" || git checkout -q -- "$ENV_FILE"
# --rebase also carries a settings commit whose push failed last time on top of GitHub's main.
git pull -q --rebase origin main
firebase projects:list >/dev/null 2>&1 || firebase login --reauth

# Saves a key in Secret Manager. If one is saved already, asks whether to replace it (unless
# the third argument is "always": then it must be typed again).
secret() {
  local name=$1 where=$2 mode=${3:-} value answer
  if [ "$mode" != always ] && firebase functions:secrets:get "$name" >/dev/null 2>&1; then
    read -r -p "  $name is already saved. Replace it? [y/N] " answer
    case "$answer" in y|Y|yes|Yes) ;; *) echo "  ✓ keeping $name"; return ;; esac
  fi
  echo "  $where"
  read -r -s -p "  Paste $name (it stays hidden) and press Enter: " value
  echo
  [ -n "$value" ] || { echo "  Nothing pasted, stopping. Run the script again when you have it."; exit 1; }
  printf '%s' "$value" | firebase functions:secrets:set "$name" --data-file=- --non-interactive >/dev/null
  unset value
  echo "  ✓ $name saved"
}
# Asks for a setting (not a secret) and checks it against the shape it must have. Nothing is
# written until every answer is in, so a run that stops halfway leaves the folder as it was.
SETTINGS=""
setting() {
  local name=$1 where=$2 shape=$3 example=$4 value
  echo "  $where"
  read -r -p "  $name: " value
  value=$(printf '%s' "$value" | tr -d '[:space:]')
  [[ "$value" =~ $shape ]] || { echo "  That doesn't look like a $name ($example). Stopping; nothing was changed."; exit 1; }
  SETTINGS="$SETTINGS$name=$value
"
}
apply_settings() {
  local line name
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    name=${line%%=*}
    sed -i.bak "s|^$name=.*|$line|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
  done <<EOF2
$SETTINGS
EOF2
}

CURRENT_ENV=$(grep -E '^SQUARE_ENVIRONMENT=' "$ENV_FILE" | cut -d= -f2)
if [ "$REAL" = 0 ] && [ "$CURRENT_ENV" = production ]; then
  # Real payments are on: never switch back to test mode. This run only replaces keys.
  bold "Real payments are already on. This run only replaces keys (answer y to the ones to change)."
  secret ANTHROPIC_API_KEY "Claude console -> API keys."
  secret CLOUDFLARE_API_TOKEN "Cloudflare -> My Profile -> API Tokens (same permissions as before)."
  secret SQUARE_ACCESS_TOKEN "Square app -> Credentials (Production) -> Production Access token."
  secret SQUARE_WEBHOOK_SIGNATURE_KEY "Square app -> Webhooks (Production) -> your subscription -> Signature key."
  bold "Putting the new keys to use"
  (cd functions && npm ci --silent)
  firebase deploy --only functions
  bold "Done"
  exit 0
fi

if [ "$REAL" = 0 ]; then
  bold "2. Accounts (once). Open each link, then come back here."
  cat <<'TXT'
  a) Claude: https://console.anthropic.com -> Billing: add a card and set a monthly limit (like $20).
     Then API keys -> Create key. Each new site costs about 11 cents, each change about 3 cents.
  b) Square: https://developer.squareup.com/apps -> "+" -> name it Web Burrito.
     Keep the page on "Sandbox" for now (test cards only).
  c) Cloudflare: https://dash.cloudflare.com -> add a payment method (Manage account -> Billing),
     open Domain Registration and accept the agreement, and set a default contact there.
  d) Firebase: https://console.firebase.google.com/project/web-burrito/authentication/providers
     -> Email/Password -> turn on "Email link (passwordless sign-in)" -> Save.
TXT
  pause

  bold "3. Keys (hidden while you paste)"
  secret ANTHROPIC_API_KEY "Claude console -> API keys -> the key you just made (starts with sk-ant-)."
  secret SQUARE_ACCESS_TOKEN "Square app -> Credentials (Sandbox) -> Sandbox Access token -> Show."
  echo "  Square app -> Webhooks -> Subscriptions (Sandbox) -> Add subscription:"
  echo "    URL https://webburrito.com/api/app/square-webhook"
  echo "    Events: invoice.payment_made, invoice.scheduled_charge_failed, subscription.created,"
  echo "            subscription.updated, refund.created, refund.updated, dispute.created"
  secret SQUARE_WEBHOOK_SIGNATURE_KEY "Then open that subscription -> Signature key -> Show."
  cat <<'TXT'
  Cloudflare -> My Profile -> API Tokens -> Create Token -> Custom token, with:
    Account: Registrar Domains Edit, Workers Scripts Edit, Workers KV Storage Edit, Email Routing Addresses Edit
    Zone (All zones): Zone Edit, DNS Edit, Workers Routes Edit, Email Routing Rules Edit
TXT
  secret CLOUDFLARE_API_TOKEN "Create it and copy the token (Cloudflare shows it once)."

  bold "4. IDs (not secret)"
  setting SQUARE_APPLICATION_ID "Square app -> Credentials (Sandbox) -> Sandbox Application ID." '^sandbox-sq0idb-[A-Za-z0-9_-]+$' "sandbox-sq0idb-..."
  setting SQUARE_LOCATION_ID "Square app -> Locations (Sandbox) -> the sandbox Location ID (not your real one)." '^[A-Z0-9]{8,32}$' "like L1A2B3C4D5E6F"
  setting CLOUDFLARE_ACCOUNT_ID "Cloudflare -> any page -> Account ID (right-hand column, or Account Home -> ... -> Copy account ID)." '^[0-9a-f]{32}$' "32 letters and numbers"
  SETTINGS="${SETTINGS}SQUARE_ENVIRONMENT=sandbox
PLATFORM=on
"
  MSG="Turn on the customer platform (test mode)"
else
  # The Claude and Cloudflare keys and the Cloudflare account come from the test-mode run.
  grep -qE '^CLOUDFLARE_ACCOUNT_ID=[0-9a-f]{32}$' "$ENV_FILE" || { echo "Run bash tools/go_live.sh first (test mode). --real comes after that."; exit 1; }
  bold "Switching to real payments"
  cat <<'TXT'
  In the Square app, switch the page from "Sandbox" to "Production":
    Credentials -> Production Application ID and Production Access token
    Webhooks -> add the same subscription (URL and events) under Production -> its Signature key
TXT
  setting SQUARE_APPLICATION_ID "Production Application ID." '^sq0idp-[A-Za-z0-9_-]+$' "sq0idp-..."
  setting SQUARE_LOCATION_ID "Production Location ID (Web Burrito's is LAET0GFY9RXSR)." '^[A-Z0-9]{8,32}$' "like LAET0GFY9RXSR"
  echo "  Now the two Production keys (they replace the sandbox ones):"
  secret SQUARE_ACCESS_TOKEN "Production Access token." always
  secret SQUARE_WEBHOOK_SIGNATURE_KEY "Signature key of the Production webhook subscription." always
  SETTINGS="${SETTINGS}SQUARE_ENVIRONMENT=production
PLATFORM=on
"
  MSG="Switch the customer platform to real payments"
fi

bold "5. Saving the settings and putting it online"
apply_settings
if ! git diff --quiet -- "$ENV_FILE"; then
  # Uses your git name if you have one set; otherwise the business's.
  if git config user.email >/dev/null; then git commit -q -m "$MSG" -- "$ENV_FILE"
  else git -c user.name="Web Burrito" -c user.email="hello@webburrito.com" commit -q -m "$MSG" -- "$ENV_FILE"; fi
  echo "  ✓ settings saved"
fi
(cd functions && npm ci --silent)
firebase deploy --only functions,hosting,firestore
# Then GitHub gets the settings too (also a commit left by an earlier run whose push failed), so
# a later deploy from another copy keeps the platform on. A failed push doesn't undo going live.
git fetch -q origin main || true
if [ -n "$(git rev-list origin/main..HEAD)" ]; then
  if git push -q origin HEAD:main; then echo "  ✓ settings saved on GitHub"
  else
    echo "  ! The platform is online, but the settings didn't reach GitHub. Run this here, and sign in to"
    echo "    GitHub if it asks:  git pull --rebase origin main && git push origin HEAD:main"
    echo "    Until then, deploy only from this folder."
  fi
fi

bold "Done"
if [ "$REAL" = 0 ]; then
  cat <<'TXT'
  Within a few minutes the platform sets itself up (Square plans and site hosting).
  Then open https://webburrito.com/admin/ -> Customers: the setup line says when sign-ups are open.
  Try it at https://webburrito.com/app/ with Square's test card 4111 1111 1111 1111
  (any future date, any CVV, ZIP 94103). Nothing is charged and no domain is bought in test mode.
  When you're happy: bash tools/go_live.sh --real
TXT
else
  cat <<'TXT'
  Real payments are on. The real Square plans set themselves up within a few minutes.
  From now on a paid sign-up buys a real domain (at cost on your Cloudflare card, about $11 a year
  for a .com). Do one real purchase yourself, check the site goes live, then refund it in Square:
  the site goes offline by itself.
TXT
fi
