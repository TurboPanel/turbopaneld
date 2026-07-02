#!/usr/bin/env bash
# Runtime directory setup + single-daemon guard (runs as ExecStartPre).
#
# Ensures /run/turbopanel exists with shared group permissions and probes
# daemon.lock for a live holder before systemd starts a second daemon.
#
# The co-located daemon is the same turbopanel-daemon.service process, so this
# flock guard applies identically. The instance cell's single-writer lease
# (attachDaemonSocket / detachDaemonSocket, deduped by X-Real-IP / __direct__)
# is the runtime backstop on both Workers (DO lease) and self-hosted (Redis
# lease). Manual `deno task start/dev` bypasses flock (dev-only).
#
# The real single-daemon guard remains flock -n in turbopanel-daemon.service.
set -euo pipefail

RUN_DIR="/run/turbopanel"
LOCK_FILE="$RUN_DIR/daemon.lock"

if ! command -v flock >/dev/null 2>&1; then
  echo "ensure-single-daemon: flock (util-linux) is required but not installed" >&2
  exit 1
fi

# Group-writable + setgid so the in-group `instance` user can also bind sockets.
install -d -m 2770 -o turbopanel -g turbopanel "$RUN_DIR"

# Probe lock liveness via flock — never delete a held lock (avoids psmisc/fuser).
if [ -f "$LOCK_FILE" ]; then
  if ! flock -n "$LOCK_FILE" -c true; then
    echo "ensure-single-daemon: another turbopanel daemon already holds $LOCK_FILE" >&2
    echo "ensure-single-daemon: refusing duplicate start (double cell attach / heartbeats)" >&2
    exit 1
  fi
fi
