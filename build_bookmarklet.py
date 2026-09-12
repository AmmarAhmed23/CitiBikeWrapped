#!/usr/bin/env python3
"""Generate the two bookmarklet flavors from fetch-rides.js.

    python3 build_bookmarklet.py --url https://YOURNAME.github.io/citibike-wrapped/fetch-rides.js

Writes:
  loader.txt   the 4-line loader (what the original citibikewrapped.com used).
               Update the hosted file and every user gets the fix instantly.
  inline.txt   the whole script encoded into the bookmark URL. Ugly and not
               updatable, but it survives a Content-Security-Policy that blocks
               loading third-party scripts.
"""

import argparse
import re
from pathlib import Path
from urllib.parse import quote

HERE = Path(__file__).resolve().parent
DEFAULT_URL = "https://YOURNAME.github.io/citibike-wrapped/fetch-rides.js"


def strip_comment_lines(src: str) -> str:
    """Drop whole-line comments and leading indentation. Deliberately conservative:
    it never touches text inside a line, so URLs like https:// stay intact."""
    out = []
    in_block = False
    for line in src.splitlines():
        s = line.strip()
        if in_block:
            if "*/" in s:
                in_block = False
            continue
        if s.startswith("/*"):
            if "*/" not in s:
                in_block = True
            continue
        if s.startswith("//"):
            continue
        if not s:
            continue
        out.append(s)
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=DEFAULT_URL, help="Public URL where fetch-rides.js is hosted")
    ap.add_argument("--year", type=int, default=2026)
    args = ap.parse_args()

    src = (HERE / "fetch-rides.js").read_text(encoding="utf-8")

    # ---- loader (the citibikewrapped.com pattern) ----------------------
    loader_js = (
        "(function(){"
        f"window.__CBW_YEAR={args.year};"
        "var s=document.createElement('script');"
        f"s.src='{args.url}?t='+Date.now();"
        "document.body.appendChild(s);"
        "})();"
    )
    loader = "javascript:" + quote(loader_js, safe="!$&'()*+,-./:;=?@_~")
    (HERE / "loader.txt").write_text(loader + "\n", encoding="utf-8")

    # ---- inline (CSP-proof fallback) -----------------------------------
    stripped = strip_comment_lines(src)
    inline_js = f"(function(){{window.__CBW_YEAR={args.year};}})();" + stripped
    inline = "javascript:" + quote(inline_js, safe="")
    (HERE / "inline.txt").write_text(inline + "\n", encoding="utf-8")

    print(f"loader.txt  {len(loader):>7,} chars   -> points at {args.url}")
    print(f"inline.txt  {len(inline):>7,} chars   -> self-contained, no hosting needed")
    print(f"\nsource {len(src):,} chars, stripped to {len(stripped):,}")


if __name__ == "__main__":
    main()
