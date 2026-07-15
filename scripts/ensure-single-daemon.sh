#!/usr/bin/env bash
# Compatibility wrapper — the canonical helper ships under
# share/orchestration/scripts/ensure-single-daemon.sh (ExecStartPre).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CANONICAL="$SCRIPT_DIR/../orchestration/scripts/ensure-single-daemon.sh"
if [[ ! -x "$CANONICAL" ]]; then
  echo "ensure-single-daemon: missing $CANONICAL" >&2
  exit 1
fi
exec "$CANONICAL" "$@"
