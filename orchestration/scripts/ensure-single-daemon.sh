#!/usr/bin/env bash
# Runtime directory setup + single-daemon guard (runs as ExecStartPre).
#
# Ensures /run/turbopanel exists with shared group permissions and clears a
# stale daemon.lock left by an unclean shutdown.
set -euo pipefail

RUN_DIR="/run/turbopanel"

# Group-writable + setgid so the in-group `instance` user can also bind sockets.
install -d -m 2770 -o turbopanel -g turbopanel "$RUN_DIR"

# Drop stale lock after unclean shutdown (flock creates it on start).
if [ -f "$RUN_DIR/daemon.lock" ]; then
  if ! fuser "$RUN_DIR/daemon.lock" >/dev/null 2>&1; then
    rm -f "$RUN_DIR/daemon.lock"
  fi
fi
