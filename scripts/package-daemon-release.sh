#!/bin/sh
# Package cross-arch daemon release tarballs for dev downloads and GitHub releases.
#
# Only *.tar.zst release artifacts remain in dist/ when finished.
# Each tar contains a single member: turbopaneld (orchestration is embedded in the binary).
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/lib/release-artifacts.sh
. "$ROOT/scripts/lib/release-artifacts.sh"

if ! command -v zstd >/dev/null 2>&1; then
	echo "package-daemon-release.sh: zstd is required (apt install zstd)" >&2
	exit 1
fi

DIST="$ROOT/dist"
BUILD="$DIST/.build"
VERSION="${TURBOPANEL_RELEASE_VERSION:-}"
DAEMON_NAME="$(tp_daemon_binary_name)"
mkdir -p "$BUILD"

write_tarball() {
	_out_name="$1"
	_staging="$2"
	shift 2
	_out="$DIST/$_out_name"
	rm -f "$_out"
	tar -I 'zstd -19 -T0' -cf "$_out" -C "$_staging" "$@"
	chmod g+w "$_out" 2>/dev/null || true
	rm -rf "$_staging"
	echo "package-daemon-release.sh: wrote $_out"
}

package_arch() {
	_arch="$1"
	_daemon_src="$BUILD/$(tp_daemon_linux_arch_binary_name "$_arch")"
	if [ ! -s "$_daemon_src" ]; then
		echo "package-daemon-release.sh: missing $_daemon_src (run deno task compile:all)" >&2
		exit 1
	fi

	_staging="$(mktemp -d)"
	_out_name="$(tp_daemon_release_filename "$_arch" "$VERSION")"

	install -m 0755 "$_daemon_src" "$_staging/$DAEMON_NAME"
	write_tarball "$_out_name" "$_staging" "$DAEMON_NAME"
}

package_arch amd64
package_arch arm64

rm -rf "$BUILD"
for _entry in "$DIST"/*; do
	[ -e "$_entry" ] || continue
	case "$_entry" in
		turbopaneld-linux-*.tar.zst) ;;
		*) rm -rf "$_entry" ;;
	esac
done
