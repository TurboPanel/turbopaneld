#!/usr/bin/env python3
"""Extract the Deno release zip into the versioned runtime tree."""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path


def safe_path(path: Path, base_dir: Path) -> Path:
    resolved = path.resolve()
    base = base_dir.resolve()
    if resolved != base and not str(resolved).startswith(str(base) + os.sep):
        raise ValueError(f"path {path!r} is outside the allowed directory")
    return resolved


def main() -> int:
    if len(sys.argv) != 5:
        print(
            "usage: extract-deno-zip.py <archive.zip> <version-dir> <current-link> <bin-link>",
            file=sys.stderr,
        )
        return 2

    base_dir = Path.cwd()
    try:
        archive = safe_path(Path(sys.argv[1]), base_dir)
        version_dir = safe_path(Path(sys.argv[2]), base_dir)
        current_link = safe_path(Path(sys.argv[3]), base_dir)
        bin_link = safe_path(Path(sys.argv[4]), base_dir)
    except ValueError as exc:
        print(exc, file=sys.stderr)
        return 1

    version_dir.parent.mkdir(parents=True, exist_ok=True)
    bin_link.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="deno-zip-") as tmp:
        tmp_path = Path(tmp)
        with zipfile.ZipFile(archive) as zf:
            zf.extractall(tmp_path)
        candidates = list(tmp_path.rglob("deno"))
        if not candidates:
            print("extract-deno-zip: no deno binary in archive", file=sys.stderr)
            return 1
        src = candidates[0]
        if version_dir.exists():
            shutil.rmtree(version_dir)
        version_dir.mkdir(parents=True, exist_ok=True)
        dest = version_dir / "deno"
        shutil.copy2(src, dest)
        os.chmod(dest, 0o755)

    if current_link.is_symlink() or current_link.exists():
        current_link.unlink()
    current_link.symlink_to(version_dir, target_is_directory=True)

    if bin_link.is_symlink() or bin_link.exists():
        bin_link.unlink()
    bin_link.symlink_to("../current/deno")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
