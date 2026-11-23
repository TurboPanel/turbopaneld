#!/bin/sh
# wait-docker-gate.sh <gate-unit> <gate-socket> <seconds>
#
# ExecStartPre of turbopaneld.service on a managed host: the daemon reaches
# Docker only through the Docker gate, so its start waits (bounded) for the
# gate's socket and for the gate unit to be active.
#
# - The gate unit is not installed (a site-only host, no Docker): nothing to
#   wait for, exit 0.
# - The gate does not come up within the time: warn and exit 0. The daemon
#   still serves its non-Docker work, and every Docker call fails closed
#   (the socket is absent, and there is no fallback to the engine's own).
#
# Runs as the daemon account, so it uses `systemctl show` / `is-active`
# (both readable by anyone) and never reads the root-owned unit file.
set -eu

unit="${1:?usage: wait-docker-gate.sh <gate-unit> <gate-socket> <seconds>}"
socket="${2:?usage: wait-docker-gate.sh <gate-unit> <gate-socket> <seconds>}"
seconds="${3:-60}"
case "$seconds" in
  '' | *[!0-9]*) seconds=60 ;;
  *) ;;
esac

load_state="$(systemctl show -p LoadState --value "$unit" 2>/dev/null || true)"
if [ "$load_state" != "loaded" ]; then
  exit 0
fi

# `-S` alone is not enough: a socket file left behind by a gate that has
# stopped (or from before a reboot) still tests true, so the unit must also be
# active. A gate that is active but has not yet bound its socket is covered by
# the `-S` test; the loop waits for both.
waited=0
while [ "$waited" -lt "$seconds" ]; do
  if [ -S "$socket" ] && systemctl is-active --quiet "$unit"; then
    exit 0
  fi
  sleep 1
  waited=$((waited + 1))
done

echo "wait-docker-gate: $unit is not serving $socket after ${seconds}s; starting without it, Docker calls will fail closed" >&2
exit 0
