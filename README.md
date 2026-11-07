# Web Burrito

Website for Web Burrito: website, domain, hosting, business email and Google listing for small businesses, all rolled into one.

- `index.html` is the home page (one self-contained file).
- Hosted on **Firebase Hosting** (`firebase.json`). The site is served straight from the repo root.
- `functions/` is the Cloud Function behind `/api/*`; `firestore.rules` controls who can read the database.
- `/admin/` is the private dashboard: free preview requests from the home page form, and who opened which preview, and how many times.

A Qoop studio · hello@webburrito.com

## Extra pages (industry pages, pricing guide, sitemap)

`index.html` is edited by hand. Everything else is generated:

```
python3 tools/build_pages.py
```

- Page text lives in `tools/pages.py` (industry pages) and `tools/guide_body.html` (pricing guide).
- The script copies the `<style>` from `index.html` into `assets/site.css`, so re-run it after changing the home page design.
- It also rewrites `sitemap.xml`, `robots.txt` and `404.html`. Add new pages to the script so they land in the sitemap.

## Private customer previews

Concept sites live at `webburrito.com/<business-slug>/` behind a passcode. Only the encrypted page is in this repo.

```
PREVIEW_PASSCODE=<code> PREVIEW_LINKS=<file outside the repo>.json python3 tools/build_previews.py <folder with concept sites> [slug ...]
```

Each `<slug>/send.html` is encrypted with the passcode (AES-256-GCM) and wrapped in `tools/preview_gate.html`. The pages are marked noindex and are not in the sitemap.

**Personal links.** Each preview also gets its own link, `https://webburrito.com/<slug>/#k=...`, printed by the build and saved to the `PREVIEW_LINKS` file. It opens the preview with no passcode to type, and it's what lets the owner put the site online by themselves with *Make it mine*. The secret after `#k=` never reaches the server logs or this repo (the repo is public): it goes in the sheet's *Preview link* column and in the pitch email, nowhere else. Rebuilding a preview keeps its link. To give older previews a link, or to replace a lost or leaked one:

```
PREVIEW_PASSCODE=<code> python3 tools/preview_links.py --out <file outside the repo>.json            # every preview without one
PREVIEW_PASSCODE=<code> python3 tools/preview_links.py --new --out <file>.json <slug>               # replace that link
```

After changing `tools/preview_gate.html`, update every existing preview (no passcode needed; the encrypted part is untouched):

```
python3 tools/rewrap_previews.py
```

## Free preview requests (home page form)

The "Free preview" form on the home page saves each request to the database (`/api/lead`). New requests appear at the top of `/admin/`, with *Call* and *Text* links and a *Mark done* button. The browser tab shows how many are new, like `(2) Preview Tracker`.

- If a request can't be saved (no connection, or a server problem), the form offers a text message or an email with the details already filled in, so nothing gets lost.
- A hidden field catches spam bots: they get a "sent" message, but nothing is saved.
- Requests you send yourself from a device signed in to `/admin/` are tagged "you" and don't count as new.

## Preview tracker (`/admin/`)

The passcode page on every preview reports to `/api/track` when it's opened. Sign in at `webburrito.com/admin/` to see:

- **Opened**: how many times someone got past the passcode (once per browser tab, so reloads don't count twice).
- **Link visits**: taps on the link, including people who never entered the passcode.
- **Devices**: how many different phones or computers opened it.
- **Wrong code**: wrong passcode attempts (a good reason to call them).
- **Time on site** and how far they scrolled.
- Each visit: when, device, browser or app (Instagram, Facebook, KakaoTalk...), time zone and phone language.

Tips:

- Signing in to `/admin/` on a phone or computer marks that browser as yours, including visits it made before you signed in. Your own visits from it are shown as "you" and left out of the totals. Sign in once on each device you check previews with.
- Opened a preview on a phone or browser that isn't marked (another browser, the Instagram or Messages in-app browser, a phone you never signed in on)? Click **That was me** on that visit. Every visit from that browser is then shown as "you", taken out of the totals, and its later visits are marked as they happen. **Not me** undoes it.
- Add `?r=` to a link to tell links apart, e.g. `webburrito.com/mami-king/?r=sms` vs `?r=instagram`.
- No cookies or IP addresses are stored. Each browser gets a random ID.

Data lives in Firestore: `previews/{slug}` (totals), `visits/{slug}_{session}` (one per visit), `leads/{id}` (form requests) and `mine/{visitor}` (browsers marked as yours). Only admins can read it. From the browser, the only changes anyone can make are an admin marking a request done or new, and an admin marking a browser as theirs (through `/api/mine`, which checks the sign-in and recounts the totals).

## One-time setup

These are done for the `web-burrito` project; they're kept here in case the project ever needs to be set up again. They're done in the Firebase console and on your computer.

1. **Create the project.** Go to [console.firebase.google.com](https://console.firebase.google.com) and click *Create a project*. Google Analytics isn't needed. This project's ID is `web-burrito`.
2. **Switch to the Blaze plan** (*Upgrade*, bottom left). Cloud Functions need it. Normal use stays inside the free allowance. In Google Cloud *Billing → Budgets & alerts*, set a $5 budget alert anyway.
3. **Create the database.** Go to *Build → Firestore Database → Create database*, choose location `nam5 (United States)` (this can't be changed later), and pick *production mode*.
4. **Register a web app.** Open *Project settings* (gear icon) and under *Your apps* click the web icon `</>`. Give it any nickname, tick *Also set up Firebase Hosting*, and click Register. Skip the code snippet; the site loads the settings by itself.
5. **Turn on Google sign-in.** Go to *Build → Authentication → Get started → Sign-in method → Google → Enable*, then Save.
6. **Project ID**: already set to `web-burrito` in `.firebaserc`.
7. **First deploy, from your computer.** This needs [Node.js](https://nodejs.org) 22 or newer; check with `node --version`. On Node 21 or older, the deploy fails with `ERR_REQUIRE_ESM`.

   ```bash
   npm install -g firebase-tools
   ```

   ```bash
   firebase login
   ```

   ```bash
   cd functions && npm ci && cd ..
   ```

   ```bash
   firebase deploy
   ```

   This publishes the site, the `api` function, and the database rules. If it asks about a cleanup policy for container images, accept the default. The site is now live at `https://web-burrito.web.app`.
8. **Let the `api` function write to the database.** Open [IAM](https://console.cloud.google.com/iam-admin/iam) for the project, click *Grant access*, enter `PROJECT_NUMBER-compute@developer.gserviceaccount.com` (the *Default compute service account*; `web-burrito` is `945782518303-compute@developer.gserviceaccount.com`) and give it the **Cloud Datastore User** role. Projects inside a Google Workspace organization don't give that account any roles automatically; without this, `/api/track` and `/api/lead` answer 500 and no visits or requests are saved. It takes a few minutes to start working.
9. **Make yourself an admin.** In *Firestore Database*, click *Start collection* and name it `admins`. Set the **Document ID** to the Google email you'll sign in with, in lowercase, and add any field (for example `name` = your name). Then open `https://web-burrito.web.app/admin/` and sign in. Add teammates the same way.
10. **Test it.** Open a preview at `https://web-burrito.web.app/<slug>/` on a device that isn't signed in to `/admin/`, and send a test request from the home page form. Watch both appear on the dashboard.

### Automatic deploys (replaces GitHub Pages' auto-publish)

Once this is set up, every push to `main` publishes the site, so each day's new previews go live by themselves. GitHub signs in to Google with **Workload Identity Federation**: Google trusts this repo's `main` branch and lets the deploy workflow act as the deploy account (`github-action-1430418918@web-burrito.iam.gserviceaccount.com`) for a few minutes per run. No key is stored anywhere. That's the only way that works here, because the project's Google organization blocks service account keys (`iam.managed.disableServiceAccountKeyCreation`), so `firebase init hosting:github` stops when it tries to make one.

**One-time setup.** Open [Google Cloud Shell](https://console.cloud.google.com/?cloudshell=true&project=web-burrito), signed in as the project's owner (hello@webburrito.com), paste this and press Enter:

```bash
gcloud config set project web-burrito
gcloud services enable iamcredentials.googleapis.com sts.googleapis.com
gcloud iam workload-identity-pools create github --location=global --display-name="GitHub"
gcloud iam workload-identity-pools providers create-oidc webburrito --location=global --workload-identity-pool=github \
  --display-name="youngk4u/Webburrito main" --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
  --attribute-condition="assertion.repository=='youngk4u/Webburrito' && assertion.ref=='refs/heads/main'"
SA=github-action-1430418918@web-burrito.iam.gserviceaccount.com
gcloud iam service-accounts describe $SA >/dev/null 2>&1 || gcloud iam service-accounts create github-action-1430418918 --display-name="GitHub deploys"
gcloud iam service-accounts add-iam-policy-binding $SA --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/945782518303/locations/global/workloadIdentityPools/github/attribute.repository/youngk4u/Webburrito"
for r in firebasehosting.admin firebase.viewer run.viewer cloudfunctions.viewer serviceusage.apiKeysViewer serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding web-burrito --member="serviceAccount:$SA" --role="roles/$r" --condition=None --quiet >/dev/null && echo "  role $r ok"
done
echo "Done: pushes to main now publish the site."
```

The deploy workflow (`.github/workflows/firebase-hosting-merge.yml`) skips with a notice until this is done. Only `main` of this repo can sign in, and the account can only publish the site (Hosting) and read what a deploy needs. Pull-request previews (`firebase-hosting-pull-request.yml`) stay off: they need a key. When `functions/` or `firestore.rules` change, deploy them by hand:

```bash
firebase deploy --only functions,firestore
```

### Move webburrito.com to Firebase (do this last)

The domain's DNS is at **Cloudflare**. `webburrito.com` is the main address and `www.webburrito.com` redirects to it, the same as on GitHub Pages.

1. In the Firebase console, go to *Hosting → Add custom domain* and enter `webburrito.com`. If it offers **Advanced setup**, choose it: the HTTPS certificate is then created before you switch, so there's no gap. Keep the page open; it lists the DNS records to add.
2. In Cloudflare, open `webburrito.com` and go to **DNS → Records**:
   - Delete the GitHub Pages records for `webburrito.com`: the four `A` records (`185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`) and any `AAAA` records starting `2606:50c0`.
   - Add exactly the records Firebase shows: usually one `A` record and one `TXT` record (`hosting-site=web-burrito`), plus a `TXT` for the certificate with Advanced setup.
   - **Set the Proxy status of the Firebase `A` record to *DNS only* (grey cloud).** If it's proxied (orange cloud), Firebase can't verify the domain or issue the certificate.
   - Leave the other `TXT` records alone (SPF, DKIM, DMARC, Google verification). Cloudflare allows several `TXT` records on the same name.
   - **Don't change the `MX` records.** Those run the hello@webburrito.com email.
   - If there are any `CAA` records, add two more so Firebase's certificate can be issued: `0 issue "letsencrypt.org"` and `0 issue "pki.goog"`.
3. Back in Firebase, click *Verify*. Wait until `webburrito.com` shows as *Connected*. It usually takes under an hour, at most a day. Until then the HTTPS certificate isn't ready, so the site only opens as `http://` and the browser says "Not secure". Once it's *Connected*, Firebase serves HTTPS and redirects `http://` to it automatically.
4. Add a second domain: `www.webburrito.com`, and choose *Redirect to webburrito.com*. In Cloudflare, replace the `www` record (now a `CNAME` to `youngk4u.github.io`) with what Firebase shows, again set to **DNS only**.
5. In *Authentication → Settings → Authorized domains*, add `webburrito.com` and `www.webburrito.com` so admin sign-in works there.
6. In *GitHub → Settings → Pages*, turn GitHub Pages off. (`CNAME` and `.nojekyll` have already been removed.)

## Customer platform (`/app/`)

Customers sign up at **webburrito.com/app/** and do everything themselves:

**Accounts.** *Create account* with an email and password (or *Continue with Google*); *Log in* on any device (`/app/?login` opens on it, and so does a browser that has signed in before); *Forgot your password?* emails a link to set a new one. A password account gets a confirm-your-email link (it only counts when opened logged in to that account, so a stranger who signs up with someone else's email can't get it confirmed by them): everything works before it's confirmed except paying (the server refuses `/subscribe`, `/domain`, `/publish`, `/email`, `/card` and `/cancel` until it is), so receipts and domain emails reach a real inbox. An address in `admins` only counts as an admin once it's confirmed. The home page shows **Log in** (header, and footer) once sign-ups are open, and its free-preview form takes an email or a phone number (one of the two).

1. **From their preview:** once sign-ups are open, every preview's banner gets a **Make it mine** button. It takes the owner to `/app/` with that preview; after signing in it's claimed by itself, no link or passcode to type. The preview is made ready to go live on the spot: concept banner and `noindex` removed, the order form becomes a "Call or text us" box, buttons that needed scripts are taken out, and one quick AI pass removes sentences that only made sense on a preview ("On the live site…", "Stand-in photos"). Their name, phone and address are read off the page.
2. **Or from scratch:** fill in the business details and have the AI build a site. **3 free tries** before paying; after that, a monthly allowance by plan (20 / 40 / 100 changes). Changes come back as quick find-and-replace edits: a few seconds and a few cents each.
3. **Pay:** pick a plan; their name as a .com is suggested and checked, and the domain owner's details are filled in from the business address. After the first payment clears, the server **buys the domain in their name** (Cloudflare Registrar), **checks the site with AI** (made-up claims, brand copying, phishing, broken pages; on a claimed preview, the ratings and review quotes Web Burrito took from the business's public listings count as real) and **puts it online** with HTTPS. Usually under a minute.
4. **Later:** ask for changes and click *Publish* (checked again first), set up email forwarding addresses (The Super: 3, The Loaded: 10), change card, cancel, or **download their site** (one HTML file; no lock-in). Every live site is indexable, has one canonical address, a sitemap, and the business's name, phone and address in schema.org form for Google.

Taps on *Make it mine* show up on `/admin/` with the visit ("tapped Make it mine"), so you can see who's about to buy. While the platform is in test mode, only your own devices (marked on `/admin/`) see the button.

Only the business's personal link proves the preview was sent to them, so only a claim from it launches by itself. The shared passcode still opens every preview (for showing it in person, and for older pitch emails), and *Make it mine* works from there too, but after paying, that launch waits before any domain is bought: `/admin/` marks it "opened with the passcode: check it's the owner", and **Approve owner and launch** puts it online once you've checked (a call to the shop is enough). The customer sees "Your domain will be registered after a quick check by Web Burrito (usually within a day).

Square webhooks record payments, failed payments, cancellations, refunds and chargebacks; a job (`launcher`) runs every minute to carry launches forward (a step that fails is retried with growing gaps, up to an hour apart), settle unclear checkouts and take sites offline 14 days after a failed payment. A full refund or a chargeback on the plan's own payment cancels the plan and takes the site down; one on some other payment of the same Square customer is only flagged. Canceling a paid-up plan keeps the site up until the end of the paid period; canceling an unpaid one (first payment pending, or a payment failed) ends it right away and voids the unpaid invoice. A domain bought for a customer stays theirs: nobody else can pick it, and if they come back later their new plan uses it again without buying it twice. Customers and their launch status are listed on `/admin/` under *Customers*, with *Retry launch*, *Take offline* and *Put back online*, plus warnings to look at: a domain whose auto-renew didn't turn on, a partial refund, a refund or dispute on another payment, a payment that came in after a plan ended (refund it in Square), and Square subscriptions on Web Burrito plans that no account claimed.

Safety rails: one build at a time per customer; one payment at a time per account (paying twice while Square's answer is unclear never starts a second subscription); free tries are only given back when Claude refused the request; site checks count toward the monthly allowance (only checks that finish); per-customer rate limits; look-alike brand domains (banks, PayPal, "login", "verify"...) are refused; pages are stripped of scripts, forms and inputs, and customer sites are served with a policy that blocks scripts and form posts; at most 10 domains are bought automatically per day (more wait for *Retry launch*, which approves them); a site taken offline by you, a refund or a chargeback can't be put back by the customer. Long requests (building, publishing) go straight to the function's own address because Firebase Hosting cuts requests off after 60 seconds.

How it's built:

| Piece | Where |
| --- | --- |
| Customer page | `app/index.html` |
| API (`/api/app/*`) | `functions/app/` (function `app`) |
| AI prompts (build + check) | `functions/app/ai.js` (verified stock photos in `photos.json`) |
| Launch steps: payment → domain → check → live | `functions/app/launch.js` |
| Preview → live clean-up, quick edits, search-engine data | `functions/app/site.js` |
| One-command go-live | `tools/go_live.sh` |
| Server for customer sites (Cloudflare Worker + KV) | `functions/app/sites-worker.js`, uploaded by *Set up site hosting* |
| Settings (not secret) | `functions/.env` |
| Terms and privacy pages | `tools/legal_*.html` → `python3 tools/build_pages.py` |

**Test mode.** Until `SQUARE_ENVIRONMENT=production`, payments use Square's sandbox (test cards, no real money) and **no domain is bought** (Cloudflare has no test mode), so you can try the whole flow for free. The last step then says where the site *would* be live. In test mode only admins and the emails in `TEST_EMAILS` (in `functions/.env`) can pay; everyone else sees "Sign-ups open soon". Test-mode plans don't carry over when you switch to real payments.

### Going live with the platform

**One command** from your copy of the repo (`~/webburrito-deploy`):

```bash
bash tools/go_live.sh          # test mode: Square sandbox, test cards, no domain bought
bash tools/go_live.sh --real   # later: real payments and real domains
```

It walks you through the four accounts (Claude, Square, Cloudflare, Firebase email accounts), asks for each key with hidden typing (straight into Google Secret Manager, never into a file), fills in the IDs, turns the platform on, commits and deploys. Square plans and site hosting then **set themselves up** within a few minutes (the every-minute job does it; the buttons on `/admin/` still work). Then try `/app/` with the test card, read the terms (step 9 below) and link the home page (step 10).

What the script does, step by step, if you'd rather do it by hand (keys go into Google Secret Manager with `firebase functions:secrets:set NAME`):

1. **Claude.** At [console.anthropic.com](https://console.anthropic.com), add billing, create an API key, then `firebase functions:secrets:set ANTHROPIC_API_KEY`. Set a monthly spend limit there too (see *What it costs to run*).
2. **Square (sandbox first).** At [developer.squareup.com](https://developer.squareup.com), create an application called Web Burrito. On *Credentials* (Sandbox): put the **Application ID** in `functions/.env` as `SQUARE_APPLICATION_ID`, and `firebase functions:secrets:set SQUARE_ACCESS_TOKEN` with the **Access token**. In *Locations* (sandbox), copy the location ID into `SQUARE_LOCATION_ID`. In *Webhooks → Subscriptions*, add `https://webburrito.com/api/app/square-webhook` with the events `invoice.payment_made`, `invoice.scheduled_charge_failed`, `subscription.created`, `subscription.updated`, `refund.created`, `refund.updated` and `dispute.created`, then `firebase functions:secrets:set SQUARE_WEBHOOK_SIGNATURE_KEY` with its **Signature key**.
3. **Cloudflare.** Add a payment method (*Billing*), set a default registrant contact (*Domain Registration → Manage → Default contact*), and accept the domain registration agreement. Put the **Account ID** in `functions/.env` as `CLOUDFLARE_ACCOUNT_ID`. Create an API token (*My Profile → API Tokens → Create custom token*) with: Account → *Registrar: Domains Edit*, *Workers Scripts Edit*, *Workers KV Storage Edit*, *Email Routing Addresses Edit*; Zone (all zones) → *Zone Edit* (to add the zone for a new domain if registration doesn't), *DNS Edit*, *Workers Routes Edit*, *Email Routing Rules Edit*. Then `firebase functions:secrets:set CLOUDFLARE_API_TOKEN`.
4. **Email accounts.** Firebase console → *Authentication → Sign-in method → Email/Password* → turn on *Email/Password*, and leave *Email link (passwordless sign-in)* off (an emailed sign-in link opens an account even when someone else set its password). *Project settings → Public-facing name*: Web Burrito, the name on the account emails. Once `/app/` is deployed: *Authentication → Templates* → the pencil on any email → *Customize action URL* → `https://webburrito.com/app/`. Confirm-your-email and new-password links then open on webburrito.com, and a confirm link only counts when it's opened logged in to that account.
5. **Turn it on and deploy.** In `functions/.env`, change `PLATFORM=off` to `PLATFORM=on` (until then the platform isn't deployed at all, so deploys don't ask for the keys, and `/app/` says "Coming soon"). Then, from a clean copy of the repo: `cd functions && npm ci && cd ..`, then `firebase deploy --only functions,hosting,firestore`. This also creates the every-minute `launcher` job (Cloud Scheduler); if the deploy says a permission is missing for it, grant the role it names to the *Default compute service account* the same way as step 8 of *One-time setup*.
6. Nothing to click: within a few minutes the platform creates the Square plans and uploads the site server by itself. `/admin/` → *Customers* shows when sign-ups are open (the **Create Square plans** and **Set up site hosting** buttons do the same thing right away).
7. **Try it** at `/app/` with Square's test card `4111 1111 1111 1111` (any future date, any CVV, ZIP 94103).
8. **Real payments:** switch the Square app to *Production* credentials (new Application ID, access token, location ID `LAET0GFY9RXSR`, and a production webhook with its own signature key), set `SQUARE_ENVIRONMENT=production` and deploy again; the production plans set themselves up (or click **Create Square plans**). From now on, a paid sign-up buys a real domain, charged to your Cloudflare card at Cloudflare's at-cost price (around $10–11 a year for a .com).
9. **Read the [terms](/terms/) and [privacy policy](/privacy/)** and change anything that doesn't match how you run the business. They're a plain-language draft, not legal advice.
10. **Link it:** point the home page's sign-up buttons to `/app/` when you're happy.

Before real customers, do one real purchase yourself (your own card, a cheap .com) to confirm the Cloudflare beta registration, the zone and the domain attach work end to end, then refund it in Square; the site goes offline automatically.

### What it costs to run

| What | Cost to you |
| --- | --- |
| Customer sites (Cloudflare Workers + KV, free plan) | $0 up to 100,000 visits a day across all sites; then $5 a month for 10 million |
| Domains (Cloudflare Registrar, sold at cost) | .com $10.46 a year (about $11.17 for renewals after Nov 2026), .us $6.50; bought only after the first payment |
| AI (Claude Sonnet 5.5) | about 11¢ for a new site, about 3¢ per change (quick edits), about 2¢ per site check; a claimed preview: about 3¢ once, no check. Free tries are capped at 100 a day across everyone |
| App, admin, database, functions (Firebase) | inside the free allowances at this size |
| Square | its card fee on each payment; no monthly fee |

A Regular customer at $20 a month costs about $1 (domain) + a few cents of AI + Square's fee, so most of it is margin. Compared with the builders owners know: Wix Light is $17 a month on a yearly plan ($24 monthly) with the domain free only the first year (then about $21), Squarespace Basic $19 ($25 monthly), Durable $22 ($25 monthly), and all of them are do-it-yourself. Web Burrito is $199 a year or $20 a month with the .com included every year, built for them, changes by asking, and the site is theirs to download.

Limits worth knowing: the Cloudflare Registrar API is in beta (it can register, but renewals stay on auto-renew in the dashboard, which the platform turns on for each domain). Only `.com .net .org .us` domains under $15 are bought automatically (Cloudflare sells at cost: a .com is about $11 a year); premium domains are refused. US addresses only for now. Email addresses forward mail (they don't send). Live customer sites don't run JavaScript (it's blocked on purpose), so interactive bits from previews become plain HTML when the AI edits them. Changing the card doesn't pay an invoice that already failed: the customer pays it from the email Square sends (the page tells them so), and the site comes back as soon as it's paid. `LAUNCH_RETRY_SECONDS` in `functions/.env` sets how often waiting launches are looked at again (60 seconds).

## Local development

Run the whole thing offline with the Firebase emulators (needs Java 21):

```bash
cd functions && npm ci && cd ..
```

```bash
npx firebase-tools emulators:start --project demo-webburrito
```

Then open http://127.0.0.1:5050. On `/admin/`, use *Emulator sign-in* and add yourself to `admins` in the emulator's Firestore. Function tests: `cd functions && npm test`.

For the customer platform, put stand-in values in `functions/.secret.local` (one `NAME=value` per line for the four secrets) and point the `*_BASE_URL` settings at a local stand-in server in `functions/.env.local` (both files are git-ignored), so nothing calls the real Claude, Square or Cloudflare.

The site is served from the repo root, so the `ignore` list in `firebase.json` is what keeps `.git`, `tools/`, `functions/` and this README off the web. If you add a folder that isn't part of the site, add it there too. Before every deploy, `tools/check_deploy.mjs` stops the deploy if anything that isn't in git would be published, such as a stray copy of the project in the Dropbox folder.

## Costs

The free allowance on Blaze covers this site several times over:

| Service | Free allowance |
| --- | --- |
| Hosting | 10 GB stored and 360 MB served a day (the site is about 17 MB) |
| Functions | 2 million calls a month (each preview visit makes 2 to 4) |
| Firestore | 50,000 reads and 20,000 writes a day |

The function is capped at 3 instances, so a flood of fake traffic can't run up a bill.
