#!/bin/sh
# Verify a clean production release staging tree (extracted tarball root or pre-pack staging).
#
# Usage:
#   verify-release-root.sh <extract-root>              # full release (bin + share/orchestration)
#   verify-release-root.sh --orchestration-only <root> # standalone orchestration tarball
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/lib/release-artifacts.sh
. "$ROOT/scripts/lib/release-artifacts.sh"

_mode="full"
case "${1:-}" in
	--orchestration-only)
		_mode="orchestration"
		_root="${2:-}"
		;;
	--binary-only)
		_mode="binary"
		_root="${2:-}"
		;;
	--js-only)
		_mode="js"
		_root="${2:-}"
		;;
	*)
		_root="${1:-}"
		;;
esac

if [ -z "$_root" ] || [ ! -d "$_root" ]; then
	echo "verify-release-root.sh: missing release root directory" >&2
	echo "Usage: verify-release-root.sh [--orchestration-only|--binary-only|--js-only] <extract-root>" >&2
	exit 1
fi

tp_verify_release_root "$_root" "$_mode"
