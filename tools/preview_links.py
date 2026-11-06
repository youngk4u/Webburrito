#!/usr/bin/env python3
"""Give previews their personal links (https://webburrito.com/<slug>/#k=...).

Run from the repo root:
  PREVIEW_PASSCODE=xxxx python3 tools/preview_links.py --out links.json          # every preview without one
  PREVIEW_PASSCODE=xxxx python3 tools/preview_links.py --out links.json mami-king  # just these
  PREVIEW_PASSCODE=xxxx python3 tools/preview_links.py --new --out links.json mami-king

The site inside each preview stays byte-for-byte the same; only a locked copy of its page key is
added (see tools/preview_crypto.py). A preview that already has a personal link keeps it, unless
--new is given for it (the old link then stops working, for a lost or leaked link).
Links are printed and added to the --out file. Keep them out of the repo: they go in the sheet's
Preview link column and in the pitch emails.
"""
import json, os, sys
from cryptography.exceptions import InvalidTag

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from preview_crypto import PAYLOAD, link_slot, personal_link, payload_of, open_with_passcode, open_with_link  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GATE = open(os.path.join(ROOT, "tools", "preview_gate.html"), encoding="utf-8").read()
assert GATE.count("__PAYLOAD__") == 1
PASS = os.environ.get("PREVIEW_PASSCODE") or sys.exit("Set PREVIEW_PASSCODE")

args = sys.argv[1:]
renew = "--new" in args
out = None
if "--out" in args:
    i = args.index("--out")
    out = args[i + 1]
    del args[i:i + 2]
args = [a for a in args if a != "--new"]
if renew and not args:
    sys.exit("--new needs the slugs whose links to replace")
if not out:
    sys.exit("Give --out <file.json> (outside the repo) for the links")

slugs = args or sorted(d for d in os.listdir(ROOT) if os.path.isfile(os.path.join(ROOT, d, "index.html")))
links, kept, skipped = {}, 0, []
for slug in slugs:
    path = os.path.join(ROOT, slug, "index.html")
    page = open(path, encoding="utf-8").read()
    P = payload_of(page)
    if P is None:
        if args:
            sys.exit(f"{slug}: not a passcode preview")
        continue  # a normal site page (industries, guides, ...)
    if P.get("lk") and not renew:
        kept += 1
        continue
    try:
        pk, html = open_with_passcode(P, PASS)
    except InvalidTag:
        skipped.append(slug)
        continue
    secret, P["lk"] = link_slot(pk)
    assert open_with_link(P, secret) == html
    new = GATE.replace("__PAYLOAD__", json.dumps(P))
    assert PAYLOAD.search(new) and payload_of(new) == P
    open(path, "w", encoding="utf-8").write(new)
    links[slug] = personal_link(slug, secret)
    print("link", slug, links[slug])

if links:
    saved = json.load(open(out)) if os.path.isfile(out) else {}
    saved.update(links)
    with open(out, "w") as f:
        json.dump(saved, f, indent=1, sort_keys=True)
print(f"{len(links)} new personal link(s){f' saved to {out}' if links else ''}, {kept} already had one"
      + (f"; the passcode didn't open: {', '.join(skipped)}" if skipped else ""))
if skipped:
    sys.exit(1)
