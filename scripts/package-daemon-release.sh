#!/bin/sh
# Package cross-arch daemon release tarballs for dev downloads and GitHub releases.
#
# Release artifacts written to dist/ (compile intermediates removed after packaging):
#   turbopaneld-linux-{amd64,arm64}.tar.zst
#     turbopaneld
#     turbopanel-bootstrap-orchestration
#     orchestration.tar.zst
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
DAEMON_NAME="$(tp_daemon_binary_name)"
BOOTSTRAP_NAME="$(tp_bootstrap_binary_name)"
ORCHESTRATION_BUNDLE="$(tp_orchestration_bundle_name)"
mkdir -p "$DIST"

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

build_orchestration_bundle() {
	if [ -s "$DIST/$ORCHESTRATION_BUNDLE" ]; then
		return 0
	fi
	_staging="$(mktemp -d)"
	cp -a "$ROOT/orchestration" "$_staging/orchestration"
	tar -I 'zstd -19 -T0' -cf "$DIST/$ORCHESTRATION_BUNDLE" -C "$_staging" orchestration
	rm -rf "$_staging"
	echo "package-daemon-release.sh: wrote $DIST/$ORCHESTRATION_BUNDLE"
}

package_arch() {
	_arch="$1"
	_daemon_src="$DIST/$(tp_daemon_linux_arch_binary_name "$_arch")"
	_bootstrap_src="$DIST/$(tp_bootstrap_linux_arch_binary_name "$_arch")"
	if [ ! -s "$_daemon_src" ]; then
		echo "package-daemon-release.sh: missing $_daemon_src (run deno task compile:all)" >&2
		exit 1
	fi
	if [ ! -s "$_bootstrap_src" ]; then
		echo "package-daemon-release.sh: missing $_bootstrap_src (run deno task compile:all)" >&2
		exit 1
	fi

	build_orchestration_bundle

	_staging="$(mktemp -d)"
	_out_name="$(tp_daemon_release_filename "$_arch" "$VERSION")"

	install -m 0755 "$_daemon_src" "$_staging/$DAEMON_NAME"
	install -m 0755 "$_bootstrap_src" "$_staging/$BOOTSTRAP_NAME"
	install -m 0644 "$DIST/$ORCHESTRATION_BUNDLE" "$_staging/$ORCHESTRATION_BUNDLE"
	write_tarball "$_out_name" "$_staging" "$DAEMON_NAME" "$BOOTSTRAP_NAME" "$ORCHESTRATION_BUNDLE"
	rm -f "$_daemon_src" "$_bootstrap_src"
}

package_arch amd64
package_arch arm64
rm -f "$DIST/$ORCHESTRATION_BUNDLE"
