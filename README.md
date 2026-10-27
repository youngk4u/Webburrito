# Web Burrito

Website for Web Burrito: website, domain, hosting, business email and Google listing for small businesses, all rolled into one.

- `index.html` is the whole site (one self-contained file).
- `CNAME` points GitHub Pages at webburrito.com.

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
