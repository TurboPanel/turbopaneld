# Shared TurboPanel daemon release artifact naming and verified-install helpers.
# POSIX sh — sourced by update.sh (manual binary-only swap) and
# scripts/package-daemon-release.sh (release packager).
#
# The operator bootstrap (scripts/run.sh) installs the daemon from a source
# artifact and runs it via the Deno runtime, so it no longer sources this library
# and there is no download-by-version install path here.
#
# Compiled cross-arch binaries (staging under dist/.build/ during release:package):
#   turbopaneld-linux-amd64
#   turbopaneld-linux-arm64
#
# zstd-compressed tar release artifacts (dist/ after package:release):
#   turbopaneld-linux-amd64.tar.zst
#   turbopaneld-linux-arm64.tar.zst
#
# Each daemon tar contains a single member: turbopaneld (orchestration is embedded
# in the binary at compile time via deno compile --include orchestration).
#
# Versioned GitHub release assets (set TURBOPANEL_RELEASE_VERSION when packaging):
#   turbopaneld-<version>-linux-amd64.tar.zst
#   turbopaneld-<version>-linux-arm64.tar.zst

tp_daemon_binary_name() {
	printf 'turbopaneld'
}

tp_daemon_linux_arch_binary_name() {
	_arch="$1"
	printf 'turbopaneld-linux-%s' "$_arch"
}

tp_daemon_release_filename() {
	_arch="$1"
	_version="${2:-}"
	if [ -n "$_version" ]; then
		printf 'turbopaneld-%s-linux-%s.tar.zst' "$_version" "$_arch"
	else
		printf 'turbopaneld-linux-%s.tar.zst' "$_arch"
	fi
}

tp_extract_daemon_release() {
	_archive="$1"
	_dest_dir="$2"
	_binary_name="$(tp_daemon_binary_name)"
	if ! command -v zstd >/dev/null 2>&1; then
		echo "tp_extract_daemon_release: zstd is required" >&2
		return 1
	fi
	mkdir -p "$_dest_dir"
	if ! zstd -d -q -c "$_archive" | tar -x -C "$_dest_dir"; then
		echo "tp_extract_daemon_release: failed to extract $_archive" >&2
		return 1
	fi
	if [ ! -f "$_dest_dir/$_binary_name" ]; then
		echo "tp_extract_daemon_release: archive missing $_binary_name member" >&2
		return 1
	fi
	chmod 0755 "$_dest_dir/$_binary_name"
	return 0
}

tp_daemon_dist_binary_path() {
	_daemon_dir="${1:-/opt/turbopanel/platform/daemon}"
	printf '%s/dist/turbopaneld' "$_daemon_dir"
}

tp_install_verified_artifact() {
	_url="$1"
	_sha256="$2"
	_daemon_dir="$3"
	_tmp=""
	_staging=""

	_cleanup() {
		rm -f "$_tmp"
		rm -rf "$_staging"
	}
	trap _cleanup EXIT

	case "$_url" in
		https://*) ;;
		*)
			echo "tp_install_verified_artifact: URL must use HTTPS: $_url" >&2
			return 1
			;;
	esac

	_tmp="$(mktemp)"
	_staging="$(mktemp -d)"

	_curl_tls=""
	if [ "${TURBOPANEL_RELEASE_TLS_INSECURE:-}" = 1 ]; then
		_curl_tls="-k"
	fi

	# shellcheck disable=SC2086
	if ! curl -fsSL $_curl_tls "$_url" -o "$_tmp"; then
		echo "tp_install_verified_artifact: failed to download $_url" >&2
		return 1
	fi

	if ! printf '%s  %s\n' "$_sha256" "$_tmp" | sha256sum -c -; then
		echo "tp_install_verified_artifact: SHA-256 mismatch for $_url" >&2
		return 1
	fi

	if ! tp_extract_daemon_release "$_tmp" "$_staging"; then
		return 1
	fi

	mkdir -p "$(dirname "$(tp_daemon_dist_binary_path "$_daemon_dir")")"
	install -m 0755 "$_staging/$(tp_daemon_binary_name)" "$(tp_daemon_dist_binary_path "$_daemon_dir")"
	return 0
}
