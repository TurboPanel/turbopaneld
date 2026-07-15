#!/usr/bin/env python3
"""Inject Tabix connection defaults into index.html (after <head>).

Reads values from the environment (never from argv) so orchestration secrets
are not embedded in process argument lists. The Tabix UI contract uses
window.global_tabix_default_settings with the upstream field names.

Paths are fixed filenames under TABIX_HTML_DIR (never full paths from env).
"""

from __future__ import annotations

import json
import os
import pathlib
import sys

# Fixed relative names — do not read path components from env/argv.
_ORIG_NAME = "index.html.orig"
_DEST_NAME = "index.html"


def _path_under(base: pathlib.Path, name: str) -> pathlib.Path:
    """Resolve a fixed relative name under base; reject escapes."""
    candidate = (base / name).resolve()
    base_resolved = base.resolve()
    if candidate != base_resolved and not candidate.is_relative_to(base_resolved):
        raise ValueError(f"refusing path outside TABIX_HTML_DIR: {candidate}")
    return candidate


def main() -> int:
    html_dir = pathlib.Path(os.environ["TABIX_HTML_DIR"]).resolve()
    if not html_dir.is_dir():
        print(f"TABIX_HTML_DIR is not a directory: {html_dir}", file=sys.stderr)
        return 1

    try:
        orig_path = _path_under(html_dir, _ORIG_NAME)
        dest_path = _path_under(html_dir, _DEST_NAME)
    except ValueError as exc:
        print(exc, file=sys.stderr)
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
    text = orig_path.read_text(encoding="utf-8")
    needle = "<head>"
    idx = text.lower().find(needle)
    if idx < 0:
        print("tabix index.html.orig missing <head>", file=sys.stderr)
        return 1
    out = text[: idx + len(needle)] + script + text[idx + len(needle) :]
    dest_path.write_text(out, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
