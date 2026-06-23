#!/bin/sh
# Package cross-arch daemon binaries as zstd-compressed tarballs for dev downloads
# and GitHub releases. Requires dist/turbopaneld-linux-{amd64,arm64} from
# deno task compile:all. Installed servers receive turbopaneld at the tar root.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/lib/release-artifacts.sh
. "$ROOT/scripts/lib/release-artifacts.sh"

if ! command -v zstd >/dev/null 2>&1; then
	echo "package-daemon-release.sh: zstd is required (apt install zstd)" >&2
	exit 1
fi

DIST="$ROOT/dist"
VERSION="${TURBOPANEL_RELEASE_VERSION:-}"
BINARY_NAME="$(tp_daemon_binary_name)"
mkdir -p "$DIST"

package_arch() {
	_arch="$1"
	_src_name="$(tp_daemon_linux_arch_binary_name "$_arch")"
	_src="$DIST/$_src_name"
	if [ ! -s "$_src" ]; then
		echo "package-daemon-release.sh: missing $_src (run deno task compile:all)" >&2
		exit 1
	fi

	_staging="$(mktemp -d)"
	_out_name="$(tp_daemon_release_filename "$_arch" "$VERSION")"
	_out="$DIST/$_out_name"

	install -m 0755 "$_src" "$_staging/$BINARY_NAME"
	# Replace prior artifacts even when owned by another group member (644 files
	# in the setgid dist/ dir are not group-writable; unlink via the directory).
	rm -f "$_out"
	tar -I 'zstd -19 -T0' -cf "$_out" -C "$_staging" "$BINARY_NAME"
	chmod g+w "$_out" 2>/dev/null || true
	rm -rf "$_staging"
	echo "package-daemon-release.sh: wrote $_out"
}

package_arch amd64
package_arch arm64
