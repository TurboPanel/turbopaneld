#!/usr/bin/env python3
"""Extract a single member from a zip archive (stdlib only, no apt unzip)."""
from __future__ import annotations

import os
import shutil
import sys
import zipfile


def safe_path(path: str, base_dir: str) -> str:
    resolved = os.path.realpath(path)
    base = os.path.realpath(base_dir)
    if resolved != base and not resolved.startswith(base + os.sep):
        raise ValueError(f"path {path!r} is outside the allowed directory")
    return resolved


def main() -> int:
    if len(sys.argv) != 4:
        print(
            "usage: extract-zip.py <archive.zip> <member-path> <dest-path>",
            file=sys.stderr,
        )
        return 2

    base_dir = os.getcwd()
    try:
        archive = safe_path(sys.argv[1], base_dir)
        dest = safe_path(sys.argv[3], base_dir)
    except ValueError as exc:
        print(exc, file=sys.stderr)
        return 1

    member = sys.argv[2]
    if member.startswith("/") or ".." in member.split("/"):
        print(f"path {member!r} is outside the allowed directory", file=sys.stderr)
        return 1
    with zipfile.ZipFile(archive) as zf:
        with zf.open(member) as src, open(dest, "wb") as dst:
            shutil.copyfileobj(src, dst)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
