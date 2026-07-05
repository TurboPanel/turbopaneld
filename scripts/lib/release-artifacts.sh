# Shared TurboPanel daemon release artifact naming and verified-install helpers.
# POSIX sh — sourced by update.sh (manual binary-only swap) and
# scripts/package-daemon-release.sh (release packager).
#
# Release layout (mirrors production FHS install):
#   /opt/turbopanel/bin/turbopaneld          native compiled binary (arch-specific)
#   /opt/turbopanel/bin/turbopaneld.js       bundled JS fallback (deno run)
#   /opt/turbopanel/bin/turbopanel-update    managed update helper (scripts/update.sh)
#   /opt/turbopanel/share/orchestration/…    Ansible playbooks + roles
#
# Published artifacts (dist/ after package:release) — installers download the
# host-arch native binary plus the shared JS bundle (never both amd64 and arm64):
#   turbopaneld-amd64.tar.zst  → opt/turbopanel/bin/turbopaneld
#   turbopaneld-arm64.tar.zst  → opt/turbopanel/bin/turbopaneld
#   turbopaneld.js.tar.zst     → opt/turbopanel/bin/turbopaneld.js (+ turbopanel-update)
#                              + opt/turbopanel/share/orchestration/…
#
# Manifest parsing helpers (tp_resolve_channel_manifest, tp_resolve_linux_arch, …)
# are canonical here; scripts/run.sh inlines a copy because CDN bootstrap runs via
# curl | sh without a checkout path to source from.

tp_prod_home() {
	printf '/opt/turbopanel'
}

tp_daemon_binary_name() {
	printf 'turbopaneld'
}

tp_daemon_js_fallback_name() {
	printf 'turbopaneld.js'
}

# Managed update helper installed into the FHS bin dir so nodes can self-refresh
# without a daemon source checkout (see scripts/update.sh).
tp_daemon_update_helper_name() {
	printf 'turbopanel-update'
}

tp_daemon_linux_arch_binary_name() {
	_arch="$1"
	printf 'turbopaneld-linux-%s' "$_arch"
}

tp_daemon_binary_path() {
	_home="${1:-$(tp_prod_home)}"
	printf '%s/bin/%s' "$_home" "$(tp_daemon_binary_name)"
}

tp_daemon_js_fallback_path() {
	_home="${1:-$(tp_prod_home)}"
	printf '%s/bin/%s' "$_home" "$(tp_daemon_js_fallback_name)"
}

tp_daemon_update_helper_path() {
	_home="${1:-$(tp_prod_home)}"
	printf '%s/bin/%s' "$_home" "$(tp_daemon_update_helper_name)"
}

tp_daemon_orchestration_dir() {
	_home="${1:-$(tp_prod_home)}"
	printf '%s/share/orchestration' "$_home"
}

tp_daemon_release_filename() {
	_arch="$1"
	_version="${2:-}"
	if [ -n "$_version" ]; then
		printf 'turbopaneld-%s-%s.tar.zst' "$_version" "$_arch"
	else
		printf 'turbopaneld-%s.tar.zst' "$_arch"
	fi
}

tp_orchestration_release_filename() {
	_version="${1:-}"
	if [ -n "$_version" ]; then
		printf 'orchestration-%s.tar.zst' "$_version"
	else
		printf 'orchestration.tar.zst'
	fi
}

tp_js_release_filename() {
	_version="${1:-}"
	if [ -n "$_version" ]; then
		printf 'turbopaneld.js-%s.tar.zst' "$_version"
	else
		printf 'turbopaneld.js.tar.zst'
	fi
}

# Map uname -m to channel.json binaryArtifacts keys.
tp_resolve_linux_arch() {
	_machine="$(uname -m)"
	case "$_machine" in
		x86_64) printf 'linux-amd64' ;;
		aarch64 | arm64) printf 'linux-arm64' ;;
		*)
			echo "tp_resolve_linux_arch: unsupported CPU architecture: $_machine" >&2
			return 1
			;;
	esac
}

tp_manifest_compact() {
	# shellcheck disable=SC2086
	printf '%s' "$1" | tr -d '[:space:]'
}

tp_manifest_field() {
	_json="$1"
	_field="$2"
	# shellcheck disable=SC2086
	printf '%s' "$_json" | grep -o "\"$_field\":\"[^\"]*\"" | head -1 | sed 's/.*":"//' | tr -d '"'
}

# Extract url or sha256 from a top-level manifest artifact object.
tp_manifest_artifact_field() {
	_json="$1"
	_artifact_key="$2"
	_field="$3"
	# shellcheck disable=SC2086
	_block="$(printf '%s' "$_json" | grep -o "\"$_artifact_key\"[^}]*{[^}]*\"$_field\":\"[^\"]*\"" | head -1)"
	[ -n "$_block" ] || return 1
	printf '%s' "$_block" | grep -o "\"$_field\":\"[^\"]*\"" | sed 's/.*":"//' | tr -d '"'
}

# Extract url or sha256 from binaryArtifacts.<arch>.
tp_manifest_binary_artifact_field() {
	_json="$1"
	_arch="$2"
	_field="$3"
	# shellcheck disable=SC2086
	_block="$(printf '%s' "$_json" | grep -o "\"$_arch\"[^}]*{[^}]*\"$_field\":\"[^\"]*\"" | head -1)"
	[ -n "$_block" ] || return 1
	printf '%s' "$_block" | grep -o "\"$_field\":\"[^\"]*\"" | sed 's/.*":"//' | tr -d '"'
}

# Populate manifest globals: _manifest_host, _manifest_commit, _linux_arch,
# _binary_artifact_{url,sha256}, _js_fallback_artifact_{url,sha256}.
# Returns 1 when required fields are missing.
tp_resolve_channel_manifest() {
	_manifest_json="$1"

	_compact="$(tp_manifest_compact "$_manifest_json")"
	_manifest_host="$(tp_manifest_field "$_compact" "defaultControlPlaneUrl")"
	_manifest_commit="$(tp_manifest_field "$_compact" "commit")"

	_linux_arch="$(tp_resolve_linux_arch)" || return 1

	_binary_artifact_url="$(tp_manifest_binary_artifact_field "$_compact" "$_linux_arch" "url")"
	_binary_artifact_sha256="$(tp_manifest_binary_artifact_field "$_compact" "$_linux_arch" "sha256")"
	_js_fallback_artifact_url="$(tp_manifest_artifact_field "$_compact" "jsFallbackArtifact" "url")"
	_js_fallback_artifact_sha256="$(tp_manifest_artifact_field "$_compact" "jsFallbackArtifact" "sha256")"

	if [ -z "$_manifest_host" ]; then
		_manifest_host="https://turbopanel.app"
	fi

	if [ -z "$_binary_artifact_url" ] || [ -z "$_binary_artifact_sha256" ] \
		|| [ -z "$_js_fallback_artifact_url" ] || [ -z "$_js_fallback_artifact_sha256" ]; then
		return 1
	fi

	return 0
}

# Stage orchestration/ under opt/turbopanel/share/orchestration for standalone upload.
tp_build_orchestration_archive_staging() {
	_staging="$1"
	_home="${2:-$(tp_prod_home)}"
	_orchestration_src="$3"
	_dest="$_staging/$_home/share/orchestration"
	mkdir -p "$_dest"
	cp -a "$_orchestration_src/." "$_dest/"
	tp_prune_release_orchestration_tree "$_dest"
}

# Pack a staging tree whose root already contains opt/turbopanel/share/orchestration.
tp_pack_orchestration_archive() {
	_staging="$1"
	_output="$2"
	_home="${3:-$(tp_prod_home)}"
	if [ ! -f "$_staging/$_home/share/orchestration/ansible.cfg" ]; then
		echo "tp_pack_orchestration_archive: missing $_staging/$_home/share/orchestration/ansible.cfg" >&2
		return 1
	fi
	rm -f "$_output"
	tar -I 'zstd -19 -T0' -cf "$_output" -C "$_staging" "opt"
	return 0
}

tp_extract_orchestration_release() {
	_archive="$1"
	_dest_root="$2"
	_home="${3:-$(tp_prod_home)}"
	if ! command -v zstd >/dev/null 2>&1; then
		echo "tp_extract_orchestration_release: zstd is required" >&2
		return 1
	fi
	mkdir -p "$_dest_root"
	if ! zstd -d -q -c "$_archive" | tar -x -C "$_dest_root"; then
		echo "tp_extract_orchestration_release: failed to extract $_archive" >&2
		return 1
	fi
	if [ ! -f "$_dest_root/$_home/share/orchestration/ansible.cfg" ]; then
		echo "tp_extract_orchestration_release: archive missing $_home/share/orchestration/ansible.cfg" >&2
		return 1
	fi
	return 0
}

# Resolve the production native binary path (legacy name kept for callers).
tp_daemon_dist_binary_path() {
	_home="${1:-$(tp_prod_home)}"
	tp_daemon_binary_path "$_home"
}

tp_build_release_staging_root() {
	_staging="$1"
	_home="${2:-$(tp_prod_home)}"
	mkdir -p "$_staging/$_home/bin" "$_staging/$_home/share/orchestration"
}

tp_stage_release_native_binary() {
	_staging="$1"
	_home="$2"
	_native_src="$3"
	_bin_dir="$_staging/$_home/bin"
	install -m 0755 "$_native_src" "$_bin_dir/$(tp_daemon_binary_name)"
}

tp_stage_release_js_bundle() {
	_staging="$1"
	_home="$2"
	_js_src="$3"
	_update_src="$4"
	_orchestration_src="${5:-}"
	_bin_dir="$_staging/$_home/bin"
	install -m 0644 "$_js_src" "$_bin_dir/$(tp_daemon_js_fallback_name)"
	install -m 0755 "$_update_src" "$_bin_dir/$(tp_daemon_update_helper_name)"
	if [ -n "$_orchestration_src" ]; then
		tp_stage_release_orchestration "$_staging" "$_home" "$_orchestration_src"
	fi
}

# Legacy helper kept for callers that stage both native + JS into one tree.
tp_stage_release_binaries() {
	_staging="$1"
	_home="$2"
	_native_src="$3"
	_js_src="$4"
	tp_stage_release_native_binary "$_staging" "$_home" "$_native_src"
	install -m 0644 "$_js_src" "$_staging/$_home/bin/$(tp_daemon_js_fallback_name)"
}

# Stage the managed update helper (scripts/update.sh) into the release bin dir as
# turbopanel-update so clean-package installs get a checkout-free update entrypoint.
tp_stage_release_update_helper() {
	_staging="$1"
	_home="$2"
	_update_src="$3"
	install -m 0755 "$_update_src" "$_staging/$_home/bin/$(tp_daemon_update_helper_name)"
}

tp_stage_release_orchestration() {
	_staging="$1"
	_home="$2"
	_orchestration_src="$3"
	_dest="$_staging/$_home/share/orchestration"
	cp -a "$_orchestration_src/." "$_dest/"
	tp_prune_release_orchestration_tree "$_dest"
}

# Remove dev-only paths from a staged share/orchestration tree (vendor roles may ship .github).
tp_prune_release_orchestration_tree() {
	_root="$1"
	find "$_root" \( \
		-name .git -o -name node_modules -o -name tests -o -name test \
		-o -name spec -o -name fixtures -o -name coverage -o -name .github \
	\) -print 2>/dev/null | while IFS= read -r _path; do
		[ -n "$_path" ] || continue
		rm -rf "$_path"
	done
}

# _mode: "full" (bin native+js+update+orch), "binary" (native only), "js"
# (turbopaneld.js + update helper + share/orchestration), or "orchestration"
# (share/orchestration only).
tp_verify_release_root() {
	_root="$1"
	_mode="${2:-full}"
	_home="$(tp_prod_home)"
	_prod="$_root/$_home"
	_fail=0

	_leaked="$(find "$_root" \( \
		-name .git -o -name node_modules -o -name tests -o -name test \
		-o -name spec -o -name fixtures -o -name coverage -o -name .github \
	\) -print 2>/dev/null || true)"
	if [ -n "$_leaked" ]; then
		echo "tp_verify_release_root: dev-only paths leaked into release tree:" >&2
		printf '%s\n' "$_leaked" >&2
		_fail=1
	fi

	_ts_files="$(find "$_root" -name '*.ts' -print 2>/dev/null || true)"
	if [ -n "$_ts_files" ]; then
		echo "tp_verify_release_root: unexpected TypeScript sources in release tree:" >&2
		printf '%s\n' "$_ts_files" >&2
		_fail=1
	fi

	_ansible_share="$(find "$_root" -path "*/share/ansible/*" -print 2>/dev/null || true)"
	if [ -n "$_ansible_share" ]; then
		echo "tp_verify_release_root: share/ansible must not ship (use share/orchestration):" >&2
		printf '%s\n' "$_ansible_share" >&2
		_fail=1
	fi

	for _forbidden in \
		"$_prod/src" \
		"$_prod/main.ts" \
		"$_prod/deno.json" \
		"$_prod/deno.lock" \
		"$_prod/scripts"; do
		if [ -e "$_forbidden" ]; then
			echo "tp_verify_release_root: daemon source tree leaked: $_forbidden" >&2
			_fail=1
		fi
	done

	if [ "$_mode" = "orchestration" ]; then
		:
	elif [ "$_mode" = "binary" ]; then
		if [ ! -f "$_prod/bin/$(tp_daemon_binary_name)" ]; then
			echo "tp_verify_release_root: missing $_prod/bin/$(tp_daemon_binary_name)" >&2
			_fail=1
		fi
	elif [ "$_mode" = "js" ]; then
		if [ ! -f "$_prod/bin/$(tp_daemon_js_fallback_name)" ]; then
			echo "tp_verify_release_root: missing $_prod/bin/$(tp_daemon_js_fallback_name)" >&2
			_fail=1
		fi
		if [ ! -f "$_prod/bin/$(tp_daemon_update_helper_name)" ]; then
			echo "tp_verify_release_root: missing $_prod/bin/$(tp_daemon_update_helper_name)" >&2
			_fail=1
		fi
		if [ ! -f "$_prod/share/orchestration/ansible.cfg" ]; then
			echo "tp_verify_release_root: missing $_prod/share/orchestration/ansible.cfg" >&2
			_fail=1
		fi
	elif [ "$_mode" = "full" ]; then
		if [ ! -f "$_prod/bin/$(tp_daemon_binary_name)" ]; then
			echo "tp_verify_release_root: missing $_prod/bin/$(tp_daemon_binary_name)" >&2
			_fail=1
		fi
		if [ ! -f "$_prod/bin/$(tp_daemon_js_fallback_name)" ]; then
			echo "tp_verify_release_root: missing $_prod/bin/$(tp_daemon_js_fallback_name)" >&2
			_fail=1
		fi
		if [ ! -f "$_prod/bin/$(tp_daemon_update_helper_name)" ]; then
			echo "tp_verify_release_root: missing $_prod/bin/$(tp_daemon_update_helper_name)" >&2
			_fail=1
		fi
	fi

	if [ "$_mode" = "full" ] || [ "$_mode" = "orchestration" ]; then
		if [ ! -f "$_prod/share/orchestration/ansible.cfg" ]; then
			echo "tp_verify_release_root: missing $_prod/share/orchestration/ansible.cfg" >&2
			_fail=1
		fi
	fi

	if [ "$_fail" -ne 0 ]; then
		return 1
	fi
	return 0
}

tp_extract_tar_zst_archive() {
	_archive="$1"
	_dest_root="$2"
	if ! command -v zstd >/dev/null 2>&1; then
		echo "tp_extract_tar_zst_archive: zstd is required" >&2
		return 1
	fi
	mkdir -p "$_dest_root"
	if ! zstd -d -q -c "$_archive" | tar -x -C "$_dest_root"; then
		echo "tp_extract_tar_zst_archive: failed to extract $_archive" >&2
		return 1
	fi
	return 0
}

tp_download_verified_artifact() {
	_url="$1"
	_sha256="$2"
	_dest="$3"

	case "$_url" in
		https://*) ;;
		*)
			echo "tp_download_verified_artifact: URL must use HTTPS: $_url" >&2
			return 1
			;;
	esac

	_curl_tls=""
	if [ "${TURBOPANEL_RELEASE_TLS_INSECURE:-}" = 1 ]; then
		_curl_tls="-k"
	fi

	# shellcheck disable=SC2086
	if ! curl -fsSL $_curl_tls "$_url" -o "$_dest"; then
		echo "tp_download_verified_artifact: failed to download $_url" >&2
		return 1
	fi

	if ! printf '%s  %s\n' "$_sha256" "$_dest" | sha256sum -c - >/dev/null 2>&1; then
		echo "tp_download_verified_artifact: SHA-256 mismatch for $_url" >&2
		return 1
	fi
	return 0
}

# Download the host-arch native binary and shared JS bundle from the channel
# manifest and install into the production FHS layout.
tp_install_verified_channel_release() {
	_binary_url="$1"
	_binary_sha256="$2"
	_js_url="$3"
	_js_sha256="$4"
	_home="$(tp_prod_home)"
	_binary_archive=""
	_js_archive=""
	_staging=""

	_cleanup() {
		rm -f "$_binary_archive" "$_js_archive"
		rm -rf "$_staging"
	}
	trap _cleanup EXIT INT HUP TERM

	_binary_archive="$(mktemp)"
	_js_archive="$(mktemp)"
	_staging="$(mktemp -d)"

	if ! tp_download_verified_artifact "$_binary_url" "$_binary_sha256" "$_binary_archive"; then
		return 1
	fi
	if ! tp_download_verified_artifact "$_js_url" "$_js_sha256" "$_js_archive"; then
		return 1
	fi

	_binary_staging="$_staging/binary"
	_js_staging="$_staging/js"
	mkdir -p "$_binary_staging" "$_js_staging"

	if ! tp_extract_tar_zst_archive "$_binary_archive" "$_binary_staging"; then
		return 1
	fi
	if ! tp_verify_release_root "$_binary_staging" "binary"; then
		return 1
	fi

	if ! tp_extract_tar_zst_archive "$_js_archive" "$_js_staging"; then
		return 1
	fi
	if ! tp_verify_release_root "$_js_staging" "js"; then
		return 1
	fi

	mkdir -p "$_home/bin" "$_home/share/orchestration"
	install -m 0755 \
		"$_binary_staging/$_home/bin/$(tp_daemon_binary_name)" \
		"$_home/bin/$(tp_daemon_binary_name)"
	install -m 0644 \
		"$_js_staging/$_home/bin/$(tp_daemon_js_fallback_name)" \
		"$_home/bin/$(tp_daemon_js_fallback_name)"
	install -m 0755 \
		"$_js_staging/$_home/bin/$(tp_daemon_update_helper_name)" \
		"$_home/bin/$(tp_daemon_update_helper_name)"
	rm -rf "$_home/share/orchestration"
	cp -a "$_js_staging/$_home/share/orchestration" "$_home/share/"

	trap - EXIT INT HUP TERM
	_cleanup
	return 0
}
