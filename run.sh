#!/bin/sh
# Dev bootstrap entrypoint served at https://<dev-host>/run.sh alongside /install.sh.
# Stages the license, then runs install.sh from the same host (--host).
# Run as root or as a sudo-group user (self-escalates with sudo when installed).
set -eu

# shellcheck disable=SC2034
TP_INSTALL_PRIVILEGES_INLINE=1
# shellcheck source=scripts/lib/install-privileges.sh
. "$(CDPATH= cd -- "$(dirname "$0")" && pwd)/scripts/lib/install-privileges.sh" 2>/dev/null || {
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
	tp_reexec_piped_under_sudo() {
		_script="$1"
		_url="$2"
		shift 2
		if tp_is_root; then
			return 0
		fi
		if tp_user_in_sudo_group && tp_sudo_installed; then
			exec curl -fsSL "$_url" | sudo sh -s -- "$@"
		fi
		tp_install_privilege_denied "$_script"
	}
}

LICENSE=""
HOST_URL=""
BINARY_URL=""

while [ $# -gt 0 ]; do
	case "$1" in
		--license)
			if [ $# -lt 2 ]; then
				echo "run.sh: --license requires an argument" >&2
				exit 1
			fi
			LICENSE="$2"
			shift 2
			;;
		--host)
			if [ $# -lt 2 ]; then
				echo "run.sh: --host requires an argument" >&2
				exit 1
			fi
			HOST_URL="$2"
			shift 2
			;;
		--binary-url)
			if [ $# -lt 2 ]; then
				echo "run.sh: --binary-url requires an argument" >&2
				exit 1
			fi
			BINARY_URL="$2"
			shift 2
			;;
		*)
			echo "run.sh: unknown option: $1" >&2
			exit 1
			;;
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

RUN_URL="${HOST_URL%/}/run.sh"
if ! tp_is_root; then
	if tp_user_in_sudo_group && tp_sudo_installed; then
		if [ -n "$BINARY_URL" ]; then
			exec curl -fsSL "$RUN_URL" | sudo sh -s -- \
				--license "$LICENSE" --host "$HOST_URL" --binary-url "$BINARY_URL"
		fi
		exec curl -fsSL "$RUN_URL" | sudo sh -s -- \
			--license "$LICENSE" --host "$HOST_URL"
	fi
	tp_install_privilege_denied run.sh
fi

STAGING_DIR="/opt/turbopanel/platform/config/daemon-license-staging"
mkdir -p "$STAGING_DIR"

printf '%s' "$LICENSE_ID" > "$STAGING_DIR/license.id"
printf '%s' "$LICENSE_TOKEN" > "$STAGING_DIR/license.token"

if [ -n "$BINARY_URL" ]; then
	export TURBOPANEL_DAEMON_BINARY_URL="$BINARY_URL"
fi

INSTALLER_URL="${HOST_URL%/}/install.sh"

if [ -n "${TURBOPANEL_TLS_INSECURE:-}" ]; then
	curl -fsSL "$INSTALLER_URL" | sh -s -- --instance-url "$HOST_URL" --insecure-tls
else
	curl -fsSL "$INSTALLER_URL" | sh -s -- --instance-url "$HOST_URL"
fi
