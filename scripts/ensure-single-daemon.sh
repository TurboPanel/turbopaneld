#!/usr/bin/env bash
# Stop legacy Tilt and ensure only systemd runs the daemon on this host.
set -euo pipefail

DAEMON_DIR="${TURBOPANEL_DAEMON_DIR:-/opt/turbopanel/platform/daemon}"
INSTALL_ROOT="${TURBOPANEL_INSTALL_ROOT:-/opt/turbopanel}"
RUN_DIR="/run/turbopanel"

install -d -m 0750 -o turbopanel -g turbopanel "$RUN_DIR"

if command -v tilt >/dev/null 2>&1; then
  sudo -u turbopanel env HOME="$INSTALL_ROOT" PATH="/usr/local/bin:$INSTALL_ROOT/runtimes/deno/current:${PATH}" \
    bash -lc "cd '$DAEMON_DIR' && tilt down" >/dev/null 2>&1 || true
fi

# Drop stale lock after unclean shutdown (flock creates it on start).
if [ -f "$RUN_DIR/daemon.lock" ]; then
  if ! fuser "$RUN_DIR/daemon.lock" >/dev/null 2>&1; then
    rm -f "$RUN_DIR/daemon.lock"
  fi
fi
