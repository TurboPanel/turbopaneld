#!/bin/sh
# TurboPanel daemon bootstrap — single entrypoint served at https://trbp.nl/run.sh
# (301 redirect) and at /run.sh by Caddy in co-located dev.
#
# Fetches the clean release package from the channel manifest at
# https://dl.trbp.nl/channels.json, installs the production FHS layout
# (bin/turbopaneld, bin/turbopaneld.js, share/orchestration/), probes native
# binary executability, bootstraps orchestration runtimes, and runs
# daemon-install.yml via Ansible (turbopaneld.service with native or JS fallback).
#
# Config: /etc/turbopanel  State: /var/lib/turbopanel  Runtime: /run/turbopanel
#
# Run as root or as a sudo-capable user (self-escalates via sudo when available).
#
# Manifest and release helpers below must stay in sync with scripts/lib/release-artifacts.sh.

tp_prod_home() { printf '/opt/turbopanel'; }
tp_daemon_binary_name() { printf 'turbopaneld'; }
tp_daemon_js_fallback_name() { printf 'turbopaneld.js'; }
tp_daemon_update_helper_name() { printf 'turbopanel-update'; }
tp_daemon_binary_path() {
	_home="${1:-$(tp_prod_home)}"
	printf '%s/bin/%s' "$_home" "$(tp_daemon_binary_name)"
}
# Mirrors tp_daemon_js_fallback_path in scripts/lib/release-artifacts.sh — run.sh
# inlines it because CDN bootstrap runs via curl | sh without a checkout to source.
tp_daemon_js_fallback_path() {
	_home="${1:-$(tp_prod_home)}"
	printf '%s/bin/%s' "$_home" "$(tp_daemon_js_fallback_name)"
}
tp_daemon_update_helper_path() {
	_home="${1:-$(tp_prod_home)}"
	printf '%s/bin/%s' "$_home" "$(tp_daemon_update_helper_name)"
}

tp_resolve_linux_arch() {
	_machine="$(uname -m)"
	case "$_machine" in
		x86_64) printf 'linux-amd64' ;;
		aarch64 | arm64) printf 'linux-arm64' ;;
		*)
			echo "run.sh: unsupported CPU architecture for daemon updates: $_machine" >&2
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

tp_manifest_artifact_field() {
	_json="$1"
	_artifact_key="$2"
	_field="$3"
	# shellcheck disable=SC2086
	_block="$(printf '%s' "$_json" | grep -o "\"$_artifact_key\"[^}]*{[^}]*\"$_field\":\"[^\"]*\"" | head -1)"
	[ -n "$_block" ] || return 1
	printf '%s' "$_block" | grep -o "\"$_field\":\"[^\"]*\"" | sed 's/.*":"//' | tr -d '"'
}

tp_manifest_binary_artifact_field() {
	_json="$1"
	_arch="$2"
	_field="$3"
	# shellcheck disable=SC2086
	_block="$(printf '%s' "$_json" | grep -o "\"$_arch\"[^}]*{[^}]*\"$_field\":\"[^\"]*\"" | head -1)"
	[ -n "$_block" ] || return 1
	printf '%s' "$_block" | grep -o "\"$_field\":\"[^\"]*\"" | sed 's/.*":"//' | tr -d '"'
}

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
	if [ -z "$_manifest_host" ]; then
		_manifest_host="https://turbopanel.app"
	fi
	if [ -z "$_binary_artifact_url" ] || [ -z "$_binary_artifact_sha256" ] \
		|| [ -z "$_js_fallback_artifact_url" ] || [ -z "$_js_fallback_artifact_sha256" ] \
		|| [ -z "$_orchestration_artifact_url" ] || [ -z "$_orchestration_artifact_sha256" ]; then
		return 1
	fi
	return 0
}

tp_install_verified_release() {
	_url="$1"
	_sha256="$2"
	_home="$(tp_prod_home)"
	_binary_name="$(tp_daemon_binary_name)"
	_js_name="$(tp_daemon_js_fallback_name)"
	_update_name="$(tp_daemon_update_helper_name)"
	_tmp=""
	_staging=""

	_cleanup() {
		rm -f "$_tmp"
		rm -rf "$_staging"
	}
	trap _cleanup EXIT INT HUP TERM

	case "$_url" in
		https://*) ;;
		*)
			echo "run.sh: release URL must use HTTPS: $_url" >&2
			return 1
			;;
	esac

	_tmp="$(mktemp)"
	_staging="$(mktemp -d)"
	_curl="curl -fsSL"
	[ "${TURBOPANEL_RELEASE_TLS_INSECURE:-}" = 1 ] && _curl="curl -fsSLk"
	# shellcheck disable=SC2086
	if ! $_curl "$_url" -o "$_tmp"; then
		echo "run.sh: failed to download $_url" >&2
		return 1
	fi
	if ! printf '%s  %s\n' "$_sha256" "$_tmp" | sha256sum -c - >/dev/null 2>&1; then
		echo "run.sh: SHA-256 mismatch for $_url" >&2
		return 1
	fi
	if ! zstd -d -q -c "$_tmp" | tar -x -C "$_staging"; then
		echo "run.sh: failed to extract $_url" >&2
		return 1
	fi
	if [ ! -f "$_staging/$_home/bin/$_binary_name" ] \
		|| [ ! -f "$_staging/$_home/bin/$_js_name" ] \
		|| [ ! -f "$_staging/$_home/share/orchestration/ansible.cfg" ]; then
		echo "run.sh: release archive missing expected production layout" >&2
		return 1
	fi
	mkdir -p "$_home/bin" "$_home/share/orchestration"
	install -m 0755 "$_staging/$_home/bin/$_binary_name" "$_home/bin/$_binary_name"
	install -m 0644 "$_staging/$_home/bin/$_js_name" "$_home/bin/$_js_name"
	# Install the managed update helper so nodes can self-refresh without a
	# daemon source checkout. Best-effort: older tarballs may predate it.
	if [ -f "$_staging/$_home/bin/$_update_name" ]; then
		install -m 0755 "$_staging/$_home/bin/$_update_name" "$_home/bin/$_update_name"
	fi
	rm -rf "$_home/share/orchestration"
	cp -a "$_staging/$_home/share/orchestration" "$_home/share/"
	trap - EXIT INT HUP TERM
	_cleanup
	return 0
}

tp_is_root() { [ "$(id -u)" = "0" ]; }
tp_is_interactive() {
	if [ -t 0 ]; then
		return 0
	fi
	[ -r /dev/tty ] && [ -w /dev/tty ] 2>/dev/null
}
tp_sudo_installed() { command -v sudo >/dev/null 2>&1; }
tp_validate_sudo() {
	if ! tp_sudo_installed; then
		return 2
	fi
	if sudo -n true 2>/dev/null; then
		return 0
	fi
	if tp_is_interactive; then
		if sudo -v 2>/dev/null; then
			return 0
		fi
	fi
	return 1
}
tp_install_privilege_denied() {
	_reason="${1:-}"
	case "$_reason" in
	no_sudo)
		tp_print_error "run as root (su -); sudo is not installed yet — the daemon installer will install it"
		;;
	sudo_failed)
		tp_print_error "sudo validation failed — run as root or enter a valid sudo password"
		;;
	*)
		tp_print_error "must run as root or have sudo privileges"
		;;
	esac
	exit 1
}

tp_print_step() {
	_glyph="$1"; _msg="$2"
	if [ -t 1 ]; then
		printf '\033[36m%s\033[0m %s\n' "$_glyph" "$_msg"
	else
		printf '%s %s\n' "$_glyph" "$_msg"
	fi
}

tp_print_ok() {
	_msg="$1"
	if [ -t 1 ]; then
		printf '\033[32m✓\033[0m %s\n' "$_msg"
	else
		printf '✓ %s\n' "$_msg"
	fi
}

tp_print_error() {
	_msg="$1"
	if [ -t 2 ]; then
		printf '\033[31m✗\033[0m %s\n' "$_msg" >&2
	else
		printf '✗ %s\n' "$_msg" >&2
	fi
}

DAEMON_SERVICE_NAME="turbopaneld.service"
LEGACY_DAEMON_SERVICE_NAME="turbopanel-daemon.service"

# Stop the running daemon before replacing release binaries on manual reconcile.
# Skipped for --no-start (in-process UI update): that path must not stop the
# caller; the daemon chdirs away and restarts itself after run.sh completes.
tp_stop_running_daemon_for_release_swap() {
	if [ "$NO_START" = true ]; then
		return 0
	fi
	if ! command -v systemctl >/dev/null 2>&1; then
		return 0
	fi
	for _unit in "$DAEMON_SERVICE_NAME" "$LEGACY_DAEMON_SERVICE_NAME"; do
		if ! systemctl cat "$_unit" >/dev/null 2>&1; then
			continue
		fi
		if ! systemctl is-active --quiet "$_unit" 2>/dev/null; then
			continue
		fi
		tp_print_step "▸" "Stopping $_unit for release update…"
		if ! systemctl stop "$_unit"; then
			tp_print_error "Failed to stop $_unit"
			exit 1
		fi
		tp_print_ok "Daemon stopped ($_unit)"
	done
}

tp_start_or_restart_daemon() {
	if [ "$NO_START" = true ]; then
		return 0
	fi
	if ! command -v systemctl >/dev/null 2>&1; then
		return 0
	fi
	if ! systemctl cat "$DAEMON_SERVICE_NAME" >/dev/null 2>&1; then
		return 0
	fi
	tp_print_step "▸" "Starting $DAEMON_SERVICE_NAME…"
	if ! systemctl enable --now "$DAEMON_SERVICE_NAME"; then
		tp_print_error "Failed to enable/start $DAEMON_SERVICE_NAME"
		exit 1
	fi
	tp_print_ok "Daemon running"
}

# Probe whether the native release binary can execute a trivial subcommand.
# Records DAEMON_EXEC_MODE=native|js for the systemd unit template.
tp_probe_native_daemon() {
	_bin="$(tp_daemon_binary_path)"
	if [ ! -x "$_bin" ]; then
		return 1
	fi
	if "$_bin" --version >/dev/null 2>&1; then
		return 0
	fi
	return 1
}

# Host-local carry-over for release swaps lives under FHS paths (not the old
# platform/daemon checkout). Keep this list in sync with HOST_LOCAL_ARTIFACTS
# in src/dev-sync-apply.ts — identity/config are under /var/lib and /etc, so
# only checkout leftovers that may still appear under a source tree remain.
# shellcheck disable=SC2034
TP_HOST_LOCAL_ARTIFACTS=".git .github logs cloudflared"

# Migrate pre-FHS managed installs into /etc/turbopanel and /var/lib/turbopanel.
tp_migrate_legacy_layout() {
	_legacy_daemon="$INSTALL_ROOT/platform/daemon"
	_legacy_config="$INSTALL_ROOT/platform/config"
	_legacy_state="$_legacy_daemon/state"
	_legacy_env="$_legacy_daemon/.env"
	_legacy_ca="$_legacy_config/instance-ca.pem"
	_legacy_tunnels="$_legacy_daemon/cloudflared"
	_legacy_license_staging="$_legacy_config/daemon-license-staging"

	mkdir -p "$STATE_DIR" "$CONFIG_DIR"

	for _f in license.id license.token server.id server-key.json server-key-id; do
		if [ -f "$_legacy_state/$_f" ] && [ ! -e "$STATE_DIR/$_f" ]; then
			mv "$_legacy_state/$_f" "$STATE_DIR/$_f"
		fi
		if [ -f "$_legacy_daemon/$_f" ] && [ ! -e "$STATE_DIR/$_f" ]; then
			mv "$_legacy_daemon/$_f" "$STATE_DIR/$_f"
		fi
	done

	if [ -f "$_legacy_env" ] && [ ! -e "$ENV_FILE" ]; then
		mv "$_legacy_env" "$ENV_FILE"
	fi

	if [ -f "$_legacy_ca" ] && [ ! -e "$CA_PATH" ]; then
		mv "$_legacy_ca" "$CA_PATH"
	fi

	if [ -d "$_legacy_tunnels" ] && [ ! -e "$STATE_DIR/cloudflared" ]; then
		mv "$_legacy_tunnels" "$STATE_DIR/cloudflared"
	fi

	if [ -d "$_legacy_license_staging" ] && [ ! -e "$LICENSE_STAGING_DIR" ]; then
		mv "$_legacy_license_staging" "$LICENSE_STAGING_DIR"
	fi
}
# Keep in sync with orchestration/roles/deno-runtime/defaults/main.yml.
TP_DENO_VERSION="2.9.0"

# Install Deno into the runtimes tree (idempotent), mirroring uv/ansible/cloudflared:
#   $RUNTIMES_DIR/deno/$TP_DENO_VERSION/deno  plus `current` and `bin/deno` symlinks.
tp_install_deno_runtime() {
	_deno_versioned_dir="$RUNTIMES_DIR/deno/$TP_DENO_VERSION"
	_deno_bin="$_deno_versioned_dir/deno"
	if [ ! -x "$_deno_bin" ]; then
		_deno_tmp="$RUNTIMES_DIR/deno/.install"
		rm -rf "$_deno_tmp"
		mkdir -p "$_deno_tmp"
		_curl="curl -fsSL"
		[ "${TURBOPANEL_RELEASE_TLS_INSECURE:-}" = 1 ] && _curl="curl -fsSLk"
		# CI=1 (with no -y and non-TTY stdout) makes deno.land/install.sh skip its
		# shell-setup step. Otherwise it appends `. "$DENO_INSTALL/env"` to the
		# invoking user's ~/.bashrc — pointing at our temp dir which we delete below,
		# breaking every subsequent login shell with a missing-file error.
		# shellcheck disable=SC2086
		if ! $_curl https://deno.land/install.sh \
			| CI=1 DENO_INSTALL="$_deno_tmp" sh -s "v${TP_DENO_VERSION}" >/dev/null 2>&1; then
			rm -rf "$_deno_tmp"
			return 1
		fi
		mkdir -p "$_deno_versioned_dir"
		install -m 0755 "$_deno_tmp/bin/deno" "$_deno_bin"
		rm -rf "$_deno_tmp"
	fi
	# Always restore stable symlinks (repair/retry may leave them drifted).
	ln -sfn "$TP_DENO_VERSION" "$RUNTIMES_DIR/deno/current"
	# Stable path for the JS-fallback systemd ExecStart (next phase).
	mkdir -p "$RUNTIMES_DIR/deno/bin"
	ln -sfn "../current/deno" "$RUNTIMES_DIR/deno/bin/deno"
}

tp_fetch_channel_manifest() {
	_channel="${TURBOPANEL_UPDATE_CHANNEL:-trunk}"
	_curl="curl -fsSL"
	[ "${TURBOPANEL_RELEASE_TLS_INSECURE:-}" = 1 ] && _curl="curl -fsSLk"

	_channels_json=""
	if ! _channels_json="$($_curl "https://dl.trbp.nl/channels.json" 2>/dev/null)"; then
		return 1
	fi

	_channels_oneline="$(tp_manifest_compact "$_channels_json")"
	_manifest_url="$(printf '%s' "$_channels_oneline" | grep -o "\"${_channel}\"[^}]*manifestUrl\":\"[^\"]*\"" | sed 's/.*manifestUrl":"//' | tr -d '"')"
	if [ -z "$_manifest_url" ]; then
		return 1
	fi

	_manifest_json=""
	if ! _manifest_json="$($_curl "$_manifest_url" 2>/dev/null)"; then
		return 1
	fi

	if ! tp_resolve_channel_manifest "$_manifest_json"; then
		return 1
	fi

	return 0
}

set -eu

tp_print_header() {
	if [ -t 1 ]; then
		printf '\n'
		printf '  ╭─────────────────────────────────────────╮\n'
		printf '  │  ⚡ TurboPanel  ·  Daemon Installer     │\n'
		printf '  ╰─────────────────────────────────────────╯\n'
		printf '\n'
	else
		printf 'TurboPanel Daemon Installer\n'
	fi
}

LICENSE=""
HOST_URL=""
INSTANCE_CA=""
TUNNEL_TOKEN=""
INSECURE_TLS=false
NO_START=false

while [ $# -gt 0 ]; do
	case "$1" in
		--license)
			[ $# -ge 2 ] || { tp_print_error "--license requires an argument"; exit 1; }
			LICENSE="$2"; shift 2 ;;
		--host)
			[ $# -ge 2 ] || { tp_print_error "--host requires an argument"; exit 1; }
			HOST_URL="$2"; shift 2 ;;
		--instance-ca)
			[ $# -ge 2 ] || { tp_print_error "--instance-ca requires an argument"; exit 1; }
			INSTANCE_CA="$2"; shift 2 ;;
		--tunnel-token)
			[ $# -ge 2 ] || { tp_print_error "--tunnel-token requires an argument"; exit 1; }
			TUNNEL_TOKEN="$2"; shift 2 ;;
		--insecure-tls)
			INSECURE_TLS=true; shift ;;
		--no-start)
			NO_START=true; shift ;;
		--channel)
			[ $# -ge 2 ] || { tp_print_error "--channel requires an argument"; exit 1; }
			export TURBOPANEL_UPDATE_CHANNEL="$2"; shift 2 ;;
		*)
			tp_print_error "unknown option: $1"; exit 1 ;;
	esac
done

if [ -z "$LICENSE" ]; then
	tp_print_error "--license is required"
	exit 1
fi

_padded="$LICENSE"
while [ $(( ${#_padded} % 4 )) -ne 0 ]; do
	_padded="${_padded}="
done
_decoded="$(printf '%s' "$_padded" | tr -- '-_' '+/' | base64 -d 2>/dev/null)" || {
	tp_print_error "invalid --license format; expected base64url-encoded id:token"
	exit 1
}
LICENSE_ID="$(echo "$_decoded" | cut -d: -f1)"
LICENSE_TOKEN="$(echo "$_decoded" | cut -d: -f2-)"
if [ -z "$LICENSE_ID" ] || [ -z "$LICENSE_TOKEN" ]; then
	tp_print_error "invalid --license format; expected base64url-encoded id:token"
	exit 1
fi

if ! tp_is_root; then
	_sudo_rc=0
	tp_validate_sudo || _sudo_rc=$?
	if [ "$_sudo_rc" -eq 2 ]; then
		tp_install_privilege_denied no_sudo
	fi
	if [ "$_sudo_rc" -ne 0 ]; then
		tp_install_privilege_denied sudo_failed
	fi
	if [ -n "$HOST_URL" ]; then
		_REEXEC_SCRIPT_URL="${HOST_URL%/}/run.sh"
	else
		_REEXEC_SCRIPT_URL="https://trbp.nl/run.sh"
	fi
	set -- --license "$LICENSE"
	[ -n "$HOST_URL" ] && set -- "$@" --host "$HOST_URL"
	[ -n "$INSTANCE_CA" ] && set -- "$@" --instance-ca "$INSTANCE_CA"
	[ -n "$TUNNEL_TOKEN" ] && set -- "$@" --tunnel-token "$TUNNEL_TOKEN"
	[ "$INSECURE_TLS" = true ] && set -- "$@" --insecure-tls
	[ "$NO_START" = true ] && set -- "$@" --no-start
	[ -n "${TURBOPANEL_UPDATE_CHANNEL:-}" ] && set -- "$@" --channel "$TURBOPANEL_UPDATE_CHANNEL"
	_curl="curl -fsSL"
	[ "$INSECURE_TLS" = true ] && _curl="curl -fsSLk"
	# Re-run the script under sudo. `exec` cannot be used here: in a pipeline
	# each command runs in its own subshell, so `exec` would only replace the
	# curl subshell, not this shell — leaving the original non-root shell to
	# fall through and fail on the privileged mkdir calls below. Run the
	# pipeline, then exit with its status so the parent shell never continues.
	# shellcheck disable=SC2086
	$_curl "$_REEXEC_SCRIPT_URL" | sudo sh -s -- "$@"
	exit $?
fi

tp_print_header

INSTALL_ROOT="/opt/turbopanel"
BIN_DIR="$INSTALL_ROOT/bin"
ORCHESTRATION_DIR="$INSTALL_ROOT/share/orchestration"
RUNTIMES_DIR="$INSTALL_ROOT/lib/runtime"
CONFIG_DIR="/etc/turbopanel"
STATE_DIR="/var/lib/turbopanel"
RUN_DIR="/run/turbopanel"
ENV_FILE="$CONFIG_DIR/daemon.env"
CA_PATH="$CONFIG_DIR/instance-ca.pem"
LICENSE_STAGING_DIR="$STATE_DIR/daemon-license-staging"

if [ "$INSECURE_TLS" = true ]; then
	export TURBOPANEL_RELEASE_TLS_INSECURE=1
fi

tp_migrate_legacy_layout

mkdir -p "$STATE_DIR" "$CONFIG_DIR" "$BIN_DIR" "$INSTALL_ROOT/share" "$RUN_DIR"
STAGING_DIR="$LICENSE_STAGING_DIR"
mkdir -p "$STAGING_DIR"
printf '%s' "$LICENSE_ID" > "$STAGING_DIR/license.id"
printf '%s' "$LICENSE_TOKEN" > "$STAGING_DIR/license.token"
chmod 0640 "$STAGING_DIR/license.id" "$STAGING_DIR/license.token"

export DEBIAN_FRONTEND=noninteractive
tp_print_step "▸" "Checking system prerequisites…"
if ! apt-get update -qq 2>/dev/null \
	|| ! apt-get install -y -qq sudo curl ca-certificates xz-utils zstd tar unzip gnupg python3-debian 2>/dev/null; then
	tp_print_error "apt prerequisites failed"
	exit 1
fi
tp_print_ok "Prerequisites ready"

tp_print_step "▸" "Fetching release manifest…"
if ! tp_fetch_channel_manifest; then
	tp_print_error "Failed to fetch release manifest"
	exit 1
fi
if [ -z "$HOST_URL" ]; then
	HOST_URL="$_manifest_host"
fi
tp_print_ok "Release manifest resolved (channel ${TURBOPANEL_UPDATE_CHANNEL:-trunk}, arch ${_linux_arch:-unknown})"
tp_print_step "  " "Binary: $_binary_artifact_url"
tp_print_step "  " "JS fallback: $_js_fallback_artifact_url"
tp_print_step "  " "Orchestration: $_orchestration_artifact_url"
tp_print_step "  " "Commit: ${_manifest_commit:-unknown}"
tp_print_step "  " "Control plane: $HOST_URL"

mkdir -p "$CONFIG_DIR"
if [ -n "$INSTANCE_CA" ]; then
	# Compare resolved paths, not raw strings: a symlink or path-variant (e.g. a
	# trailing slash or relative form) pointing at the canonical CA otherwise
	# slips past a string-only check and makes `install` fail with
	# "are the same file". Resolve both sides before deciding to copy.
	_ca_src_resolved="$(readlink -f "$INSTANCE_CA" 2>/dev/null || echo "$INSTANCE_CA")"
	_ca_dst_resolved="$(readlink -f "$CA_PATH" 2>/dev/null || echo "$CA_PATH")"
	if [ "$_ca_src_resolved" != "$_ca_dst_resolved" ]; then
		install -m 0640 "$INSTANCE_CA" "$CA_PATH"
	fi
else
	case "$HOST_URL" in
		http://*)
			tp_print_step "–" "No platform CA (plaintext control plane — TLS not used)"
			;;
		*)
			tp_print_step "▸" "Fetching instance CA…"
			_curl_base="curl -sSL"
			[ "$INSECURE_TLS" = true ] && _curl_base="curl -sSLk"
			if [ "$INSECURE_TLS" != true ] && [ -f "$CA_PATH" ]; then
				_curl_base="curl -sSL --cacert $CA_PATH"
			fi
			_ca_tmp="$(mktemp)"
			_ca_http_code=""
			# shellcheck disable=SC2086
			_ca_http_code=$($_curl_base -o "$_ca_tmp" -w '%{http_code}' "${HOST_URL%/}/api/daemon/v1/instance/ca" || echo "000")
			case "$_ca_http_code" in
				200)
					install -m 0640 "$_ca_tmp" "$CA_PATH"
					tp_print_ok "Instance CA downloaded"
					;;
				404)
					# Workers production and other publicly-trusted control planes have no
					# platform CA — the daemon uses the system trust store instead.
					tp_print_step "–" "No platform CA (public TLS — using system trust store)"
					rm -f "$CA_PATH"
					;;
				*)
					tp_print_step "~" "Could not download instance CA (HTTP ${_ca_http_code}) — keeping existing CA if present"
					;;
			esac
			rm -f "$_ca_tmp"
			;;
	esac
fi

# Production FHS layout — never point TURBOPANEL_DAEMON_ROOT at a source
# checkout or detectInstallMode() may classify this managed install as dev.
export TURBOPANEL_RUNTIMES_DIR="$RUNTIMES_DIR"
export TURBOPANEL_ORCHESTRATION_DIR="$ORCHESTRATION_DIR"
export TURBOPANEL_CONFIG_DIR="$CONFIG_DIR"
export TURBOPANEL_STATE_DIR="$STATE_DIR"
export TURBOPANEL_DAEMON_STATE_DIR="$STATE_DIR"
export TURBOPANEL_RUN_DIR="$RUN_DIR"

tp_print_step "▸" "Downloading daemon release…"
tp_stop_running_daemon_for_release_swap

if ! tp_install_verified_release "$_binary_artifact_url" "$_binary_artifact_sha256"; then
	tp_print_error "Failed to install daemon release from $_binary_artifact_url"
	exit 1
fi

if [ ! -x "$(tp_daemon_binary_path)" ]; then
	tp_print_error "Daemon release missing native binary at $(tp_daemon_binary_path)"
	exit 1
fi
if [ ! -f "$BIN_DIR/$(tp_daemon_js_fallback_name)" ]; then
	tp_print_error "Daemon release missing JS fallback at $BIN_DIR/$(tp_daemon_js_fallback_name)"
	exit 1
fi
if [ ! -f "$ORCHESTRATION_DIR/ansible.cfg" ]; then
	tp_print_error "Daemon release missing orchestration tree at $ORCHESTRATION_DIR"
	exit 1
fi
tp_print_ok "Release installed (SHA-256 ok)"

tp_print_step "▸" "Probing native daemon binary…"
if tp_probe_native_daemon; then
	DAEMON_EXEC_MODE="native"
	tp_print_ok "Native binary is executable — using turbopaneld"
else
	DAEMON_EXEC_MODE="js"
	tp_print_step "~" "Native binary not executable — using JS fallback (deno run turbopaneld.js)"
fi

tp_print_step "▸" "Installing Deno runtime…"
if ! tp_install_deno_runtime; then
	tp_print_error "Failed to install Deno runtime"
	exit 1
fi
DENO_BIN="$RUNTIMES_DIR/deno/bin/deno"
tp_print_ok "Deno ${TP_DENO_VERSION} ready"

tp_print_step "▸" "Bootstrapping orchestration runtimes…"
if [ "$DAEMON_EXEC_MODE" = "native" ]; then
	"$(tp_daemon_binary_path)" bootstrap-orchestration
else
	HOME="$INSTALL_ROOT" "$DENO_BIN" run --allow-all "$(tp_daemon_js_fallback_path)" bootstrap-orchestration
fi
# Warm the JS fallback module cache so first start is fast/offline.
HOME="$INSTALL_ROOT" "$DENO_BIN" cache "$(tp_daemon_js_fallback_path)" >/dev/null 2>&1 || true

if [ ! -f "$ORCHESTRATION_DIR/ansible.cfg" ]; then
	tp_print_error "Bootstrap did not leave orchestration/ansible.cfg in place"
	exit 1
fi
tp_print_ok "Orchestration runtimes ready"

tp_print_step "▸" "Running daemon provisioning…"

ANSIBLE_PLAYBOOK="$RUNTIMES_DIR/ansible/current/bin/ansible-playbook"
if [ ! -x "$ANSIBLE_PLAYBOOK" ]; then
	tp_print_error "ansible-playbook missing after bootstrap"
	exit 1
fi

VARS_FILE="$(mktemp)"
trap 'rm -f "$VARS_FILE"' EXIT
{
	printf 'turbopanel_instance_url: %s\n' "$HOST_URL"
	printf 'turbopanel_start: %s\n' "$([ "$NO_START" = true ] && echo false || echo true)"
	printf 'turbopanel_manage_service_state: %s\n' "$([ "$NO_START" = true ] && echo false || echo true)"
	printf 'turbopanel_restart_daemon: %s\n' "$([ "$NO_START" = true ] && echo false || echo true)"
	printf 'turbopanel_daemon_exec_mode: %s\n' "$DAEMON_EXEC_MODE"
	printf 'turbopanel_runtimes_dir: %s\n' "$RUNTIMES_DIR"
	printf 'turbopanel_orchestration_dir: %s\n' "$ORCHESTRATION_DIR"
	printf 'turbopanel_config_dir: %s\n' "$CONFIG_DIR"
	printf 'turbopanel_daemon_state_dir: %s\n' "$STATE_DIR"
	printf 'turbopanel_daemon_env_file: %s\n' "$ENV_FILE"
	printf 'turbopanel_daemon_bin: %s\n' "$(tp_daemon_binary_path)"
	printf 'turbopanel_daemon_js: %s\n' "$(tp_daemon_js_fallback_path)"
	printf 'turbopanel_daemon_workdir: %s\n' "$INSTALL_ROOT"
	printf 'turbopanel_daemon_deno_bin: %s\n' "$DENO_BIN"
	printf 'turbopanel_service_name: %s\n' "turbopaneld"
	case "$HOST_URL" in
		http://*) ;;
		*)
			if [ -f "$CA_PATH" ]; then
				printf 'turbopanel_instance_ca: %s\n' "$CA_PATH"
			fi
			;;
	esac
	printf 'turbopanel_update_channel: %s\n' "${TURBOPANEL_UPDATE_CHANNEL:-trunk}"
	if [ -n "$TUNNEL_TOKEN" ]; then
		printf 'turbopanel_tunnel_token: %s\n' "$TUNNEL_TOKEN"
	fi
} > "$VARS_FILE"

export ANSIBLE_CONFIG="$ORCHESTRATION_DIR/ansible.cfg"
export ANSIBLE_LOCAL_TEMP="$RUNTIMES_DIR/uv/cache/ansible-tmp"
export ANSIBLE_COLLECTIONS_PATH="$RUNTIMES_DIR/ansible/galaxy-collections"

if [ -t 1 ]; then
	export ANSIBLE_STDOUT_CALLBACK=default
	export ANSIBLE_LOAD_CALLBACK_PLUGINS=true
	export ANSIBLE_DISPLAY_SKIPPED_HOSTS=false
	export ANSIBLE_DISPLAY_OK_HOSTS=true
	export ANSIBLE_SHOW_CUSTOM_STATS=false
fi

if ! "$ANSIBLE_PLAYBOOK" \
	-i localhost, \
	-c local \
	-e "@$VARS_FILE" \
	"$ORCHESTRATION_DIR/playbooks/daemon-install.yml"; then
	tp_print_error "Daemon provisioning failed"
	exit 1
fi

tp_start_or_restart_daemon

tp_print_ok "TurboPanel daemon provisioning complete"
