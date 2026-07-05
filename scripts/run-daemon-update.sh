#!/bin/sh
set -eu

DAEMON_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/lib/runtime-paths.sh
. "$DAEMON_DIR/scripts/lib/runtime-paths.sh"
ANSIBLE_PLAYBOOK="$TURBOPANEL_RUNTIMES_DIR/ansible/current/bin/ansible-playbook"
ANSIBLE_CONFIG="$DAEMON_DIR/orchestration/ansible.cfg"
ANSIBLE_LOCAL_TMP="$TURBOPANEL_RUNTIMES_DIR/uv/cache/ansible-tmp"
PLAYBOOK="$DAEMON_DIR/orchestration/playbooks/daemon-update.yml"

if [ ! -x "$ANSIBLE_PLAYBOOK" ]; then
	echo "ansible-playbook not found at $ANSIBLE_PLAYBOOK" >&2
	echo "run-daemon-update.sh: run turbopaneld bootstrap-orchestration or scripts/bootstrap-orchestration.ts first" >&2
	exit 1
fi

ANSIBLE_CONFIG="$ANSIBLE_CONFIG" \
ANSIBLE_LOCAL_TEMP="$ANSIBLE_LOCAL_TEMP" \
"$ANSIBLE_PLAYBOOK" \
	-i localhost, \
	-c local \
	"$PLAYBOOK"
