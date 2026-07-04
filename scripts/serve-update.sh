#!/bin/sh
set -eu

# Co-located / checkout helper: serves checkout-local dist/turbopaneld only.
# Managed hosts consume the release package via run.sh, not this path.
DAEMON_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/lib/runtime-paths.sh
. "$DAEMON_DIR/scripts/lib/runtime-paths.sh"
DAEMON_BINARY="$DAEMON_DIR/dist/turbopaneld"
CADDY_BIN="$TURBOPANEL_RUNTIMES_DIR/caddy/current/caddy"

if [ ! -s "$DAEMON_BINARY" ]; then
	echo "serve-update.sh: $DAEMON_BINARY not found or empty" >&2
	echo "run the daemon-build role (or deno task compile) to produce dist/turbopaneld first" >&2
	exit 1
fi

if [ ! -x "$CADDY_BIN" ]; then
	echo "serve-update.sh: Caddy not found at $CADDY_BIN" >&2
	exit 1
fi

TMPDIR="$(mktemp -d)"
CADDY_PID=""

shutdown() {
	if [ -n "$CADDY_PID" ]; then
		kill -TERM "$CADDY_PID" 2>/dev/null || true
		wait "$CADDY_PID" 2>/dev/null || true
	fi
	rm -rf "$TMPDIR"
}

trap shutdown EXIT INT TERM

cat >"$TMPDIR/Caddyfile" <<EOF
http://:8444 {
	handle /update.sh {
		root * $DAEMON_DIR
		file_server
	}
	handle /turbopaneld {
		root * $DAEMON_DIR/dist
		header Content-Type application/octet-stream
		file_server
	}
}
EOF

"$CADDY_BIN" run --config "$TMPDIR/Caddyfile" --adapter caddyfile &
CADDY_PID=$!
wait "$CADDY_PID"
