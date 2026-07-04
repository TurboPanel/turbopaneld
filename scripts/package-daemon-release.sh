#!/bin/sh
# Package cross-arch daemon release tarballs for dev downloads and GitHub releases.
#
# Staging mirrors production FHS layout:
#   opt/turbopanel/bin/{turbopaneld,turbopaneld.js}
#   opt/turbopanel/share/orchestration/…
#
# Only *.tar.zst release artifacts (plus the native turbopaneld binary,
# standalone turbopaneld.js, and orchestration.tar.zst) remain in dist/
# when finished.
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
ORCHESTRATION_STAGING="$DIST/.orchestration-staging"
VERSION="${TURBOPANEL_RELEASE_VERSION:-}"
PROD_HOME="$(tp_prod_home)"
JS_SRC="$DIST/$(tp_daemon_js_fallback_name)"
UPDATE_HELPER_SRC="$ROOT/scripts/update.sh"
mkdir -p "$BUILD"

if [ ! -s "$JS_SRC" ]; then
	echo "package-daemon-release.sh: missing $JS_SRC (run deno task bundle:js)" >&2
	exit 1
fi

if [ ! -s "$UPDATE_HELPER_SRC" ]; then
	echo "package-daemon-release.sh: missing $UPDATE_HELPER_SRC (managed update helper)" >&2
	exit 1
fi

if [ ! -f "$ORCHESTRATION_STAGING/ansible.cfg" ]; then
	echo "package-daemon-release.sh: missing $ORCHESTRATION_STAGING (run deno task bundle:orchestration)" >&2
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

package_arch() {
	_arch="$1"
	_daemon_src="$BUILD/$(tp_daemon_linux_arch_binary_name "$_arch")"
	if [ ! -s "$_daemon_src" ]; then
		echo "package-daemon-release.sh: missing $_daemon_src (run deno task compile:all)" >&2
		exit 1
	fi

	_staging="$(mktemp -d)"
	_out_name="$(tp_daemon_release_filename "$_arch" "$VERSION")"

	tp_build_release_staging_root "$_staging" "$PROD_HOME"
	tp_stage_release_binaries "$_staging" "$PROD_HOME" "$_daemon_src" "$JS_SRC"
	tp_stage_release_update_helper "$_staging" "$PROD_HOME" "$UPDATE_HELPER_SRC"
	tp_stage_release_orchestration "$_staging" "$PROD_HOME" "$ORCHESTRATION_STAGING"

	if ! tp_verify_release_root "$_staging" "full"; then
		echo "package-daemon-release.sh: release verification failed for $_arch" >&2
		exit 1
	fi

	write_tarball "$_out_name" "$_staging" "opt"
}

package_arch amd64
package_arch arm64

rm -rf "$BUILD" "$ORCHESTRATION_STAGING"
for _entry in "$DIST"/*; do
	[ -e "$_entry" ] || continue
	_base="$(basename "$_entry")"
	case "$_base" in
		turbopaneld-linux-*.tar.zst | turbopaneld-*-linux-*.tar.zst | \
		$(tp_daemon_binary_name) | $(tp_daemon_js_fallback_name) | \
		$(tp_orchestration_release_filename "$VERSION")) ;;
		*) rm -rf "$_entry" ;;
	esac
done
