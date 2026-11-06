"""How previews are locked, shared by build_previews.py and preview_links.py.

A preview's page is encrypted with AES-256-GCM under a page key. The page key comes from the
passcode (PBKDF2-SHA256), so the passcode opens the page, and a copy of the page key is locked
with the secret in that business's personal link (webburrito.com/<slug>/#k=<secret>), so the
link opens it too. The secret is 16 random bytes and never stored in the repo; only its locked
copy of the page key is. "Make it mine" is only automatic with the personal link: the server
checks the secret the same way the page does.
"""
import base64, hashlib, json, re, secrets, gzip
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes

ITER = 250_000
SITE = "https://webburrito.com"
PAYLOAD = re.compile(r'<script type="application/json" id="payload">(.*?)</script>', re.S)


def b64(b): return base64.b64encode(b).decode()
def unb64(s): return base64.b64decode(s)
def b64url(b): return base64.urlsafe_b64encode(b).rstrip(b"=").decode()
def unb64url(s): return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def page_key(passcode, salt, iterations=ITER):
    return PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=iterations).derive(passcode.encode())


def link_slot(pk, secret=None):
    """The page key locked with a personal link's secret. Returns (secret, slot)."""
    secret = secret or secrets.token_bytes(16)
    iv = secrets.token_bytes(12)
    return secret, {"iv": b64(iv), "ct": b64(AESGCM(hashlib.sha256(secret).digest()).encrypt(iv, pk, None))}


def personal_link(slug, secret):
    return f"{SITE}/{slug}/#k={b64url(secret)}"


def payload_of(index_html):
    """The payload dict of a preview page, or None for a normal page."""
    m = PAYLOAD.search(index_html)
    return json.loads(m.group(1)) if m else None


def open_with_passcode(P, passcode):
    """(page key, page html). Raises cryptography's InvalidTag if the passcode is wrong."""
    pk = page_key(passcode, unb64(P["salt"]), int(P["iter"]))
    return pk, read(P, pk)


def open_with_link(P, secret):
    """Page html, opened the way the personal link does. Raises InvalidTag if it doesn't fit."""
    pk = AESGCM(hashlib.sha256(secret).digest()).decrypt(unb64(P["lk"]["iv"]), unb64(P["lk"]["ct"]), None)
    return read(P, pk)


def read(P, pk):
    pt = AESGCM(pk).decrypt(unb64(P["iv"]), unb64(P["ct"]), None)
    if P.get("z") == "gz":
        pt = gzip.decompress(pt)
    return pt.decode("utf-8")
