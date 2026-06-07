#!/usr/bin/env bash
# Reconcile co-located dev checkout ownership after git fetch/reset/pull.
#
# turbopanel (UID 9999) is the developer and git identity; instance (UID 9998,
# group turbopanel) runs systemd services and reads the tree via group perms.
# Git must never run as instance — it would create root-owned-by-9998 files that
# 9999 cannot save in the editor.
set -euo pipefail

CHECKOUT="${1:?checkout path required}"
OWNER="${TURBOPANEL_USER:-turbopanel}"
GROUP="${TURBOPANEL_GROUP:-turbopanel}"

# Top-level checkout: setgid so new files stay in the turbopanel group.
install -d -m 2770 -o "$OWNER" -g "$GROUP" "$CHECKOUT"

# Instance $HOME/runtime paths (systemd sets HOME to the checkout on co-located dev).
declare -A SKIP=(
  [".cache"]=1
  [".config"]=1
  [".local"]=1
)

should_skip() {
  local rel="$1"
  local top="${rel%%/*}"
  [[ -n "${SKIP[$top]+x}" ]]
}

while IFS= read -r -d '' path; do
  rel="${path#"$CHECKOUT"/}"
  should_skip "$rel" && continue
  chown "$OWNER:$GROUP" "$path"
done < <(find "$CHECKOUT" -xdev -user instance -print0 2>/dev/null || true)
