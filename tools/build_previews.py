#!/usr/bin/env python3
"""Publish passcode-locked concept previews at webburrito.com/<slug>/.

Usage (from the repo root):
  PREVIEW_PASSCODE=xxxx python3 tools/build_previews.py <concept sites dir> [slug ...]
  PREVIEW_PASSCODE=xxxx python3 tools/build_previews.py <mapping.json>

Mode 1: <concept sites dir>/<slug>/ holds send.html (the concept page), photos.json and img/*.jpg.
Mode 2: mapping.json is {"<slug>": "<path to a single self-contained concept .html>"}; the page is
encrypted as-is (photos stay as the links already in the page).
Each page is encrypted (AES-256-GCM, key from the passcode via PBKDF2-SHA256), so the repo only
holds the locked version. The passcode is never written to the repo.

Each new preview also gets a personal link, https://webburrito.com/<slug>/#k=..., which opens it
without the passcode and lets the owner use "Make it mine" (see tools/preview_crypto.py). The links
are printed ("link <slug> <url>") and, with PREVIEW_LINKS=<file.json> set, added to that file. Keep
them out of the repo: put each one in the sheet's Preview link column and in the pitch email.
Rebuilding a preview that already has a personal link keeps the same link.

Photos are copied to <slug>/img/ so the page doesn't depend on Unsplash hotlinks.
The gate page also reports opens to /api/track (see functions/), shown on /admin/.
After editing tools/preview_gate.html, run tools/rewrap_previews.py to update existing previews.
"""
import json, os, re, secrets, shutil, sys
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from preview_crypto import ITER, b64, unb64, page_key, link_slot, personal_link, payload_of, read  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PASS = os.environ.get("PREVIEW_PASSCODE")
if not PASS:
    sys.exit("Set PREVIEW_PASSCODE")
src_dir = sys.argv[1]
MAPPING = json.load(open(src_dir)) if src_dir.endswith(".json") else None
if MAPPING is not None:
    slugs = sys.argv[2:] or sorted(MAPPING)
else:
    slugs = sys.argv[2:] or sorted(d for d in os.listdir(src_dir) if os.path.isfile(os.path.join(src_dir, d, "send.html")))
RESERVED = {"assets", "img", "tools", "brand", "guides", "industries", "restaurant-websites", "food-truck-websites",
            "bakery-websites", "auto-repair-websites", "salon-websites", "contractor-websites",
            "admin", "api", "account", "functions", "app", "terms", "privacy"}

GATE = open(os.path.join(ROOT, "tools", "preview_gate.html"), encoding="utf-8").read()
LINKS_FILE = os.environ.get("PREVIEW_LINKS")
new_links = {}


def lock(slug, page):
    """The payload for this page. Keeps the personal link if the preview already has one."""
    old = None
    path = os.path.join(ROOT, slug, "index.html")
    if os.path.isfile(path):
        old = payload_of(open(path, encoding="utf-8").read())
    salt = slot = None
    if old and old.get("lk") and int(old.get("iter", 0)) == ITER:
        pk = page_key(PASS, unb64(old["salt"]), ITER)
        try:
            read(old, pk)  # same passcode and salt, so the old link still opens the new page
            salt, slot = unb64(old["salt"]), old["lk"]
        except InvalidTag:
            pass
    if salt is None:
        salt = secrets.token_bytes(16)
        pk = page_key(PASS, salt, ITER)
        secret, slot = link_slot(pk)
        new_links[slug] = personal_link(slug, secret)
    iv = secrets.token_bytes(12)
    ct = AESGCM(pk).encrypt(iv, page.encode("utf-8"), None)
    return json.dumps({"v": 1, "iter": ITER, "salt": b64(salt), "iv": b64(iv), "ct": b64(ct), "lk": slot})


def noindex(page):
    return re.sub(r"<head([^>]*)>", lambda m: m.group(0) + '\n<meta name="robots" content="noindex,nofollow">', page, count=1)


for slug in slugs:
    assert re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", slug) and slug not in RESERVED, slug
    if MAPPING is not None:
        page = noindex(open(MAPPING[slug], encoding="utf-8").read())
        out_dir = os.path.join(ROOT, slug)
        os.makedirs(out_dir, exist_ok=True)
        payload = lock(slug, page)
        open(os.path.join(out_dir, "index.html"), "w", encoding="utf-8").write(GATE.replace("__PAYLOAD__", payload))
        print("locked", slug, len(page), "bytes")
        continue
    d = os.path.join(src_dir, slug)
    page = open(os.path.join(d, "send.html"), encoding="utf-8").read()
    photos = json.load(open(os.path.join(d, "photos.json")))
    by_id = {}
    for name, pid in photos.items():
        by_id.setdefault(pid, name)
    page = re.sub(r"https://images\.unsplash\.com/photo-([\w-]+)\?[^\"')\s]*",
                  lambda m: f"img/{by_id[m.group(1)]}.jpg", page)
    assert "unsplash.com" not in page, slug
    page = page.replace("<head>", '<head>\n<meta name="robots" content="noindex,nofollow">', 1)
    payload = lock(slug, page)

    out_dir = os.path.join(ROOT, slug)
    os.makedirs(os.path.join(out_dir, "img"), exist_ok=True)
    for name in set(re.findall(r"img/([\w-]+)\.jpg", page)):
        shutil.copyfile(os.path.join(d, "img", name + ".jpg"), os.path.join(out_dir, "img", name + ".jpg"))
    open(os.path.join(out_dir, "index.html"), "w", encoding="utf-8").write(GATE.replace("__PAYLOAD__", payload))
    print("locked", slug, len(page), "bytes")

for slug, url in new_links.items():
    print("link", slug, url)
if new_links and LINKS_FILE:
    links = json.load(open(LINKS_FILE)) if os.path.isfile(LINKS_FILE) else {}
    links.update(new_links)
    with open(LINKS_FILE, "w") as f:
        json.dump(links, f, indent=1, sort_keys=True)
    print(f"{len(new_links)} personal link(s) saved to {LINKS_FILE}")
