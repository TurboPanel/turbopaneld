#!/usr/bin/env python3
"""Extract a single member from a zip archive (stdlib only, no apt unzip)."""
from __future__ import annotations

import shutil
import sys
import zipfile


def main() -> int:
    if len(sys.argv) != 4:
        print(
            "usage: extract-zip.py <archive.zip> <member-path> <dest-path>",
            file=sys.stderr,
        )
        return 2

    archive, member, dest = sys.argv[1], sys.argv[2], sys.argv[3]
    with zipfile.ZipFile(archive) as zf:
        with zf.open(member) as src, open(dest, "wb") as dst:
            shutil.copyfileobj(src, dst)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
