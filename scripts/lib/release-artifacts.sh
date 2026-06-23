# Shared TurboPanel daemon release artifact naming and fetch/extract helpers.
# POSIX sh — source from install.sh, update.sh, and package-daemon-release.sh.
#
# Compiled cross-arch binaries (staging under dist/.build/ during release:package):
#   turbopaneld-linux-amd64
#   turbopaneld-linux-arm64
#   turbopanel-bootstrap-orchestration-linux-amd64
#   turbopanel-bootstrap-orchestration-linux-arm64
#   orchestration.tar.zst
#
# zstd-compressed tar release artifacts (dist/ after package:release):
#   turbopaneld-linux-amd64.tar.zst
#   turbopaneld-linux-arm64.tar.zst
#
# Each daemon tar contains at archive root:
#   turbopaneld
#   turbopanel-bootstrap-orchestration
#   orchestration.tar.zst
#
# Versioned GitHub release assets (set TURBOPANEL_RELEASE_VERSION when packaging
# or TURBOPANEL_DAEMON_RELEASE_VERSION when downloading):
#   turbopaneld-<version>-linux-amd64.tar.zst
#   turbopaneld-<version>-linux-arm64.tar.zst
#
# Future GitHub Actions upload (not wired yet):
#   TURBOPANEL_RELEASE_VERSION=0.1.0 ./scripts/package-daemon-release.sh
#   gh release upload v0.1.0 dist/turbopaneld-0.1.0-linux-*.tar.zst

tp_daemon_binary_name() {
	printf 'turbopaneld'
}

tp_daemon_linux_arch_binary_name() {
	_arch="$1"
	printf 'turbopaneld-linux-%s' "$_arch"
}

tp_daemon_linux_arch() {
	case "$(uname -m)" in
		x86_64 | amd64) echo amd64 ;;
		aarch64 | arm64) echo arm64 ;;
		*)
			echo "tp_daemon_linux_arch: unsupported machine $(uname -m)" >&2
			return 1
		;;
	esac
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

tp_daemon_runtime_binary_path() {
	_runtimes_dir="${1:-/opt/turbopanel/runtimes}"
	_install_root="$(dirname "$_runtimes_dir")"
	tp_daemon_dist_binary_path "$_install_root/platform/daemon"
}

tp_orchestration_bundle_name() {
	printf 'orchestration.tar.zst'
}

tp_bootstrap_binary_name() {
	printf 'turbopanel-bootstrap-orchestration'
}

tp_bootstrap_linux_arch_binary_name() {
	_arch="$1"
	printf 'turbopanel-bootstrap-orchestration-linux-%s' "$_arch"
}

tp_bootstrap_dist_binary_path() {
	_daemon_dir="${1:-/opt/turbopanel/platform/daemon}"
	printf '%s/dist/turbopanel-bootstrap-orchestration' "$_daemon_dir"
}

tp_extract_release_archive() {
	_archive="$1"
	_dest_dir="$2"
	if ! command -v zstd >/dev/null 2>&1; then
		echo "tp_extract_release_archive: zstd is required" >&2
		return 1
	fi
	mkdir -p "$_dest_dir"
	if ! zstd -d -q -c "$_archive" | tar -x -C "$_dest_dir"; then
		echo "tp_extract_release_archive: failed to extract $_archive" >&2
		return 1
	fi
	return 0
}

tp_fetch_named_release() {
	_base_url="$1"
	_dest_dir="$2"
	_filename="$3"

	_tmp="$(mktemp)"
	_curl_tls=""
	if [ "${TURBOPANEL_RELEASE_TLS_INSECURE:-}" = 1 ]; then
		_curl_tls="-k"
	fi

	_url="${_base_url%/}/$_filename"
	if ! curl -fsSL $_curl_tls "$_url" -o "$_tmp"; then
		rm -f "$_tmp"
		echo "tp_fetch_named_release: failed to download $_url" >&2
		return 1
	fi

	if ! tp_extract_release_archive "$_tmp" "$_dest_dir"; then
		rm -f "$_tmp"
		return 1
	fi
	rm -f "$_tmp"
	return 0
}

tp_install_daemon_release() {
	_base_url="$1"
	_daemon_dir="$2"
	_version="${3:-${TURBOPANEL_DAEMON_RELEASE_VERSION:-}}"
	_staging="$(mktemp -d)"
	_dist_dir="$(dirname "$(tp_daemon_dist_binary_path "$_daemon_dir")")"
	_daemon_name="$(tp_daemon_binary_name)"
	_bootstrap_name="$(tp_bootstrap_binary_name)"
	_orchestration_bundle="$(tp_orchestration_bundle_name)"

	if ! tp_fetch_daemon_release "$_base_url" "$_staging" "$_version"; then
		rm -rf "$_staging"
		return 1
	fi

	mkdir -p "$_dist_dir"
	install -m 0755 "$_staging/$_daemon_name" "$(tp_daemon_dist_binary_path "$_daemon_dir")"
	if [ -f "$_staging/$_bootstrap_name" ]; then
		install -m 0755 "$_staging/$_bootstrap_name" "$(tp_bootstrap_dist_binary_path "$_daemon_dir")"
	fi
	if [ -f "$_staging/$_orchestration_bundle" ]; then
		install -m 0644 "$_staging/$_orchestration_bundle" "$_dist_dir/$_orchestration_bundle"
	fi
	rm -rf "$_staging"
	return 0
}

tp_fetch_daemon_release() {
	_base_url="$1"
	_dest_dir="$2"
	_version="${3:-${TURBOPANEL_DAEMON_RELEASE_VERSION:-}}"
	_arch="$(tp_daemon_linux_arch)" || return 1

	_tmp="$(mktemp)"
	_fetched=false

	_curl_tls=""
	if [ "${TURBOPANEL_RELEASE_TLS_INSECURE:-}" = 1 ]; then
		_curl_tls="-k"
	fi

	_try_fetch() {
		_name="$1"
		_url="${_base_url%/}/$_name"
		if curl -fsSL $_curl_tls "$_url" -o "$_tmp"; then
			_fetched=true
			return 0
		fi
		return 1
	}

	if [ -n "$_version" ]; then
		_try_fetch "$(tp_daemon_release_filename "$_arch" "$_version")" || true
	fi
	if [ "$_fetched" = false ]; then
		_try_fetch "$(tp_daemon_release_filename "$_arch")" || true
	fi

	if [ "$_fetched" = false ]; then
		rm -f "$_tmp"
		echo "tp_fetch_daemon_release: no release artifact found under ${_base_url%/}" >&2
		return 1
	fi

	if ! tp_extract_daemon_release "$_tmp" "$_dest_dir"; then
		rm -f "$_tmp"
		return 1
	fi
	rm -f "$_tmp"
	return 0
}
