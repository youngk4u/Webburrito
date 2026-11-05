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
PREVIEW_PASSCODE=<code> python3 tools/build_previews.py <folder with concept sites> [slug ...]
```

Each `<slug>/send.html` is encrypted with the passcode (AES-256-GCM) and wrapped in `tools/preview_gate.html`. The pages are marked noindex and are not in the sitemap.

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

- Signing in to `/admin/` on a phone or computer marks that device as yours. Your own visits from it are shown as "you" and left out of the totals. Sign in once on each device you check previews with.
- Add `?r=` to a link to tell links apart, e.g. `webburrito.com/mami-king/?r=sms` vs `?r=instagram`.
- No cookies or IP addresses are stored. Each browser gets a random ID.

Data lives in Firestore: `previews/{slug}` (totals), `visits/{slug}_{session}` (one per visit) and `leads/{id}` (form requests). Only admins can read it. From the browser, the only change anyone can make is an admin marking a request done or new.

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
8. **Make yourself an admin.** In *Firestore Database*, click *Start collection* and name it `admins`. Set the **Document ID** to the Google email you'll sign in with, in lowercase, and add any field (for example `name` = your name). Then open `https://web-burrito.web.app/admin/` and sign in. Add teammates the same way.
9. **Test it.** Open a preview at `https://web-burrito.web.app/<slug>/` on a device that isn't signed in to `/admin/`, and send a test request from the home page form. Watch both appear on the dashboard.

### Automatic deploys (replaces GitHub Pages' auto-publish)

Once these steps are done, every push to `main` publishes the site, and every pull request gets its own preview link, posted as a PR comment.

1. In [Google Cloud console](https://console.cloud.google.com/iam-admin/serviceaccounts) (pick your project), go to *Service accounts → Create service account* and name it `github-deploy`. Give it these roles: **Firebase Hosting Admin**, **Firebase Authentication Admin**, **Cloud Run Viewer**, **API Keys Viewer**.
2. Open the new account and go to *Keys → Add key → Create new key → JSON*. A file downloads.
3. On GitHub, go to *youngk4u/Webburrito → Settings → Secrets and variables → Actions → New repository secret*. Name it `FIREBASE_SERVICE_ACCOUNT` and paste the whole file as the value. Then delete the downloaded file.

The workflows skip quietly until the secret exists. When `functions/` or `firestore.rules` change, deploy them by hand:

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

## Customer accounts (next)

`firestore.rules` already has a place for customer records: `users/{uid}`, plus anything under it such as invoices or change requests. A signed-in customer can read only their own record. Only admins and Cloud Functions can write to it, so customers can't change their own plan. The customer login page is the next thing to build.

## Local development

Run the whole thing offline with the Firebase emulators (needs Java 21):

```bash
cd functions && npm ci && cd ..
```

```bash
npx firebase-tools emulators:start --project demo-webburrito
```

Then open http://127.0.0.1:5050. On `/admin/`, use *Emulator sign-in* and add yourself to `admins` in the emulator's Firestore. Function tests: `cd functions && npm test`.

The site is served from the repo root, so the `ignore` list in `firebase.json` is what keeps `.git`, `tools/`, `functions/` and this README off the web. If you add a folder that isn't part of the site, add it there too.

## Costs

The free allowance on Blaze covers this site several times over:

| Service | Free allowance |
| --- | --- |
| Hosting | 10 GB stored and 360 MB served a day (the site is about 17 MB) |
| Functions | 2 million calls a month (each preview visit makes 2 to 4) |
| Firestore | 50,000 reads and 20,000 writes a day |

The function is capped at 3 instances, so a flood of fake traffic can't run up a bill.
