#!/bin/sh
# Package cross-arch daemon binaries and install support tarballs for dev downloads
# and GitHub releases.
#
# Artifacts written to dist/:
#   turbopaneld-linux-{amd64,arm64}.tar.zst     — released daemon binary only
#   turbopanel-orchestration.tar.zst            — orchestration/ tree for Ansible
#   turbopanel-bootstrap-linux-{amd64,arm64}.tar.zst — compiled orchestration bootstrap
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
	_src_name="$(tp_daemon_linux_arch_binary_name "$_arch")"
	_src="$DIST/$_src_name"
	if [ ! -s "$_src" ]; then
		echo "package-daemon-release.sh: missing $_src (run deno task compile:all)" >&2
		exit 1
	fi

	_staging="$(mktemp -d)"
	_out_name="$(tp_daemon_release_filename "$_arch" "$VERSION")"

	install -m 0755 "$_src" "$_staging/$BINARY_NAME"
	write_tarball "$_out_name" "$_staging" "$BINARY_NAME"
}

package_orchestration() {
	_staging="$(mktemp -d)"
	cp -a "$ROOT/orchestration" "$_staging/orchestration"
	_out_name="$(tp_orchestration_release_filename "$VERSION")"
	write_tarball "$_out_name" "$_staging" orchestration
}

package_bootstrap_arch() {
	_arch="$1"
	_src_name="$(tp_bootstrap_linux_arch_binary_name "$_arch")"
	_src="$DIST/$_src_name"
	_member_name="$(tp_bootstrap_binary_name)"
	if [ ! -s "$_src" ]; then
		echo "package-daemon-release.sh: missing $_src (run deno task compile:all)" >&2
		exit 1
	fi

	_staging="$(mktemp -d)"
	_out_name="$(tp_bootstrap_release_filename "$_arch" "$VERSION")"

	install -m 0755 "$_src" "$_staging/$_member_name"
	write_tarball "$_out_name" "$_staging" "$_member_name"
}

package_arch amd64
package_arch arm64
package_orchestration
package_bootstrap_arch amd64
package_bootstrap_arch arm64
