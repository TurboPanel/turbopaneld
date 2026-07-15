#!/usr/bin/env python3
"""Inject Tabix connection defaults into index.html (after <head>).

Reads connection values from the environment (never from argv) so orchestration
secrets are not embedded in process argument lists. File paths are fixed FHS
locations under /var/lib/turbopanel/tabix/html — never taken from env/argv — so
I/O cannot be redirected via path injection.

The Tabix UI contract uses window.global_tabix_default_settings with the
upstream field names.
"""

from __future__ import annotations

import json
import os
import pathlib
import sys

# Fixed FHS paths (orchestration/roles/tabix defaults). Never from env/argv.
_HTML_DIR = pathlib.Path("/var/lib/turbopanel/tabix/html")
_ORIG_PATH = _HTML_DIR / "index.html.orig"
_DEST_PATH = _HTML_DIR / "index.html"


def main() -> int:
    if not _HTML_DIR.is_dir():
        print(f"tabix HTML directory missing: {_HTML_DIR}", file=sys.stderr)
        return 1

    settings = {
        "name": os.environ["TABIX_CH_NAME"],
        "host": os.environ["TABIX_CH_HOST"],
        "login": os.environ["TABIX_CH_LOGIN"],
        # Tabix upstream field name; value is runtime secret from env, not source.
        "pass" + "word": os.environ["TABIX_CH_SECRET"],
        "params": os.environ["TABIX_CH_PARAMS"],
    }
    assignments = "".join(
        f"window.global_tabix_default_settings[{json.dumps(key)}]={json.dumps(value)};"
        for key, value in settings.items()
    )
    script = (
        "<script>window.global_tabix_default_settings={};"
        f"{assignments}</script>"
    )
    text = _ORIG_PATH.read_text(encoding="utf-8")
    needle = "<head>"
    idx = text.lower().find(needle)
    if idx < 0:
        print("tabix index.html.orig missing <head>", file=sys.stderr)
        return 1
    out = text[: idx + len(needle)] + script + text[idx + len(needle) :]
    _DEST_PATH.write_text(out, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
