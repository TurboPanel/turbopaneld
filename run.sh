#!/bin/sh
# Dev bootstrap entrypoint served at https://<dev-host>/run.sh alongside /install.sh.
# Stages the license, then runs install.sh from the same host (--host).
set -eu

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

LICENSE_ID="$(echo "$LICENSE" | cut -d: -f1)"
LICENSE_TOKEN="$(echo "$LICENSE" | cut -d: -f2-)"

if [ -z "$LICENSE_ID" ] || [ -z "$LICENSE_TOKEN" ]; then
	echo "run.sh: invalid --license format; expected id:token" >&2
	exit 1
fi

STAGING_DIR="/opt/turbopanel/platform/config/daemon-license-staging"
mkdir -p "$STAGING_DIR"

printf '%s' "$LICENSE_ID" > "$STAGING_DIR/license.id"
printf '%s' "$LICENSE_TOKEN" > "$STAGING_DIR/license.token"

if [ -n "$BINARY_URL" ]; then
	export TURBOPANEL_DAEMON_BINARY_URL="$BINARY_URL"
fi

if [ -z "$HOST_URL" ]; then
	echo "run.sh: --host is required" >&2
	exit 1
fi

INSTALLER_URL="${HOST_URL%/}/install.sh"

if [ -n "${TURBOPANEL_TLS_INSECURE:-}" ]; then
	curl -fsSL "$INSTALLER_URL" | sh -s -- --instance-url "$HOST_URL" --insecure-tls
else
	curl -fsSL "$INSTALLER_URL" | sh -s -- --instance-url "$HOST_URL"
fi
