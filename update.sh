#!/bin/sh
set -eu

DAEMON_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNTIMES_DIR="/opt/turbopanel/runtimes"
TMP_BINARY="/tmp/turbopaneld-new"
RUNTIME_BINARY="$DAEMON_DIR/dist/turbopaneld"

# Step 1 — Resolve update URL
if [ -z "${TURBOPANEL_UPDATE_URL:-}" ]; then
	echo "update.sh: TURBOPANEL_UPDATE_URL is not set" >&2
	exit 1
fi

# shellcheck source=scripts/lib/release-artifacts.sh
. "$DAEMON_DIR/scripts/lib/release-artifacts.sh"

# Step 2 — Download release (zstd tar preferred, raw binary fallback)
if tp_install_daemon_release "$TURBOPANEL_UPDATE_URL" "$DAEMON_DIR"; then
	:
elif curl -fsSL "${TURBOPANEL_UPDATE_URL%/}/turbopaneld" -o "$TMP_BINARY"; then
	if [ ! -s "$TMP_BINARY" ]; then
		echo "update.sh: downloaded binary is empty" >&2
		exit 1
	fi
	chmod 0755 "$TMP_BINARY"
	mkdir -p "$(dirname "$RUNTIME_BINARY")"
	if ! mv "$TMP_BINARY" "$RUNTIME_BINARY"; then
		echo "update.sh: failed to install binary at $RUNTIME_BINARY" >&2
		exit 1
	fi
else
	echo "update.sh: failed to download release from $TURBOPANEL_UPDATE_URL" >&2
	exit 1
fi

if ! sudo chown turbopanel:turbopanel "$RUNTIME_BINARY"; then
	echo "update.sh: failed to set ownership on $RUNTIME_BINARY" >&2
	exit 1
fi

# Step 3 — Refresh orchestration directory from release artifact (no git)
if ! tp_fetch_orchestration_release "$TURBOPANEL_UPDATE_URL" "$DAEMON_DIR"; then
	echo "update.sh: failed to refresh orchestration/ from $TURBOPANEL_UPDATE_URL" >&2
	exit 1
fi
