#!/usr/bin/env bash
# One-time legacy cleanup + single-daemon guard (runs as ExecStartPre).
#
# Earlier dev hosts ran the daemon/instance under Tilt and ad-hoc dev systemd
# units. systemd is now the only runtime. On the next daemon update + restart
# this stops any leftover Tilt process and removes the obsolete dev units so
# they cannot fight systemd over /ws or the socket. All steps are best-effort
# and idempotent.
set -euo pipefail

DAEMON_DIR="${TURBOPANEL_DAEMON_DIR:-/opt/turbopanel/platform/daemon}"
INSTALL_ROOT="${TURBOPANEL_INSTALL_ROOT:-/opt/turbopanel}"
RUN_DIR="/run/turbopanel"

# Group-writable + setgid so the in-group `instance` user can also bind sockets.
install -d -m 2770 -o turbopanel -g turbopanel "$RUN_DIR"

# Stop a leftover Tilt session from the old dev workflow.
if command -v tilt >/dev/null 2>&1; then
  sudo -u turbopanel env HOME="$INSTALL_ROOT" PATH="/usr/local/bin:$INSTALL_ROOT/runtimes/deno/current:${PATH}" \
    bash -lc "cd '$DAEMON_DIR' && tilt down" >/dev/null 2>&1 || true
fi

# Remove obsolete dev systemd units from the pre-systemd / Tilt era, if present.
for legacy in turbopanel-tilt turbopanel-dev turbopanel-instance-tilt; do
  if systemctl list-unit-files "${legacy}.service" >/dev/null 2>&1; then
    systemctl disable --now "${legacy}.service" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/${legacy}.service" || true
  fi
done

# Drop stale lock after unclean shutdown (flock creates it on start).
if [ -f "$RUN_DIR/daemon.lock" ]; then
  if ! fuser "$RUN_DIR/daemon.lock" >/dev/null 2>&1; then
    rm -f "$RUN_DIR/daemon.lock"
  fi
fi
