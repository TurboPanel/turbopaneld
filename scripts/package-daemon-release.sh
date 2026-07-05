#!/bin/sh
# Package split daemon release artifacts for CDN upload and GitHub releases.
#
# Four zstd-compressed tar artifacts:
#   turbopaneld-amd64.tar.zst  → opt/turbopanel/bin/turbopaneld
#   turbopaneld-arm64.tar.zst  → opt/turbopanel/bin/turbopaneld
#   turbopaneld.js.tar.zst     → opt/turbopanel/bin/turbopaneld.js
#   orchestration.tar.zst      → opt/turbopanel/share/orchestration/…
#
# Installers resolve the host CPU and download the matching native binary plus
# the shared JS bundle and orchestration tree — never both arch binaries.
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
PROD_HOME="$(tp_prod_home)"
JS_SRC="$DIST/$(tp_daemon_js_fallback_name)"
ORCH_ARCHIVE="$DIST/$(tp_orchestration_release_filename "$VERSION")"
mkdir -p "$BUILD"

if [ ! -s "$JS_SRC" ]; then
	echo "package-daemon-release.sh: missing $JS_SRC (run deno task bundle:js)" >&2
	exit 1
fi

if [ ! -s "$ORCH_ARCHIVE" ]; then
	echo "package-daemon-release.sh: missing $ORCH_ARCHIVE (run deno task bundle:orchestration)" >&2
	exit 1
fi

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

package_binary_arch() {
	_arch="$1"
	_daemon_src="$BUILD/$(tp_daemon_linux_arch_binary_name "$_arch")"
	if [ ! -s "$_daemon_src" ]; then
		echo "package-daemon-release.sh: missing $_daemon_src (run deno task compile:all)" >&2
		exit 1
	fi

	_staging="$(mktemp -d)"
	_out_name="$(tp_daemon_release_filename "$_arch" "$VERSION")"

	tp_build_release_staging_root "$_staging" "$PROD_HOME"
	tp_stage_release_native_binary "$_staging" "$PROD_HOME" "$_daemon_src"

	if ! tp_verify_release_root "$_staging" "binary"; then
		echo "package-daemon-release.sh: native binary verification failed for $_arch" >&2
		exit 1
	fi

	write_tarball "$_out_name" "$_staging" "opt"
}

package_js_bundle() {
	_staging="$(mktemp -d)"
	_out_name="$(tp_js_release_filename "$VERSION")"

	mkdir -p "$_staging/$PROD_HOME/bin"
	tp_stage_release_js_bundle "$_staging" "$PROD_HOME" "$JS_SRC"

	if ! tp_verify_release_root "$_staging" "js"; then
		echo "package-daemon-release.sh: JS bundle verification failed" >&2
		exit 1
	fi

	write_tarball "$_out_name" "$_staging" "opt"
}

package_binary_arch amd64
package_binary_arch arm64
package_js_bundle

rm -rf "$BUILD"
for _entry in "$DIST"/*; do
	[ -e "$_entry" ] || continue
	_base="$(basename "$_entry")"
	case "$_base" in
		turbopaneld-amd64.tar.zst | turbopaneld-arm64.tar.zst | \
		turbopaneld-*-amd64.tar.zst | turbopaneld-*-arm64.tar.zst | \
		turbopaneld.js*.tar.zst | orchestration.tar.zst | orchestration-*.tar.zst) ;;
		*) rm -rf "$_entry" ;;
	esac
done
