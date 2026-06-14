#!/usr/bin/env bash
# Reconcile co-located dev checkout ownership after git fetch/reset/pull.
#
# turbopanel (UID 9999) is the daemon user and git identity; instance (UID 9998,
# group turbopanel) runs systemd services and reads the tree via group perms.
# The human developer (whoever invoked ./console) edits via group ACL write.
# Git must never run as instance — it would create root-owned-by-9998 files that
# turbopanel cannot reclaim without the normalizer.
set -euo pipefail

usage() {
  echo "usage: $0 <checkout> [--prepare-reset | --ensure-runtime-dirs]" >&2
  exit 1
}

CHECKOUT="${1:?checkout path required}"
MODE="${2:-normalize}"
OWNER="${TURBOPANEL_USER:-turbopanel}"
GROUP="${TURBOPANEL_GROUP:-turbopanel}"
INSTANCE="${INSTANCE_USER:-instance}"
DEV_USER="${TURBOPANEL_DEV_USER:-}"

RUNTIME_DIRS=(.config .local .cache)
# Release artifacts stay instance-owned and outside the dev-editable ACL set.
ARTIFACT_DIRS=(dist)

HAS_SETFACL=false
if command -v setfacl >/dev/null 2>&1; then
  HAS_SETFACL=true
else
  echo "warning: setfacl not found; skipping ACL steps (install the acl package)" >&2
fi

strip_excluded_acls() {
  local name path
  for name in "$@"; do
    path="$CHECKOUT/$name"
    [[ -e "$path" ]] || continue
    setfacl -R -b "$path"
  done
}

apply_checkout_acls() {
  [[ "$HAS_SETFACL" == true ]] || return 0
  setfacl -R -m "g:${GROUP}:rwx" "${CHECKOUT}"
  setfacl -R -d -m "g:${GROUP}:rwx" "${CHECKOUT}"
  if [[ -n "$DEV_USER" ]]; then
    setfacl -R -m "u:${DEV_USER}:rwx" "${CHECKOUT}"
    setfacl -R -d -m "u:${DEV_USER}:rwx" "${CHECKOUT}"
  fi
  strip_excluded_acls "${RUNTIME_DIRS[@]}" "${ARTIFACT_DIRS[@]}"
}

prepare_reset() {
  local dir
  for dir in "${RUNTIME_DIRS[@]}"; do
    local path="$CHECKOUT/$dir"
    [[ -e "$path" ]] || continue
    rm -rf "$path"
  done
}

ensure_runtime_dirs() {
  local dir
  for dir in "${RUNTIME_DIRS[@]}"; do
    install -d -m 2770 -o "$INSTANCE" -g "$GROUP" "$CHECKOUT/$dir"
  done
  install -d -m 2770 -o "$INSTANCE" -g "$GROUP" "$CHECKOUT/.config/caddy"
  find "$CHECKOUT/.config" "$CHECKOUT/.local" "$CHECKOUT/.cache" \
    -xdev -exec chown "$INSTANCE:$GROUP" {} + 2>/dev/null || true
  apply_checkout_acls
}

normalize_ownership() {
  # Top-level checkout: setgid so new files stay in the turbopanel group.
  install -d -m 2770 -o "$OWNER" -g "$GROUP" "$CHECKOUT"

  # Runtime dirs inside the checkout (.local / .config are gitignored; owned by instance).
  # Release artifact dirs (dist) stay instance-owned after instance-build / ui-build.
  declare -A SKIP=(
    [".cache"]=1
    [".config"]=1
    [".local"]=1
  )
  local name
  for name in "${ARTIFACT_DIRS[@]}"; do
    SKIP["$name"]=1
  done

  should_skip() {
    local rel="$1"
    local top="${rel%%/*}"
    [[ -n "${SKIP[$top]+x}" ]]
  }

  while IFS= read -r -d '' path; do
    local rel="${path#"$CHECKOUT"/}"
    should_skip "$rel" && continue
    chown "$OWNER:$GROUP" "$path"
  done < <(find "$CHECKOUT" -xdev -user "$INSTANCE" -print0 2>/dev/null || true)

  if [[ -n "$DEV_USER" ]]; then
    while IFS= read -r -d '' path; do
      local rel="${path#"$CHECKOUT"/}"
      should_skip "$rel" && continue
      chown "$OWNER:$GROUP" "$path"
    done < <(find "$CHECKOUT" -xdev -user "$DEV_USER" -print0 2>/dev/null || true)
  fi

  apply_checkout_acls
}

case "$MODE" in
  normalize)
    normalize_ownership
    ;;
  --prepare-reset)
    prepare_reset
    ;;
  --ensure-runtime-dirs)
    ensure_runtime_dirs
    ;;
  *)
    usage
    ;;
esac
