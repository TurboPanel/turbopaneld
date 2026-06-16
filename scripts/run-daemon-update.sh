#!/bin/sh
set -eu

DAEMON_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ANSIBLE_PLAYBOOK="$DAEMON_DIR/orchestration/runtime/venv/bin/ansible-playbook"
ANSIBLE_CONFIG="$DAEMON_DIR/orchestration/ansible.cfg"
PLAYBOOK="$DAEMON_DIR/orchestration/playbooks/daemon-update.yml"

if [ ! -x "$ANSIBLE_PLAYBOOK" ]; then
	echo "ansible-playbook not found at $ANSIBLE_PLAYBOOK" >&2
	echo "run scripts/bootstrap-orchestration.sh first" >&2
	exit 1
fi

ANSIBLE_CONFIG="$ANSIBLE_CONFIG" "$ANSIBLE_PLAYBOOK" \
	-i localhost, \
	-c local \
	"$PLAYBOOK"
