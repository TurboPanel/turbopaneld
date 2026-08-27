# Shared TurboPanel daemon release artifact naming and verified-install helpers.
# Bash — sourced by scripts/package-daemon-release.sh (release packager).
#
# Release layout (mirrors production FHS install):
#   /opt/turbopanel/bin/turbopaneld          native compiled binary (arch-specific)
#   /opt/turbopanel/bin/turbopaneld.js       bundled JS fallback (deno run; optional)
#   /opt/turbopanel/share/orchestration/…    Ansible playbooks + roles
#
# Published artifacts (dist/ after package:release) — installers download the
# host-arch native binary and orchestration tree always; the shared JS bundle
# only when the native binary cannot execute:
#   turbopaneld-amd64.tar.zst  → opt/turbopanel/bin/turbopaneld
#   turbopaneld-arm64.tar.zst  → opt/turbopanel/bin/turbopaneld
#   turbopaneld.js.tar.zst     → opt/turbopanel/bin/turbopaneld.js
#   orchestration.tar.zst      → opt/turbopanel/share/orchestration/…
#
# Manifest parsing helpers (tp_resolve_channel_manifest, tp_resolve_linux_arch, …)
# are canonical here; scripts/run.sh inlines a POSIX copy because CDN bootstrap
# runs via curl | sh without a checkout path to source from.

tp_prod_home() {
	printf '/opt/turbopanel'
	return 0
}

tp_daemon_binary_name() {
	printf 'turbopaneld'
	return 0
}

tp_daemon_js_fallback_name() {
	printf 'turbopaneld.js'
	return 0
}

tp_daemon_binary_path() {
	_home="${1:-$(tp_prod_home)}"
	printf '%s/bin/%s' "$_home" "$(tp_daemon_binary_name)"
	return 0
}

tp_daemon_js_fallback_path() {
	_home="${1:-$(tp_prod_home)}"
	printf '%s/bin/%s' "$_home" "$(tp_daemon_js_fallback_name)"
	return 0
}

tp_daemon_linux_arch_binary_name() {
	_arch="$1"
	printf 'turbopaneld-linux-%s' "$_arch"
	return 0
}

tp_daemon_orchestration_dir() {
	_home="${1:-$(tp_prod_home)}"
	printf '%s/share/orchestration' "$_home"
	return 0
}

tp_daemon_release_filename() {
	_arch="$1"
	_version="${2:-}"
	if [[ -n "$_version" ]]; then
		printf 'turbopaneld-%s-%s.tar.zst' "$_version" "$_arch"
	else
		printf 'turbopaneld-%s.tar.zst' "$_arch"
	fi
	return 0
}

tp_orchestration_release_filename() {
	_version="${1:-}"
	if [[ -n "$_version" ]]; then
		printf 'orchestration-%s.tar.zst' "$_version"
	else
		printf 'orchestration.tar.zst'
	fi
	return 0
}

tp_js_release_filename() {
	_version="${1:-}"
	if [[ -n "$_version" ]]; then
		printf 'turbopaneld.js-%s.tar.zst' "$_version"
	else
		printf 'turbopaneld.js.tar.zst'
	fi
	return 0
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
	return 0
}

tp_manifest_compact() {
	_json="$1"
	# shellcheck disable=SC2086
	printf '%s' "$_json" | tr -d '[:space:]'
	return 0
}

tp_manifest_field() {
	_json="$1"
	_field="$2"
	# shellcheck disable=SC2086
	printf '%s' "$_json" | grep -o "\"$_field\":\"[^\"]*\"" | head -1 | sed 's/.*":"//' | tr -d '"'
	return 0
}

# Extract url or sha256 from a top-level manifest artifact object.
tp_manifest_artifact_field() {
	_json="$1"
	_artifact_key="$2"
	_field="$3"
	# shellcheck disable=SC2086
	_block="$(printf '%s' "$_json" | grep -o "\"$_artifact_key\"[^}]*{[^}]*\"$_field\":\"[^\"]*\"" | head -1)"
	[[ -n "$_block" ]] || return 1
	printf '%s' "$_block" | grep -o "\"$_field\":\"[^\"]*\"" | sed 's/.*":"//' | tr -d '"'
	return 0
}

# Extract url or sha256 from binaryArtifacts.<arch>.
tp_manifest_binary_artifact_field() {
	_json="$1"
	_arch="$2"
	_field="$3"
	# shellcheck disable=SC2086
	_block="$(printf '%s' "$_json" | grep -o "\"$_arch\"[^}]*{[^}]*\"$_field\":\"[^\"]*\"" | head -1)"
	[[ -n "$_block" ]] || return 1
	printf '%s' "$_block" | grep -o "\"$_field\":\"[^\"]*\"" | sed 's/.*":"//' | tr -d '"'
	return 0
}

# Populate manifest globals: _manifest_host, _manifest_commit, _linux_arch,
# _binary_artifact_{url,sha256}, _js_fallback_artifact_{url,sha256},
# _orchestration_artifact_{url,sha256}.
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
	_orchestration_artifact_url="$(tp_manifest_artifact_field "$_compact" "orchestrationArtifact" "url")"
	_orchestration_artifact_sha256="$(tp_manifest_artifact_field "$_compact" "orchestrationArtifact" "sha256")"

	if [[ -z "$_manifest_host" ]]; then
		_manifest_host="https://turbopanel.app"
	fi

	if [[ -z "$_binary_artifact_url" ]] || [[ -z "$_binary_artifact_sha256" ]] \
		|| [[ -z "$_js_fallback_artifact_url" ]] || [[ -z "$_js_fallback_artifact_sha256" ]] \
		|| [[ -z "$_orchestration_artifact_url" ]] || [[ -z "$_orchestration_artifact_sha256" ]]; then
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
	return 0
}

# Pack a staging tree whose root already contains opt/turbopanel/share/orchestration.
tp_pack_orchestration_archive() {
	_staging="$1"
	_output="$2"
	_home="${3:-$(tp_prod_home)}"
	if [[ ! -f "$_staging/$_home/share/orchestration/ansible.cfg" ]]; then
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
	if [[ ! -f "$_dest_root/$_home/share/orchestration/ansible.cfg" ]]; then
		echo "tp_extract_orchestration_release: archive missing $_home/share/orchestration/ansible.cfg" >&2
		return 1
	fi
	return 0
}

tp_build_release_staging_root() {
	_staging="$1"
	_home="${2:-$(tp_prod_home)}"
	mkdir -p "$_staging/$_home/bin" "$_staging/$_home/share/orchestration"
	return 0
}

tp_stage_release_native_binary() {
	_staging="$1"
	_home="$2"
	_native_src="$3"
	_bin_dir="$_staging/$_home/bin"
	install -m 0755 "$_native_src" "$_bin_dir/$(tp_daemon_binary_name)"
	return 0
}

tp_stage_release_js_bundle() {
	_staging="$1"
	_home="$2"
	_js_src="$3"
	_bin_dir="$_staging/$_home/bin"
	install -m 0644 "$_js_src" "$_bin_dir/$(tp_daemon_js_fallback_name)"
	return 0
}

tp_stage_release_notices() {
	_staging="$1"
	_home="$2"
	_notices="$3"
	_dest="$_staging/$_home/share"
	mkdir -p "$_dest"
	install -m 0644 "$_notices" "$_dest/THIRD_PARTY_NOTICES.md"
	return 0
}

tp_stage_release_orchestration() {
	_staging="$1"
	_home="$2"
	_orchestration_src="$3"
	_dest="$_staging/$_home/share/orchestration"
	cp -a "$_orchestration_src/." "$_dest/"
	tp_prune_release_orchestration_tree "$_dest"
	return 0
}

# Remove dev-only paths from a staged share/orchestration tree (vendor roles may
# ship .github / molecule / tests). Uses find -exec so prune works under dash
# too — deno tasks must invoke the packagers with bash (see deno.json).
tp_prune_release_orchestration_tree() {
	_root="$1"
	find "$_root" \( \
		-name .git -o -name node_modules -o -name tests -o -name test \
		-o -name spec -o -name fixtures -o -name coverage -o -name .github \
		-o -name molecule \
	\) -prune -exec rm -rf {} + 2>/dev/null || true
	return 0
}

# _mode: "full" (bin native+js+orch), "binary" (native only), "js"
# (turbopaneld.js only), or "orchestration" (share/orchestration only).
tp_verify_release_root() {
	_root="$1"
	_mode="${2:-full}"
	_home="$(tp_prod_home)"
	_prod="$_root/$_home"
	_fail=0

	_leaked="$(find "$_root" \( \
		-name .git -o -name node_modules -o -name tests -o -name test \
		-o -name spec -o -name fixtures -o -name coverage -o -name .github \
		-o -name molecule \
	\) -print 2>/dev/null || true)"
	if [[ -n "$_leaked" ]]; then
		echo "tp_verify_release_root: dev-only paths leaked into release tree:" >&2
		printf '%s\n' "$_leaked" >&2
		_fail=1
	fi

	_ts_files="$(find "$_root" -name '*.ts' -print 2>/dev/null || true)"
	if [[ -n "$_ts_files" ]]; then
		echo "tp_verify_release_root: unexpected TypeScript sources in release tree:" >&2
		printf '%s\n' "$_ts_files" >&2
		_fail=1
	fi

	_ansible_share="$(find "$_root" -path "*/share/ansible/*" -print 2>/dev/null || true)"
	if [[ -n "$_ansible_share" ]]; then
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
		if [[ -e "$_forbidden" ]]; then
			echo "tp_verify_release_root: daemon source tree leaked: $_forbidden" >&2
			_fail=1
		fi
	done

	if [[ "$_mode" = "orchestration" ]]; then
		:
	elif [[ "$_mode" = "binary" ]]; then
		if [[ ! -f "$_prod/bin/$(tp_daemon_binary_name)" ]]; then
			echo "tp_verify_release_root: missing $_prod/bin/$(tp_daemon_binary_name)" >&2
			_fail=1
		fi
	elif [[ "$_mode" = "js" ]]; then
		if [[ ! -f "$_prod/bin/$(tp_daemon_js_fallback_name)" ]]; then
			echo "tp_verify_release_root: missing $_prod/bin/$(tp_daemon_js_fallback_name)" >&2
			_fail=1
		fi
	elif [[ "$_mode" = "full" ]]; then
		if [[ ! -f "$_prod/bin/$(tp_daemon_binary_name)" ]]; then
			echo "tp_verify_release_root: missing $_prod/bin/$(tp_daemon_binary_name)" >&2
			_fail=1
		fi
		if [[ ! -f "$_prod/bin/$(tp_daemon_js_fallback_name)" ]]; then
			echo "tp_verify_release_root: missing $_prod/bin/$(tp_daemon_js_fallback_name)" >&2
			_fail=1
		fi
	fi

	if { [[ "$_mode" = "full" ]] || [[ "$_mode" = "orchestration" ]]; } \
		&& [[ ! -f "$_prod/share/orchestration/ansible.cfg" ]]; then
		echo "tp_verify_release_root: missing $_prod/share/orchestration/ansible.cfg" >&2
		_fail=1
	fi

	if [[ ! -f "$_prod/share/THIRD_PARTY_NOTICES.md" ]]; then
		echo "tp_verify_release_root: missing $_prod/share/THIRD_PARTY_NOTICES.md" >&2
		_fail=1
	fi

	if [[ "$_fail" -ne 0 ]]; then
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

tp_release_download_url() {
	_url="$1"
	printf '%s' "$_url"
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
	if [[ "${TURBOPANEL_RELEASE_TLS_INSECURE:-}" = 1 ]]; then
		_curl_tls="-k"
	fi

	_fetch_url="$(tp_release_download_url "$_url")"
	_attempt=1
	_max_attempts=5

	while [[ "$_attempt" -le "$_max_attempts" ]]; do
		rm -f "$_dest"
		# shellcheck disable=SC2086
		if ! curl -fsSL $_curl_tls "$_fetch_url" -o "$_dest"; then
			echo "tp_download_verified_artifact: failed to download $_fetch_url" >&2
			return 1
		fi
		if printf '%s  %s\n' "$_sha256" "$_dest" | sha256sum -c - >/dev/null 2>&1; then
			return 0
		fi
		if [[ "$_attempt" -lt "$_max_attempts" ]]; then
			echo "tp_download_verified_artifact: SHA-256 mismatch (attempt $_attempt/$_max_attempts), retrying…" >&2
			sleep 3
		fi
		_attempt=$((_attempt + 1))
	done

	_actual_sha256="$(sha256sum "$_dest" | awk '{print $1}')"
	echo "tp_download_verified_artifact: SHA-256 mismatch for $_url (expected $_sha256, got $_actual_sha256)" >&2
	return 1
}

# Download native binary, orchestration tree, and optional JS bundle from the
# channel manifest and install into the production FHS layout. Callers that
# need native-only installs should omit the JS download/install steps.
tp_install_verified_channel_release() {
	_binary_url="$1"
	_binary_sha256="$2"
	_js_url="$3"
	_js_sha256="$4"
	_orchestration_url="$5"
	_orchestration_sha256="$6"
	_layout_home="$(tp_prod_home)"
	# Nested helpers reuse `_home`; keep the install dest on a name they do not clobber.
	_dest_home="${7:-$_layout_home}"
	_binary_archive=""
	_js_archive=""
	_orchestration_archive=""
	_staging=""

	_cleanup() {
		rm -f "$_binary_archive" "$_js_archive" "$_orchestration_archive"
		rm -rf "$_staging"
		return 0
	}
	trap _cleanup EXIT INT HUP TERM

	_binary_archive="$(mktemp)"
	_js_archive="$(mktemp)"
	_orchestration_archive="$(mktemp)"
	_staging="$(mktemp -d)"

	if ! tp_download_verified_artifact "$_binary_url" "$_binary_sha256" "$_binary_archive"; then
		return 1
	fi
	if ! tp_download_verified_artifact "$_js_url" "$_js_sha256" "$_js_archive"; then
		return 1
	fi
	if ! tp_download_verified_artifact "$_orchestration_url" "$_orchestration_sha256" "$_orchestration_archive"; then
		return 1
	fi

	_binary_staging="$_staging/binary"
	_js_staging="$_staging/js"
	_orchestration_staging="$_staging/orchestration"
	mkdir -p "$_binary_staging" "$_js_staging" "$_orchestration_staging"

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

	if ! tp_extract_orchestration_release "$_orchestration_archive" "$_orchestration_staging" "$_layout_home"; then
		return 1
	fi
	if ! tp_verify_release_root "$_orchestration_staging" "orchestration"; then
		return 1
	fi

	mkdir -p "$_dest_home/bin" "$_dest_home/share/orchestration" "$_dest_home/share"
	install -m 0755 \
		"$_binary_staging/$_layout_home/bin/$(tp_daemon_binary_name)" \
		"$_dest_home/bin/$(tp_daemon_binary_name)"
	install -m 0644 \
		"$_js_staging/$_layout_home/bin/$(tp_daemon_js_fallback_name)" \
		"$_dest_home/bin/$(tp_daemon_js_fallback_name)"
	rm -f "$_dest_home/bin/turbopanel-update"
	rm -rf "$_dest_home/share/orchestration"
	cp -a "$_orchestration_staging/$_layout_home/share/orchestration" "$_dest_home/share/"
	if ! tp_install_release_notices_from_staging \
		"$_layout_home" \
		"$_dest_home" \
		"$_orchestration_staging" \
		"$_binary_staging" \
		"$_js_staging"; then
		return 1
	fi

	trap - EXIT INT HUP TERM
	_cleanup
	return 0
}

# Copy a verified THIRD_PARTY_NOTICES.md from a staged artifact into the
# production FHS share directory.
tp_install_release_notices() {
	_src="$1"
	_home="${2:-$(tp_prod_home)}"
	if [[ ! -f "$_src" ]]; then
		echo "tp_install_release_notices: missing $_src" >&2
		return 1
	fi
	mkdir -p "$_home/share"
	install -m 0644 "$_src" "$_home/share/THIRD_PARTY_NOTICES.md"
	return 0
}

tp_install_release_notices_from_staging() {
	_layout_home="$1"
	_dest_home="$2"
	shift 2
	_notices=""
	for _stage in "$@"; do
		if [[ -f "$_stage/$_layout_home/share/THIRD_PARTY_NOTICES.md" ]]; then
			_notices="$_stage/$_layout_home/share/THIRD_PARTY_NOTICES.md"
			break
		fi
	done
	if [[ -z "$_notices" ]]; then
		echo "tp_install_verified_channel_release: missing verified THIRD_PARTY_NOTICES.md" >&2
		return 1
	fi
	tp_install_release_notices "$_notices" "$_dest_home"
	return 0
}
