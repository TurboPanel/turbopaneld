#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" != "0" ]; then
  echo "must run as root (use sudo)" >&2
  exit 1
fi

DAEMON_DIR="/opt/turbopanel/platform/daemon"
ANSIBLE_PLAYBOOK="$DAEMON_DIR/orchestration/runtime/venv/bin/ansible-playbook"
ANSIBLE_CFG="$DAEMON_DIR/orchestration/ansible.cfg"
PLAYBOOK="$DAEMON_DIR/orchestration/playbooks/daemon-systemd-setup.yml"

if [ ! -x "$ANSIBLE_PLAYBOOK" ]; then
  echo "ansible-playbook not found at $ANSIBLE_PLAYBOOK" >&2
  echo "run the official CDN-hosted installer or scripts/bootstrap-orchestration.sh first" >&2
  exit 1
fi

AFTER_INSTANCE=false
if systemctl is-enabled turbopanel-instance >/dev/null 2>&1; then
  AFTER_INSTANCE=true
fi

VARS_FILE="$(mktemp)"
trap 'rm -f "$VARS_FILE"' EXIT
printf 'turbopanel_after_instance_service: %s\n' "$([ "$AFTER_INSTANCE" = true ] && echo true || echo false)" > "$VARS_FILE"

ANSIBLE_CONFIG="$ANSIBLE_CFG" "$ANSIBLE_PLAYBOOK" \
  -i localhost, \
  -c local \
  -e "@$VARS_FILE" \
  "$PLAYBOOK"

systemctl daemon-reload
systemctl enable --now turbopanel-daemon

echo "turbopanel-daemon service installed and started"
echo "status: sudo systemctl status turbopanel-daemon"
echo "logs:   sudo tail -f /var/log/turbopanel/daemon/daemon.log"
echo "        sudo journalctl -u turbopanel-daemon -f"
