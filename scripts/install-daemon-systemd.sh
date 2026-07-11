#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" != "0" ]; then
  echo "must run as root (use sudo)" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON_DIR="${TURBOPANEL_DAEMON_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
# shellcheck source=scripts/lib/runtime-paths.sh
. "$SCRIPT_DIR/lib/runtime-paths.sh"
ANSIBLE_PLAYBOOK="$RUNTIMES_DIR/ansible/current/bin/ansible-playbook"
ANSIBLE_CFG="$DAEMON_DIR/orchestration/ansible.cfg"
ANSIBLE_HOME_DIR="$RUNTIMES_DIR/ansible/home"
ANSIBLE_LOCAL_TMP="$RUNTIMES_DIR/uv/cache/ansible-tmp"
PLAYBOOK="$DAEMON_DIR/orchestration/playbooks/daemon-systemd-setup.yml"
SERVICE_NAME="turbopaneld"

if [ ! -x "$ANSIBLE_PLAYBOOK" ]; then
  echo "ansible-playbook not found at $ANSIBLE_PLAYBOOK" >&2
  echo "run scripts/bootstrap-orchestration.ts via Deno first (run.sh does this on managed installs)" >&2
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
  # Optional override: point the daemon unit at a host-provided Deno or a
  # nonstandard runtimes root. Unset → playbook/role default
  # ({{ turbopanel_runtimes_dir }}/deno/bin/deno).
  if [ -n "${TURBOPANEL_DAEMON_DENO_BIN:-}" ]; then
    printf 'turbopanel_daemon_deno_bin: %s\n' "$TURBOPANEL_DAEMON_DENO_BIN"
  fi
  printf 'turbopanel_runtimes_dir: %s\n' "$RUNTIMES_DIR"
  printf 'turbopanel_daemon_dir: %s\n' "$DAEMON_DIR"
  if [ -n "${TURBOPANEL_DEV_USER:-}" ]; then
    printf 'turbopanel_dev_user: %s\n' "$TURBOPANEL_DEV_USER"
    printf 'turbopanel_dev_uid: %s\n' "${TURBOPANEL_DEV_UID:-}"
    printf 'turbopanel_dev_gid: %s\n' "${TURBOPANEL_DEV_GID:-}"
    printf 'turbopanel_dev_root: %s\n' "${TURBOPANEL_DEV_ROOT:-}"
  fi
} > "$VARS_FILE"

mkdir -p "$ANSIBLE_HOME_DIR"
ANSIBLE_CONFIG="$ANSIBLE_CFG" \
ANSIBLE_HOME="$ANSIBLE_HOME_DIR" \
ANSIBLE_LOCAL_TEMP="$ANSIBLE_LOCAL_TMP" \
"$ANSIBLE_PLAYBOOK" \
  -i localhost, \
  -c local \
  -e "@$VARS_FILE" \
  "$PLAYBOOK"

systemctl daemon-reload

if [ "$START_DAEMON" = true ]; then
  systemctl enable --now "$SERVICE_NAME"
  echo "${SERVICE_NAME} service installed and started"
else
  echo "${SERVICE_NAME} service installed (start deferred)"
fi
echo "status: sudo systemctl status ${SERVICE_NAME}"
echo "logs:   tail -f /var/log/turbopanel/daemon.log"
echo "        sudo journalctl -u ${SERVICE_NAME} -f"
