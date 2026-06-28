#!/bin/sh
set -eu

DAEMON_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCK_FILE="${TURBOPANEL_UPDATE_LOCK_FILE:-$DAEMON_DIR/.update.lock}"

if [ -z "${TURBOPANEL_UPDATE_URL:-}" ]; then
	echo "update.sh: TURBOPANEL_UPDATE_URL is not set" >&2
	exit 1
fi

if [ -z "${TURBOPANEL_UPDATE_SHA256:-}" ]; then
	echo "update.sh: TURBOPANEL_UPDATE_SHA256 is not set" >&2
	exit 1
fi

case "${TURBOPANEL_UPDATE_URL}" in
	https://*) ;;
	*)
		echo "update.sh: TURBOPANEL_UPDATE_URL must use HTTPS" >&2
		exit 1
		;;
esac

mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
	echo "update.sh: another update is already in progress" >&2
	exit 1
fi

# shellcheck source=scripts/lib/release-artifacts.sh
. "$DAEMON_DIR/scripts/lib/release-artifacts.sh"

if [ -n "${TURBOPANEL_UPDATE_BUILD_ID:-}" ]; then
	echo "update.sh: installing build ${TURBOPANEL_UPDATE_BUILD_ID} from ${TURBOPANEL_UPDATE_URL}"
fi

if ! tp_install_verified_artifact "$TURBOPANEL_UPDATE_URL" "$TURBOPANEL_UPDATE_SHA256" "$DAEMON_DIR"; then
	exit 1
fi

RUNTIME_BINARY="$(tp_daemon_dist_binary_path "$DAEMON_DIR")"
if ! sudo chown turbopanel:turbopanel "$RUNTIME_BINARY"; then
	echo "update.sh: failed to set ownership on $RUNTIME_BINARY" >&2
	exit 1
fi

echo "update.sh: restart handled by daemon after update-result"
exit 0
