#!/usr/bin/env python3
"""Re-wrap existing previews in the current tools/preview_gate.html.

Run from the repo root after changing the gate template:
  python3 tools/rewrap_previews.py            # every preview
  python3 tools/rewrap_previews.py mami-king  # just these

Only the page around the encrypted payload changes. The payload (and so the passcode and the
site inside) stays byte-for-byte the same, so no passcode is needed.
"""
import json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GATE = open(os.path.join(ROOT, "tools", "preview_gate.html"), encoding="utf-8").read()
assert GATE.count("__PAYLOAD__") == 1
PAYLOAD = re.compile(r'<script type="application/json" id="payload">(.*?)</script>', re.S)

asked = sys.argv[1:]
slugs = asked or sorted(d for d in os.listdir(ROOT) if os.path.isfile(os.path.join(ROOT, d, "index.html")))
changed = current = 0
for slug in slugs:
    path = os.path.join(ROOT, slug, "index.html")
    page = open(path, encoding="utf-8").read()
    m = PAYLOAD.search(page)
    if not m:
        if asked:
            sys.exit(f"{slug}: not a passcode preview")
        continue  # a normal site page (industries, guides, ...)
    payload = m.group(1)
    assert {"salt", "iv", "ct", "iter"} <= set(json.loads(payload)), slug
    out = GATE.replace("__PAYLOAD__", payload)
    if out == page:
        current += 1
        continue
    open(path, "w", encoding="utf-8").write(out)
    changed += 1
print(f"rewrapped {changed} previews, {current} already current")
