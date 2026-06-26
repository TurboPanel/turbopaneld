#!/bin/sh
# TurboPanel daemon bootstrap — single entrypoint served at https://trbp.nl/run.sh
# (301 redirect) and at /run.sh by Caddy in co-located dev.
#
# Fetches the release binary URL and defaultControlPlaneUrl from the channel
# manifest at https://dl.trbp.nl/channels.json, then downloads turbopaneld,
# bootstraps orchestration, and runs daemon-install.yml via Ansible.
#
# Run as root or as a sudo-group user (self-escalates when sudo exists).

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

tp_daemon_binary_name() {
	printf 'turbopaneld'
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

tp_daemon_dist_binary_path() {
	_daemon_dir="${1:-/opt/turbopanel/platform/daemon}"
	printf '%s/dist/turbopaneld' "$_daemon_dir"
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
	[ "${TURBOPANEL_RELEASE_TLS_INSECURE:-}" = 1 ] && _curl_tls="-k"

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

tp_fetch_channel_manifest() {
	_channel="${TURBOPANEL_UPDATE_CHANNEL:-trunk}"
	_arch="$(tp_daemon_linux_arch)" || return 1
	_arch_key="linux-${_arch}"
	_curl="curl -fsSL"
	[ "${TURBOPANEL_RELEASE_TLS_INSECURE:-}" = 1 ] && _curl="curl -fsSLk"

	_channels_json=""
	if ! _channels_json="$($_curl "https://dl.trbp.nl/channels.json")"; then
		echo "run.sh: failed to fetch https://dl.trbp.nl/channels.json" >&2
		return 1
	fi

	_channels_oneline="$(printf '%s' "$_channels_json" | tr -d '[:space:]')"
	_manifest_url="$(printf '%s' "$_channels_oneline" | grep -o "\"${_channel}\"[^}]*manifestUrl\":\"[^\"]*\"" | sed 's/.*manifestUrl":"//' | tr -d '"')"
	if [ -z "$_manifest_url" ]; then
		echo "run.sh: channel ${_channel} not found in channels.json" >&2
		return 1
	fi

	_manifest_json=""
	if ! _manifest_json="$($_curl "$_manifest_url")"; then
		echo "run.sh: failed to fetch $_manifest_url" >&2
		return 1
	fi

	_manifest_oneline="$(printf '%s' "$_manifest_json" | tr -d '[:space:]')"
	_manifest_host="$(printf '%s' "$_manifest_oneline" | grep -o '"defaultControlPlaneUrl":"[^"]*"' | sed 's/.*":"//' | tr -d '"')"
	_artifact_url="$(printf '%s' "$_manifest_oneline" | grep -o "\"${_arch_key}\"[^{]*{[^}]*\"url\":\"[^\"]*\"" | grep -o '"url":"[^"]*"' | sed 's/"url":"//' | tr -d '"')"
	_artifact_sha256="$(printf '%s' "$_manifest_oneline" | grep -o "\"${_arch_key}\"[^{]*{[^}]*\"sha256\":\"[^\"]*\"" | grep -o '"sha256":"[^"]*"' | sed 's/"sha256":"//' | tr -d '"')"

	if [ -z "$_manifest_host" ]; then
		_manifest_host="https://turbopanel.app"
	fi
	if [ -z "$_artifact_url" ] || [ -z "$_artifact_sha256" ]; then
		echo "run.sh: artifact url/sha256 missing for ${_arch_key} in channel manifest" >&2
		return 1
	fi

	return 0
}

set -eu

LICENSE=""
HOST_URL=""
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

if [ -z "$LICENSE" ]; then
	echo "run.sh: --license is required" >&2
	exit 1
fi

_padded="$LICENSE"
while [ $(( ${#_padded} % 4 )) -ne 0 ]; do
	_padded="${_padded}="
done
_decoded="$(printf '%s' "$_padded" | tr -- '-_' '+/' | base64 -d 2>/dev/null)" || {
	echo "run.sh: invalid --license format; expected base64url-encoded id:token" >&2
	exit 1
}
LICENSE_ID="$(echo "$_decoded" | cut -d: -f1)"
LICENSE_TOKEN="$(echo "$_decoded" | cut -d: -f2-)"
if [ -z "$LICENSE_ID" ] || [ -z "$LICENSE_TOKEN" ]; then
	echo "run.sh: invalid --license format; expected base64url-encoded id:token" >&2
	exit 1
fi

if ! tp_is_root; then
	if tp_user_in_sudo_group && tp_sudo_installed; then
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
		_curl="curl -fsSL"
		[ "$INSECURE_TLS" = true ] && _curl="curl -fsSLk"
		# shellcheck disable=SC2086
		exec $_curl "$_REEXEC_SCRIPT_URL" | sudo sh -s -- "$@"
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

if ! tp_fetch_channel_manifest; then
	exit 1
fi
if [ -z "$HOST_URL" ]; then
	HOST_URL="$_manifest_host"
fi
ARTIFACT_URL="$_artifact_url"
ARTIFACT_SHA256="$_artifact_sha256"

mkdir -p "$CONFIG_DIR"
if [ -n "$INSTANCE_CA" ]; then
	install -m 0640 "$INSTANCE_CA" "$CA_PATH"
else
	_curl_base="curl -sSL"
	[ "$INSECURE_TLS" = true ] && _curl_base="curl -sSLk"
	_ca_tmp="$(mktemp)"
	_ca_http_code=""
	# shellcheck disable=SC2086
	_ca_http_code=$($_curl_base -o "$_ca_tmp" -w '%{http_code}' "${HOST_URL%/}/api/daemon/v1/instance/ca" || echo "000")
	case "$_ca_http_code" in
		200)
			install -m 0640 "$_ca_tmp" "$CA_PATH"
			;;
		404)
			# Workers production and other publicly-trusted control planes have no
			# platform CA — the daemon uses the system trust store instead.
			echo "run.sh: no platform CA at ${HOST_URL%/} (public TLS — daemon will use system trust store)" >&2
			rm -f "$CA_PATH"
			;;
		*)
			echo "run.sh: warning: could not download instance CA from ${HOST_URL%/} (HTTP ${_ca_http_code})" >&2
			rm -f "$CA_PATH"
			;;
	esac
	rm -f "$_ca_tmp"
fi

echo "run.sh: downloading released daemon binary"
if ! tp_install_verified_artifact "$ARTIFACT_URL" "$ARTIFACT_SHA256" "$DAEMON_DIR"; then
	echo "run.sh: failed to download daemon release from $ARTIFACT_URL" >&2
	exit 1
fi

export TURBOPANEL_DAEMON_ROOT="$DAEMON_DIR"
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
