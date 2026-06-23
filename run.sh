#!/bin/sh
# TurboPanel daemon bootstrap — the single entrypoint served at
# https://<host>/run.sh (co-located dev: alongside /downloads/daemon).
#
# It does ONLY enough to get the daemon running: install prereqs + Deno, clone
# the daemon checkout, drop in the released binary, bootstrap the orchestration
# runtime, and run daemon-install.yml. Everything else (instance, Caddy, UI,
# Docker on demand, …) is provisioned afterwards by the daemon itself via
# Ansible. There is no second install script.
#
# Run as root or as a sudo-group user (self-escalates with sudo when installed).
# Privilege helpers are inlined — curl | sh has no stable path to source from
# (see scripts/lib/install-privileges.sh; keep in sync).

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

set -eu

LICENSE=""
HOST_URL=""
BINARY_URL=""
INSTANCE_CA=""
TUNNEL_TOKEN=""
BRANCH="trunk"
REPO_URL="https://github.com/turbopanel/turbopanel-daemon"
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
		--branch)
			[ $# -ge 2 ] || { echo "run.sh: --branch requires an argument" >&2; exit 1; }
			BRANCH="$2"; shift 2 ;;
		--repo-url)
			[ $# -ge 2 ] || { echo "run.sh: --repo-url requires an argument" >&2; exit 1; }
			REPO_URL="$2"; shift 2 ;;
		--insecure-tls)
			INSECURE_TLS=true; shift ;;
		--no-start)
			NO_START=true; shift ;;
		*)
			echo "run.sh: unknown option: $1" >&2; exit 1 ;;
	esac
done

if [ -z "$LICENSE" ]; then
	echo "run.sh: --license is required (id:token)" >&2
	exit 1
fi
if [ -z "$HOST_URL" ]; then
	echo "run.sh: --host is required" >&2
	exit 1
fi

LICENSE_ID="$(echo "$LICENSE" | cut -d: -f1)"
LICENSE_TOKEN="$(echo "$LICENSE" | cut -d: -f2-)"
if [ -z "$LICENSE_ID" ] || [ -z "$LICENSE_TOKEN" ]; then
	echo "run.sh: invalid --license format; expected id:token" >&2
	exit 1
fi

# Re-exec under sudo when invoked by a sudo-capable non-root user, forwarding
# every flag we received.
if ! tp_is_root; then
	if tp_user_in_sudo_group && tp_sudo_installed; then
		set -- --license "$LICENSE" --host "$HOST_URL"
		[ -n "$BINARY_URL" ] && set -- "$@" --binary-url "$BINARY_URL"
		[ -n "$INSTANCE_CA" ] && set -- "$@" --instance-ca "$INSTANCE_CA"
		[ -n "$TUNNEL_TOKEN" ] && set -- "$@" --tunnel-token "$TUNNEL_TOKEN"
		[ "$BRANCH" != "trunk" ] && set -- "$@" --branch "$BRANCH"
		[ "$REPO_URL" != "https://github.com/turbopanel/turbopanel-daemon" ] && set -- "$@" --repo-url "$REPO_URL"
		[ "$INSECURE_TLS" = true ] && set -- "$@" --insecure-tls
		[ "$NO_START" = true ] && set -- "$@" --no-start
		CURL="curl -fsSL"
		[ "$INSECURE_TLS" = true ] && CURL="$CURL -k"
		# shellcheck disable=SC2086
		exec $CURL "${HOST_URL%/}/run.sh" | sudo sh -s -- "$@"
	fi
	tp_install_privilege_denied
fi

INSTALL_ROOT="/opt/turbopanel"
DAEMON_DIR="$INSTALL_ROOT/platform/daemon"
CONFIG_DIR="$INSTALL_ROOT/platform/config"
RUNTIMES_DIR="$INSTALL_ROOT/runtimes"
CA_PATH="$CONFIG_DIR/instance-ca.pem"
DENO_VERSION="2.8.3"

# Stage the license for the daemon-config Ansible role to pick up.
STAGING_DIR="$CONFIG_DIR/daemon-license-staging"
mkdir -p "$STAGING_DIR"
printf '%s' "$LICENSE_ID" > "$STAGING_DIR/license.id"
printf '%s' "$LICENSE_TOKEN" > "$STAGING_DIR/license.token"

if [ -n "$BINARY_URL" ]; then
	export TURBOPANEL_DAEMON_BINARY_URL="$BINARY_URL"
fi
if [ -z "${TURBOPANEL_DAEMON_BINARY_URL:-}" ]; then
	echo "run.sh: --binary-url is required (released daemon binary location)" >&2
	exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq sudo git curl ca-certificates xz-utils zstd tar unzip gnupg python3-debian

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
	curl -fsSLk "${HOST_URL%/}/api/daemon/v1/instance/ca" > "$CA_PATH"
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
	echo "run.sh: failed to download daemon release from $TURBOPANEL_DAEMON_BINARY_URL" >&2
	exit 1
fi

/usr/local/bin/deno run --allow-net --allow-read --allow-write --allow-run --allow-env \
	scripts/bootstrap-orchestration.ts

ANSIBLE_PLAYBOOK="$RUNTIMES_DIR/ansible/current/bin/ansible-playbook"
if [ ! -x "$ANSIBLE_PLAYBOOK" ]; then
	echo "run.sh: ansible-playbook missing after bootstrap" >&2
	exit 1
fi

VARS_FILE="$(mktemp)"
trap 'rm -f "$VARS_FILE"' EXIT
{
	printf 'turbopanel_instance_url: %s\n' "$HOST_URL"
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

# When a human is watching (stdout is a TTY), show Ansible's readable play
# recap instead of the machine JSONL configured in ansible.cfg (the daemon's
# own converge path keeps JSONL for structured streaming). Trim fact dumps and
# skipped-task noise so the install is easy to follow.
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
