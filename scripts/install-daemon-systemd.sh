#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" != "0" ]; then
  echo "must run as root (use sudo)" >&2
  exit 1
fi

DAEMON_DIR="/opt/turbopanel/platform/daemon"
RUNTIMES_DIR="${TURBOPANEL_RUNTIMES_DIR:-/opt/turbopanel/runtimes}"
ANSIBLE_PLAYBOOK="$RUNTIMES_DIR/ansible/current/bin/ansible-playbook"
ANSIBLE_CFG="$DAEMON_DIR/orchestration/ansible.cfg"
ANSIBLE_LOCAL_TMP="$RUNTIMES_DIR/uv/cache/ansible-tmp"
ANSIBLE_COLLECTIONS_PATH="$RUNTIMES_DIR/ansible/galaxy-collections"
PLAYBOOK="$DAEMON_DIR/orchestration/playbooks/daemon-systemd-setup.yml"

if [ ! -x "$ANSIBLE_PLAYBOOK" ]; then
  echo "ansible-playbook not found at $ANSIBLE_PLAYBOOK" >&2
  echo "run scripts/bootstrap-orchestration.ts (deno run) first" >&2
  exit 1
fi

AFTER_INSTANCE=false
if systemctl is-enabled turbopanel-instance >/dev/null 2>&1; then
  AFTER_INSTANCE=true
fi

START_DAEMON=true
if [ "${TURBOPANEL_SKIP_DAEMON_START:-}" = "1" ]; then
  START_DAEMON=false
fi

VARS_FILE="$(mktemp)"
trap 'rm -f "$VARS_FILE"' EXIT
{
  printf 'turbopanel_after_instance_service: %s\n' "$([ "$AFTER_INSTANCE" = true ] && echo true || echo false)"
  printf 'turbopanel_start: %s\n' "$([ "$START_DAEMON" = true ] && echo true || echo false)"
} > "$VARS_FILE"

ANSIBLE_CONFIG="$ANSIBLE_CFG" \
ANSIBLE_LOCAL_TEMP="$ANSIBLE_LOCAL_TMP" \
ANSIBLE_COLLECTIONS_PATH="$ANSIBLE_COLLECTIONS_PATH" \
"$ANSIBLE_PLAYBOOK" \
  -i localhost, \
  -c local \
  -e "@$VARS_FILE" \
  "$PLAYBOOK"

systemctl daemon-reload

if [ "$START_DAEMON" = true ]; then
  systemctl enable --now turbopanel-daemon
  echo "turbopanel-daemon service installed and started"
else
  echo "turbopanel-daemon service installed (start deferred)"
fi
echo "status: sudo systemctl status turbopanel-daemon"
echo "logs:   tail -f /opt/turbopanel/platform/daemon/logs/daemon.log"
echo "        sudo journalctl -u turbopanel-daemon -f"
