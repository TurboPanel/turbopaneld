#!/bin/sh
set -eu

DAEMON_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIMES_DIR="${TURBOPANEL_RUNTIMES_DIR:-/opt/turbopanel/runtimes}"
ANSIBLE_PLAYBOOK="$RUNTIMES_DIR/ansible/current/bin/ansible-playbook"
ANSIBLE_CONFIG="$DAEMON_DIR/orchestration/ansible.cfg"
ANSIBLE_LOCAL_TMP="$RUNTIMES_DIR/uv/cache/ansible-tmp"
ANSIBLE_COLLECTIONS_PATH="$RUNTIMES_DIR/ansible/galaxy-collections"
PLAYBOOK="$DAEMON_DIR/orchestration/playbooks/daemon-update.yml"

if [ ! -x "$ANSIBLE_PLAYBOOK" ]; then
	echo "ansible-playbook not found at $ANSIBLE_PLAYBOOK" >&2
	echo "run-daemon-update.sh: run the compiled bootstrap binary or scripts/bootstrap-orchestration.ts first" >&2
	exit 1
fi

ANSIBLE_CONFIG="$ANSIBLE_CONFIG" \
ANSIBLE_LOCAL_TEMP="$ANSIBLE_LOCAL_TMP" \
ANSIBLE_COLLECTIONS_PATH="$ANSIBLE_COLLECTIONS_PATH" \
"$ANSIBLE_PLAYBOOK" \
	-i localhost, \
	-c local \
	"$PLAYBOOK"
