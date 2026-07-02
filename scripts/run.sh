#!/bin/sh
# TurboPanel daemon bootstrap — single entrypoint served at https://trbp.nl/run.sh
# (301 redirect) and at /run.sh by Caddy in co-located dev.
#
# Fetches the source artifact URL and defaultControlPlaneUrl from the channel
# manifest at https://dl.trbp.nl/channels.json, then downloads the daemon source
# build, installs the Deno runtime, bootstraps orchestration, and runs
# daemon-install.yml via Ansible.
#
# Run as root or as a sudo-capable user (self-escalates via sudo when available).

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

DAEMON_SERVICE_NAME="turbopanel-daemon.service"

# Stop the running daemon before replacing the source tree on manual reconcile.
# Skipped for --no-start (in-process UI update): that path must not stop the
# caller; the daemon chdirs away and restarts itself after run.sh completes.
tp_stop_running_daemon_for_source_swap() {
	if [ "$NO_START" = true ]; then
		return 0
	fi
	if ! command -v systemctl >/dev/null 2>&1; then
		return 0
	fi
	if ! systemctl cat "$DAEMON_SERVICE_NAME" >/dev/null 2>&1; then
		return 0
	fi
	if ! systemctl is-active --quiet "$DAEMON_SERVICE_NAME" 2>/dev/null; then
		return 0
	fi
	tp_print_step "▸" "Stopping $DAEMON_SERVICE_NAME for source update…"
	if ! systemctl stop "$DAEMON_SERVICE_NAME"; then
		tp_print_error "Failed to stop $DAEMON_SERVICE_NAME"
		exit 1
	fi
	tp_print_ok "Daemon stopped"
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

# Deno runtime version installed into the runtimes tree for the source build.
# Keep in sync with orchestration/roles/deno-runtime/defaults/main.yml.
TP_DENO_VERSION="2.9.0"

# Install Deno into the runtimes tree (idempotent), mirroring uv/ansible/cloudflared:
#   $RUNTIMES_DIR/deno/$TP_DENO_VERSION/deno  plus a `current` symlink.
tp_install_deno_runtime() {
	_deno_versioned_dir="$RUNTIMES_DIR/deno/$TP_DENO_VERSION"
	_deno_bin="$_deno_versioned_dir/deno"
	if [ -x "$_deno_bin" ]; then
		return 0
	fi
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
	ln -sfn "$TP_DENO_VERSION" "$RUNTIMES_DIR/deno/current"
}

tp_fetch_channel_manifest() {
	_channel="${TURBOPANEL_UPDATE_CHANNEL:-trunk}"
	_curl="curl -fsSL"
	[ "${TURBOPANEL_RELEASE_TLS_INSECURE:-}" = 1 ] && _curl="curl -fsSLk"

	_channels_json=""
	if ! _channels_json="$($_curl "https://dl.trbp.nl/channels.json" 2>/dev/null)"; then
		return 1
	fi

	_channels_oneline="$(printf '%s' "$_channels_json" | tr -d '[:space:]')"
	_manifest_url="$(printf '%s' "$_channels_oneline" | grep -o "\"${_channel}\"[^}]*manifestUrl\":\"[^\"]*\"" | sed 's/.*manifestUrl":"//' | tr -d '"')"
	if [ -z "$_manifest_url" ]; then
		return 1
	fi

	_manifest_json=""
	if ! _manifest_json="$($_curl "$_manifest_url" 2>/dev/null)"; then
		return 1
	fi

	_manifest_oneline="$(printf '%s' "$_manifest_json" | tr -d '[:space:]')"
	_manifest_host="$(printf '%s' "$_manifest_oneline" | grep -o '"defaultControlPlaneUrl":"[^"]*"' | sed 's/.*":"//' | tr -d '"')"
	_manifest_commit="$(printf '%s' "$_manifest_oneline" | grep -o '"commit":"[^"]*"' | sed 's/"commit":"//' | tr -d '"')"
	_artifact_url="$(printf '%s' "$_manifest_oneline" | grep -o '"sourceArtifact"[^{]*{[^}]*"url":"[^"]*"' | grep -o '"url":"[^"]*"' | sed 's/"url":"//' | tr -d '"')"
	_artifact_sha256="$(printf '%s' "$_manifest_oneline" | grep -o '"sourceArtifact"[^{]*{[^}]*"sha256":"[^"]*"' | grep -o '"sha256":"[^"]*"' | sed 's/"sha256":"//' | tr -d '"')"

	if [ -z "$_manifest_host" ]; then
		_manifest_host="https://turbopanel.app"
	fi
	if [ -z "$_artifact_url" ] || [ -z "$_artifact_sha256" ]; then
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
DAEMON_DIR="$INSTALL_ROOT/platform/daemon"
CONFIG_DIR="$INSTALL_ROOT/platform/config"
RUNTIMES_DIR="$INSTALL_ROOT/runtimes"
CA_PATH="$CONFIG_DIR/instance-ca.pem"

if [ "$INSECURE_TLS" = true ]; then
	export TURBOPANEL_RELEASE_TLS_INSECURE=1
fi

STAGING_DIR="$CONFIG_DIR/daemon-license-staging"
mkdir -p "$STAGING_DIR"
printf '%s' "$LICENSE_ID" > "$STAGING_DIR/license.id"
printf '%s' "$LICENSE_TOKEN" > "$STAGING_DIR/license.token"

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
ARTIFACT_URL="$_artifact_url"
ARTIFACT_SHA256="$_artifact_sha256"
tp_print_ok "Release manifest resolved (channel ${TURBOPANEL_UPDATE_CHANNEL:-trunk})"
tp_print_step "  " "Artifact: $ARTIFACT_URL"
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

export TURBOPANEL_DAEMON_ROOT="$DAEMON_DIR"

tp_print_step "▸" "Downloading daemon source…"
_src_tmp="$(mktemp)"
_src_curl="curl -fsSL"
[ "$INSECURE_TLS" = true ] && _src_curl="curl -fsSLk"
# shellcheck disable=SC2086
if ! $_src_curl "$ARTIFACT_URL" -o "$_src_tmp" 2>/dev/null; then
	rm -f "$_src_tmp"
	tp_print_error "Failed to download daemon source from $ARTIFACT_URL"
	exit 1
fi
if ! printf '%s  %s\n' "$ARTIFACT_SHA256" "$_src_tmp" | sha256sum -c - >/dev/null 2>&1; then
	rm -f "$_src_tmp"
	tp_print_error "SHA-256 mismatch for $ARTIFACT_URL"
	exit 1
fi
# Extract into a clean staging directory, then atomically replace the daemon
# source tree, preserving only explicitly-allowed host-local artifacts. This
# guarantees source files removed upstream do not survive an update.
mkdir -p "$INSTALL_ROOT/platform"
_src_staging="$INSTALL_ROOT/platform/.daemon-source-staging"
rm -rf "$_src_staging"
mkdir -p "$_src_staging"
if ! zstd -d -q -c "$_src_tmp" | tar -x -C "$_src_staging"; then
	rm -f "$_src_tmp"
	rm -rf "$_src_staging"
	tp_print_error "Failed to extract daemon source"
	exit 1
fi
rm -f "$_src_tmp"
if [ ! -f "$_src_staging/main.ts" ]; then
	rm -rf "$_src_staging"
	tp_print_error "Daemon source archive did not contain main.ts"
	exit 1
fi

# Carry over host-local artifacts so daemon identity (state/), config (.env), and
# tunnel state survive the swap. This list MUST stay in sync with
# HOST_LOCAL_ARTIFACTS in src/dev-sync-apply.ts so the run.sh reconcile and
# dev-sync paths cannot diverge.
if [ -d "$DAEMON_DIR" ]; then
	tp_stop_running_daemon_for_source_swap
	for _hostlocal in .env .git .github state logs cloudflared server.id server-key.json server-key-id; do
		if [ -e "$DAEMON_DIR/$_hostlocal" ]; then
			rm -rf "$_src_staging/$_hostlocal"
			mv "$DAEMON_DIR/$_hostlocal" "$_src_staging/$_hostlocal"
		fi
	done
fi

# Atomically swap the staged tree into place.
rm -rf "$DAEMON_DIR.dev-sync-old"
if [ -d "$DAEMON_DIR" ]; then
	mv "$DAEMON_DIR" "$DAEMON_DIR.dev-sync-old"
fi
if ! mv "$_src_staging" "$DAEMON_DIR"; then
	[ -d "$DAEMON_DIR.dev-sync-old" ] && mv "$DAEMON_DIR.dev-sync-old" "$DAEMON_DIR"
	rm -rf "$_src_staging"
	tp_print_error "Failed to install daemon source"
	exit 1
fi
rm -rf "$DAEMON_DIR.dev-sync-old"
if [ ! -f "$DAEMON_DIR/main.ts" ]; then
	tp_print_error "Daemon source archive did not contain main.ts"
	exit 1
fi
tp_print_ok "Source build installed (SHA-256 ok)"

tp_print_step "▸" "Installing Deno runtime…"
if ! tp_install_deno_runtime; then
	tp_print_error "Failed to install Deno runtime"
	exit 1
fi
DENO_BIN="$RUNTIMES_DIR/deno/current/deno"
tp_print_ok "Deno ${TP_DENO_VERSION} ready"

tp_print_step "▸" "Bootstrapping orchestration runtimes…"
"$DENO_BIN" run --allow-net --allow-read --allow-write --allow-run --allow-env \
	"$DAEMON_DIR/scripts/bootstrap-orchestration.ts"
# Warm the module cache under the daemon's HOME so first start is fast/offline.
(cd "$DAEMON_DIR" && HOME="$INSTALL_ROOT" "$DENO_BIN" cache main.ts >/dev/null 2>&1) || true

if [ ! -f "$DAEMON_DIR/orchestration/ansible.cfg" ]; then
	tp_print_error "Bootstrap did not materialize orchestration/ansible.cfg"
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
	printf 'turbopanel_daemon_run_mode: %s\n' "source"
	printf 'turbopanel_daemon_deno_bin: %s\n' "/opt/turbopanel/runtimes/deno/current/deno"
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

export ANSIBLE_CONFIG="$DAEMON_DIR/orchestration/ansible.cfg"
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
	"$DAEMON_DIR/orchestration/playbooks/daemon-install.yml"; then
	tp_print_error "Daemon provisioning failed"
	exit 1
fi

tp_start_or_restart_daemon

tp_print_ok "TurboPanel daemon provisioning complete"
