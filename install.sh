#!/bin/sh
# TurboPanel managed-node installer. Co-located dev serves this at /install.sh
# (same host as /run.sh and /downloads/daemon). Production nodes should use the
# turbopanel-cdn publish when available.
# Run as root or as a sudo-group user (self-escalates with sudo when installed).
set -eu

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
	_script="$1"
	if tp_user_in_sudo_group; then
		echo "$_script: run as root (su -); sudo is not installed yet — the daemon installer will install it" >&2
	else
		echo "$_script: must run as root or as a user in the sudo group" >&2
	fi
	exit 1
}

INSTANCE_URL=""
INSTANCE_CA=""
TUNNEL_TOKEN=""
BRANCH="trunk"
REPO_URL="https://github.com/turbopanel/turbopanel-daemon"
INSECURE_TLS=false
NO_START=false
LICENSE=""

while [ $# -gt 0 ]; do
	case "$1" in
		--license)
			if [ $# -lt 2 ]; then
				echo "install.sh: --license requires an argument" >&2
				exit 1
			fi
			LICENSE="$2"
			shift 2
			;;
		--instance-url)
			if [ $# -lt 2 ]; then
				echo "install.sh: --instance-url requires an argument" >&2
				exit 1
			fi
			INSTANCE_URL="$2"
			shift 2
			;;
		--instance-ca)
			if [ $# -lt 2 ]; then
				echo "install.sh: --instance-ca requires an argument" >&2
				exit 1
			fi
			INSTANCE_CA="$2"
			shift 2
			;;
		--tunnel-token)
			if [ $# -lt 2 ]; then
				echo "install.sh: --tunnel-token requires an argument" >&2
				exit 1
			fi
			TUNNEL_TOKEN="$2"
			shift 2
			;;
		--branch)
			if [ $# -lt 2 ]; then
				echo "install.sh: --branch requires an argument" >&2
				exit 1
			fi
			BRANCH="$2"
			shift 2
			;;
		--repo-url)
			if [ $# -lt 2 ]; then
				echo "install.sh: --repo-url requires an argument" >&2
				exit 1
			fi
			REPO_URL="$2"
			shift 2
			;;
		--insecure-tls)
			INSECURE_TLS=true
			shift
			;;
		--no-start)
			NO_START=true
			shift
			;;
		*)
			echo "install.sh: unknown option: $1" >&2
			exit 1
			;;
	esac
done

if [ -z "$INSTANCE_URL" ]; then
	echo "install.sh: --instance-url is required" >&2
	exit 1
fi

INSTALLER_SELF_URL="${TURBOPANEL_INSTALL_SCRIPT_URL:-${INSTANCE_URL%/}/install.sh}"
if ! tp_is_root; then
	if tp_user_in_sudo_group && tp_sudo_installed; then
		set -- --instance-url "$INSTANCE_URL"
		if [ -n "$LICENSE" ]; then
			set -- "$@" --license "$LICENSE"
		fi
		if [ -n "$INSTANCE_CA" ]; then
			set -- "$@" --instance-ca "$INSTANCE_CA"
		fi
		if [ -n "$TUNNEL_TOKEN" ]; then
			set -- "$@" --tunnel-token "$TUNNEL_TOKEN"
		fi
		if [ "$BRANCH" != "trunk" ]; then
			set -- "$@" --branch "$BRANCH"
		fi
		if [ "$REPO_URL" != "https://github.com/turbopanel/turbopanel-daemon" ]; then
			set -- "$@" --repo-url "$REPO_URL"
		fi
		if [ "$INSECURE_TLS" = true ]; then
			set -- "$@" --insecure-tls
		fi
		if [ "$NO_START" = true ]; then
			set -- "$@" --no-start
		fi
		CURL="curl -fsSL"
		if [ "$INSECURE_TLS" = true ]; then
			CURL="$CURL -k"
		fi
		# shellcheck disable=SC2086
		exec $CURL "$INSTALLER_SELF_URL" | sudo sh -s -- "$@"
	fi
	tp_install_privilege_denied install.sh
fi

if [ -n "$LICENSE" ]; then
	LICENSE_ID="$(echo "$LICENSE" | cut -d: -f1)"
	LICENSE_TOKEN="$(echo "$LICENSE" | cut -d: -f2-)"
	if [ -z "$LICENSE_ID" ] || [ -z "$LICENSE_TOKEN" ]; then
		echo "install.sh: invalid --license format; expected id:token" >&2
		exit 1
	fi
	STAGING_DIR="/opt/turbopanel/platform/config/daemon-license-staging"
	mkdir -p "$STAGING_DIR"
	printf '%s' "$LICENSE_ID" > "$STAGING_DIR/license.id"
	printf '%s' "$LICENSE_TOKEN" > "$STAGING_DIR/license.token"
fi

INSTALL_ROOT="/opt/turbopanel"
DAEMON_DIR="$INSTALL_ROOT/platform/daemon"
CONFIG_DIR="$INSTALL_ROOT/platform/config"
RUNTIMES_DIR="$INSTALL_ROOT/runtimes"
CA_PATH="$CONFIG_DIR/instance-ca.pem"
DENO_VERSION="2.8.3"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq sudo git curl ca-certificates xz-utils zstd tar unzip gnupg python3-debian iptables

if [ -z "${TURBOPANEL_DAEMON_BINARY_URL:-}" ]; then
	echo "install.sh: TURBOPANEL_DAEMON_BINARY_URL is required (pass --binary-url via run.sh)" >&2
	exit 1
fi

if [ ! -x /usr/local/bin/deno ]; then
	DENO_TMP="$RUNTIMES_DIR/deno/.install"
	rm -rf "$DENO_TMP"
	mkdir -p "$DENO_TMP"
	curl -fsSL https://deno.land/install.sh | DENO_INSTALL="$DENO_TMP" sh -s "v$DENO_VERSION" -- -y --no-modify-path
	install -m 0755 "$DENO_TMP/bin/deno" /usr/local/bin/deno
	rm -rf "$DENO_TMP"
fi

mkdir -p "$CONFIG_DIR"
if [ -n "$INSTANCE_CA" ]; then
	install -m 0640 "$INSTANCE_CA" "$CA_PATH"
elif [ "$INSECURE_TLS" = false ]; then
	curl -fsSLk "${INSTANCE_URL%/}/api/daemon/v1/instance/ca" > "$CA_PATH"
	chmod 0640 "$CA_PATH"
fi

if [ ! -d "$DAEMON_DIR/.git" ]; then
	mkdir -p "$(dirname "$DAEMON_DIR")"
	git clone --branch "$BRANCH" "$REPO_URL" "$DAEMON_DIR"
fi

cd "$DAEMON_DIR"

# shellcheck source=scripts/lib/release-artifacts.sh
. "$DAEMON_DIR/scripts/lib/release-artifacts.sh"
if [ "$INSECURE_TLS" = true ]; then
	export TURBOPANEL_RELEASE_TLS_INSECURE=1
fi
if ! tp_install_daemon_release "$TURBOPANEL_DAEMON_BINARY_URL" "$RUNTIMES_DIR"; then
	echo "install.sh: failed to download daemon release from $TURBOPANEL_DAEMON_BINARY_URL" >&2
	exit 1
fi

/usr/local/bin/deno run --allow-net --allow-read --allow-write --allow-run --allow-env \
	scripts/bootstrap-orchestration.ts

ANSIBLE_PLAYBOOK="$RUNTIMES_DIR/ansible/current/bin/ansible-playbook"
if [ ! -x "$ANSIBLE_PLAYBOOK" ]; then
	echo "install.sh: ansible-playbook missing after bootstrap" >&2
	exit 1
fi

VARS_FILE="$(mktemp)"
trap 'rm -f "$VARS_FILE"' EXIT
{
	printf 'turbopanel_instance_url: %s\n' "$INSTANCE_URL"
	printf 'turbopanel_branch: %s\n' "$BRANCH"
	printf 'turbopanel_repo_url: %s\n' "$REPO_URL"
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

"$ANSIBLE_PLAYBOOK" \
	-i localhost, \
	-c local \
	-e "@$VARS_FILE" \
	"$DAEMON_DIR/orchestration/playbooks/daemon-install.yml"

echo "install.sh: turbopanel-daemon provisioning complete"
