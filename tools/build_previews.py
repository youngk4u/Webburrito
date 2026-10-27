#!/usr/bin/env python3
"""Publish passcode-locked concept previews at webburrito.com/<slug>/.

Usage (from the repo root):
  PREVIEW_PASSCODE=xxxx python3 tools/build_previews.py <concept sites dir> [slug ...]

<concept sites dir>/<slug>/ must hold send.html (the concept page), photos.json and img/*.jpg.
Each page is encrypted (AES-256-GCM, key from the passcode via PBKDF2-SHA256), so the repo only
holds the locked version. The passcode is never written to the repo.
Photos are copied to <slug>/img/ so the page doesn't depend on Unsplash hotlinks.
"""
import base64, json, os, re, secrets, shutil, sys, html as H
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ITER = 250_000
PASS = os.environ.get("PREVIEW_PASSCODE")
if not PASS:
    sys.exit("Set PREVIEW_PASSCODE")
src_dir = sys.argv[1]
slugs = sys.argv[2:] or sorted(d for d in os.listdir(src_dir) if os.path.isfile(os.path.join(src_dir, d, "send.html")))

GATE = open(os.path.join(ROOT, "tools", "preview_gate.html"), encoding="utf-8").read()

def b64(b): return base64.b64encode(b).decode()

for slug in slugs:
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

    salt, iv = secrets.token_bytes(16), secrets.token_bytes(12)
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITER).derive(PASS.encode())
    ct = AESGCM(key).encrypt(iv, page.encode("utf-8"), None)
    payload = json.dumps({"v": 1, "iter": ITER, "salt": b64(salt), "iv": b64(iv), "ct": b64(ct)})

    out_dir = os.path.join(ROOT, slug)
    os.makedirs(os.path.join(out_dir, "img"), exist_ok=True)
    for name in set(re.findall(r"img/([\w-]+)\.jpg", page)):
        shutil.copyfile(os.path.join(d, "img", name + ".jpg"), os.path.join(out_dir, "img", name + ".jpg"))
    open(os.path.join(out_dir, "index.html"), "w", encoding="utf-8").write(GATE.replace("__PAYLOAD__", payload))
    print("locked", slug, len(page), "bytes")
