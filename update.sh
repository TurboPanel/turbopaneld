#!/bin/sh
set -eu

DAEMON_DIR="$(cd "$(dirname "$0")" && pwd)"
DAEMON_BINARY="$DAEMON_DIR/dist/turbopanel-daemon"
TMP_BINARY="/tmp/turbopanel-daemon-new"

# Step 1 — Resolve update URL
if [ -z "${TURBOPANEL_UPDATE_URL:-}" ]; then
	echo "update.sh: TURBOPANEL_UPDATE_URL is not set" >&2
	exit 1
fi

# Step 2 — Download binary
if ! curl -fsSL "$TURBOPANEL_UPDATE_URL/turbopanel-daemon" -o "$TMP_BINARY"; then
	echo "update.sh: failed to download binary from $TURBOPANEL_UPDATE_URL/turbopanel-daemon" >&2
	exit 1
fi

if [ ! -s "$TMP_BINARY" ]; then
	echo "update.sh: downloaded binary is empty" >&2
	exit 1
fi

chmod 0755 "$TMP_BINARY"

# Step 3 — Replace binary
mkdir -p "$DAEMON_DIR/dist"

if ! mv "$TMP_BINARY" "$DAEMON_BINARY"; then
	echo "update.sh: failed to install binary at $DAEMON_BINARY" >&2
	exit 1
fi

if ! sudo chown turbopanel:turbopanel "$DAEMON_BINARY"; then
	echo "update.sh: failed to set ownership on $DAEMON_BINARY" >&2
	exit 1
fi

# Step 4 — Refresh orchestration directory
_whoami="$(id -un)"
if [ "$_whoami" = "turbopanel" ]; then
	_git="git"
else
	_git="sudo -u turbopanel git"
fi

if ! $_git -C "$DAEMON_DIR" fetch origin trunk; then
	echo "update.sh: failed to fetch origin trunk" >&2
	exit 1
fi

if ! $_git -C "$DAEMON_DIR" checkout origin/trunk -- orchestration/; then
	echo "update.sh: failed to refresh orchestration/ from origin/trunk" >&2
	exit 1
fi
