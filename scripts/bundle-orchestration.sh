#!/bin/sh
# Build dist/orchestration.tar.zst for embedding in compiled turbopaneld binaries.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if ! command -v zstd >/dev/null 2>&1; then
	echo "bundle-orchestration.sh: zstd is required (apt install zstd)" >&2
	exit 1
fi

DIST="$ROOT/dist"
mkdir -p "$DIST"
_staging="$(mktemp -d)"
cp -a "$ROOT/orchestration" "$_staging/orchestration"
tar -I 'zstd -19 -T0' -cf "$DIST/orchestration.tar.zst" -C "$_staging" orchestration
rm -rf "$_staging"
echo "bundle-orchestration.sh: wrote $DIST/orchestration.tar.zst"
