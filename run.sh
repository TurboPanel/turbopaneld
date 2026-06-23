#!/bin/sh
# TurboPanel daemon bootstrap — single entrypoint served at https://<host>/run.sh.
#
# Downloads release artifacts only (no git clone):
#   turbopaneld-linux-*.tar.zst  → dist/turbopaneld (orchestration embedded in the binary)
#
# The running daemon then provisions everything else (instance, Docker on demand, …)
# via Ansible. Run as root or as a sudo-group user (self-escalates when sudo exists).

tp_is_root() { [ "$(id -u)" = "0" ]; }
tp_user_in_sudo_group() {
	_groups="$(id -nG 2>/dev/null)" || return 1
	for _g in $_groups; do
		case "$_g" in
		sudo | wheel | admin) return 0 ;;
		esac
	done
	return 1
}
tp_sudo_installed() { command -v sudo >/dev/null 2>&1; }
tp_install_privilege_denied() {
	if tp_user_in_sudo_group; then
		echo "run.sh: run as root (su -); sudo is not installed yet — the daemon installer will install it" >&2
	else
		echo "run.sh: must run as root or as a user in the sudo group" >&2
	fi
	exit 1
}

tp_daemon_linux_arch() {
	case "$(uname -m)" in
		x86_64 | amd64) echo amd64 ;;
		aarch64 | arm64) echo arm64 ;;
		*) echo "run.sh: unsupported machine $(uname -m)" >&2; return 1 ;;
	esac
}

tp_daemon_binary_name() {
	printf 'turbopaneld'
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

tp_extract_release_archive() {
	_archive="$1"
	_dest_dir="$2"
	mkdir -p "$_dest_dir"
	if ! zstd -d -q -c "$_archive" | tar -x -C "$_dest_dir"; then
		echo "run.sh: failed to extract $_archive" >&2
		return 1
	fi
	return 0
}

tp_fetch_named_release() {
	_base_url="$1"
	_dest_dir="$2"
	_filename="$3"
	_tmp="$(mktemp)"
	_curl="curl -fsSL"
	[ "${TURBOPANEL_RELEASE_TLS_INSECURE:-}" = 1 ] && _curl="curl -fsSLk"
	_url="${_base_url%/}/$_filename"
	if ! $_curl "$_url" -o "$_tmp"; then
		rm -f "$_tmp"
		echo "run.sh: failed to download $_url" >&2
		return 1
	fi
	if ! tp_extract_release_archive "$_tmp" "$_dest_dir"; then
		rm -f "$_tmp"
		return 1
	fi
	rm -f "$_tmp"
	return 0
}

tp_fetch_versioned_release() {
	_base_url="$1"
	_dest_dir="$2"
	_versioned_name="$3"
	_unversioned_name="$4"
	_version="${TURBOPANEL_DAEMON_RELEASE_VERSION:-}"
	if [ -n "$_version" ]; then
		if tp_fetch_named_release "$_base_url" "$_dest_dir" "$_versioned_name"; then
			return 0
		fi
	fi
	tp_fetch_named_release "$_base_url" "$_dest_dir" "$_unversioned_name"
}

tp_install_daemon_binary() {
	_base_url="$1"
	_daemon_dir="$2"
	_arch="$(tp_daemon_linux_arch)" || return 1
	_staging="$(mktemp -d)"
	_version="${TURBOPANEL_DAEMON_RELEASE_VERSION:-}"
	_dist_dir="$_daemon_dir/dist"
	_daemon_name="$(tp_daemon_binary_name)"

	if ! tp_fetch_versioned_release "$_base_url" "$_staging" \
		"$(tp_daemon_release_filename "$_arch" "$_version")" \
		"$(tp_daemon_release_filename "$_arch")"; then
		rm -rf "$_staging"
		return 1
	fi
	if [ ! -f "$_staging/$_daemon_name" ]; then
		echo "run.sh: release archive missing $_daemon_name member" >&2
		rm -rf "$_staging"
		return 1
	fi
	mkdir -p "$_dist_dir"
	install -m 0755 "$_staging/$_daemon_name" "$_dist_dir/$_daemon_name"
	rm -rf "$_staging"
	return 0
}

# #region agent log
tp_agent_log() {
	_hypothesisId="$1"
	_location="$2"
	_message="$3"
	_data="$4"
	_ts="$(($(date +%s) * 1000))"
	_log="${TURBOPANEL_DEBUG_LOG:-/opt/turbopanel/platform/config/daemon-install-debug-a4fea3.ndjson}"
	_line="{\"sessionId\":\"a4fea3\",\"hypothesisId\":\"$_hypothesisId\",\"location\":\"$_location\",\"message\":\"$_message\",\"data\":$_data,\"timestamp\":$_ts}"
	printf '%s\n' "$_line" >> "$_log" 2>/dev/null || true
}
# #endregion

set -eu

LICENSE=""
HOST_URL=""
BINARY_URL=""
INSTANCE_CA=""
TUNNEL_TOKEN=""
INSECURE_TLS=false
NO_START=false

while [ $# -gt 0 ]; do
	case "$1" in
		--license)
			[ $# -ge 2 ] || { echo "run.sh: --license requires an argument" >&2; exit 1; }
			LICENSE="$2"; shift 2 ;;
		--host)
			[ $# -ge 2 ] || { echo "run.sh: --host requires an argument" >&2; exit 1; }
			HOST_URL="$2"; shift 2 ;;
		--binary-url)
			[ $# -ge 2 ] || { echo "run.sh: --binary-url requires an argument" >&2; exit 1; }
			BINARY_URL="$2"; shift 2 ;;
		--instance-ca)
			[ $# -ge 2 ] || { echo "run.sh: --instance-ca requires an argument" >&2; exit 1; }
			INSTANCE_CA="$2"; shift 2 ;;
		--tunnel-token)
			[ $# -ge 2 ] || { echo "run.sh: --tunnel-token requires an argument" >&2; exit 1; }
			TUNNEL_TOKEN="$2"; shift 2 ;;
		--insecure-tls)
			INSECURE_TLS=true; shift ;;
		--no-start)
			NO_START=true; shift ;;
		*)
			echo "run.sh: unknown option: $1" >&2; exit 1 ;;
	esac
done

if [ -z "$LICENSE" ] || [ -z "$HOST_URL" ]; then
	echo "run.sh: --license and --host are required" >&2
	exit 1
fi
if [ -z "$BINARY_URL" ]; then
	echo "run.sh: --binary-url is required" >&2
	exit 1
fi

LICENSE_ID="$(echo "$LICENSE" | cut -d: -f1)"
LICENSE_TOKEN="$(echo "$LICENSE" | cut -d: -f2-)"
if [ -z "$LICENSE_ID" ] || [ -z "$LICENSE_TOKEN" ]; then
	echo "run.sh: invalid --license format; expected id:token" >&2
	exit 1
fi

if ! tp_is_root; then
	if tp_user_in_sudo_group && tp_sudo_installed; then
		set -- --license "$LICENSE" --host "$HOST_URL" --binary-url "$BINARY_URL"
		[ -n "$INSTANCE_CA" ] && set -- "$@" --instance-ca "$INSTANCE_CA"
		[ -n "$TUNNEL_TOKEN" ] && set -- "$@" --tunnel-token "$TUNNEL_TOKEN"
		[ "$INSECURE_TLS" = true ] && set -- "$@" --insecure-tls
		[ "$NO_START" = true ] && set -- "$@" --no-start
		_curl="curl -fsSL"
		[ "$INSECURE_TLS" = true ] && _curl="curl -fsSLk"
		# shellcheck disable=SC2086
		exec $_curl "${HOST_URL%/}/run.sh" | sudo sh -s -- "$@"
	fi
	tp_install_privilege_denied
fi

INSTALL_ROOT="/opt/turbopanel"
DAEMON_DIR="$INSTALL_ROOT/platform/daemon"
CONFIG_DIR="$INSTALL_ROOT/platform/config"
RUNTIMES_DIR="$INSTALL_ROOT/runtimes"
CA_PATH="$CONFIG_DIR/instance-ca.pem"
DAEMON_BINARY="$DAEMON_DIR/dist/turbopaneld"

if [ "$INSECURE_TLS" = true ]; then
	export TURBOPANEL_RELEASE_TLS_INSECURE=1
fi

STAGING_DIR="$CONFIG_DIR/daemon-license-staging"
mkdir -p "$STAGING_DIR" "$DAEMON_DIR/dist"
printf '%s' "$LICENSE_ID" > "$STAGING_DIR/license.id"
printf '%s' "$LICENSE_TOKEN" > "$STAGING_DIR/license.token"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq sudo curl ca-certificates xz-utils zstd tar unzip gnupg python3-debian

mkdir -p "$CONFIG_DIR"
if [ -n "$INSTANCE_CA" ]; then
	install -m 0640 "$INSTANCE_CA" "$CA_PATH"
else
	_curl_ca="curl -fsSL"
	[ "$INSECURE_TLS" = true ] && _curl_ca="curl -fsSLk"
	# shellcheck disable=SC2086
	if $_curl_ca "${HOST_URL%/}/api/daemon/v1/instance/ca" > "$CA_PATH"; then
		chmod 0640 "$CA_PATH"
	else
		rm -f "$CA_PATH"
		echo "run.sh: warning: could not download instance CA from ${HOST_URL%/}" >&2
	fi
fi

echo "run.sh: downloading released daemon binaries"
# #region agent log
tp_agent_log "C" "run.sh:binary" "fetch_binary" "{\"dest\":\"$DAEMON_DIR/dist\"}"
# #endregion
if ! tp_install_daemon_binary "$BINARY_URL" "$DAEMON_DIR"; then
	echo "run.sh: failed to download daemon release from $BINARY_URL" >&2
	exit 1
fi

export TURBOPANEL_DAEMON_ROOT="$DAEMON_DIR"
# #region agent log
tp_agent_log "A" "run.sh:main" "artifact_install_start" "{\"binaryUrl\":\"$BINARY_URL\",\"daemonDir\":\"$DAEMON_DIR\",\"noGitClone\":true}"
# #endregion
"$DAEMON_BINARY" bootstrap-orchestration

if [ ! -f "$DAEMON_DIR/orchestration/ansible.cfg" ]; then
	echo "run.sh: bootstrap did not materialize orchestration/ansible.cfg" >&2
	exit 1
fi

ANSIBLE_PLAYBOOK="$RUNTIMES_DIR/ansible/current/bin/ansible-playbook"
if [ ! -x "$ANSIBLE_PLAYBOOK" ]; then
	echo "run.sh: ansible-playbook missing after bootstrap" >&2
	exit 1
fi

VARS_FILE="$(mktemp)"
trap 'rm -f "$VARS_FILE"' EXIT
{
	printf 'turbopanel_instance_url: %s\n' "$HOST_URL"
	printf 'turbopanel_start: %s\n' "$([ "$NO_START" = true ] && echo false || echo true)"
	if [ -f "$CA_PATH" ]; then
		printf 'turbopanel_instance_ca: %s\n' "$CA_PATH"
	fi
	if [ "$INSECURE_TLS" = true ]; then
		printf 'turbopanel_tls_insecure: true\n'
	fi
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

"$ANSIBLE_PLAYBOOK" \
	-i localhost, \
	-c local \
	-e "@$VARS_FILE" \
	"$DAEMON_DIR/orchestration/playbooks/daemon-install.yml"

echo "run.sh: turbopanel-daemon provisioning complete"
