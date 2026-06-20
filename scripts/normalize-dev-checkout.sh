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
  echo "usage: $0 <checkout> [--check-stamp | --force | --prepare-reset | --ensure-runtime-dirs]" >&2
  exit 1
}

CHECKOUT="${1:?checkout path required}"
MODE="${2:-normalize}"
OWNER="${TURBOPANEL_USER:-turbopanel}"
GROUP="${TURBOPANEL_GROUP:-turbopanel}"
INSTANCE="${INSTANCE_USER:-instance}"
DEV_USER="${TURBOPANEL_DEV_USER:-}"
DEV_UID="${TURBOPANEL_DEV_UID:-}"
DEV_GID="${TURBOPANEL_DEV_GID:-}"
STAMP_FILE="${CHECKOUT}/.turbopanel-checkout-stamp"

RUNTIME_DIRS=(.config .local .cache)
# Release artifacts stay instance-owned and outside the dev-editable ACL set.
ARTIFACT_DIRS=(dist)
# Generated trees excluded from ownership scans and recursive ACL work.
# .next / .open-next: Next.js dev + OpenNext build caches (website service runs as instance).
PRUNE_NAMES=(node_modules .git .pnpm-store .next .open-next)

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

compute_stamp() {
  local head="no-git"
  if [[ -d "$CHECKOUT/.git" ]]; then
    head="$(git -C "$CHECKOUT" rev-parse HEAD 2>/dev/null || echo no-git)"
  fi
  printf '%s:%s:%s:%s' "$DEV_USER" "$DEV_UID" "$DEV_GID" "$head"
}

stamp_matches() {
  [[ -f "$STAMP_FILE" ]] && [[ "$(cat "$STAMP_FILE")" == "$(compute_stamp)" ]]
}

write_stamp() {
  compute_stamp >"$STAMP_FILE"
}

should_skip_path() {
  local rel="$1"
  local part
  for part in "${PRUNE_NAMES[@]}" "${RUNTIME_DIRS[@]}" "${ARTIFACT_DIRS[@]}"; do
    [[ "$rel" == "$part" || "$rel" == "$part"/* ]] && return 0
  done
  return 1
}

find_prune_expr() {
  local expr=()
  local name
  for name in "${PRUNE_NAMES[@]}" "${RUNTIME_DIRS[@]}" "${ARTIFACT_DIRS[@]}"; do
    expr+=( -path "$CHECKOUT/$name" -o -path "$CHECKOUT/$name/*" )
  done
  printf '%s\n' "${expr[@]}"
}

apply_checkout_acls() {
  [[ "$HAS_SETFACL" == true ]] || return 0
  setfacl -m "g:${GROUP}:rwx" "${CHECKOUT}"
  setfacl -d -m "g:${GROUP}:rwx" "${CHECKOUT}"
  if [[ -n "$DEV_USER" ]]; then
    setfacl -m "u:${DEV_USER}:rwx" "${CHECKOUT}"
    setfacl -d -m "u:${DEV_USER}:rwx" "${CHECKOUT}"
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

  local prune_args=()
  local name
  for name in "${PRUNE_NAMES[@]}" "${RUNTIME_DIRS[@]}" "${ARTIFACT_DIRS[@]}"; do
    prune_args+=( -path "$CHECKOUT/$name" -o -path "$CHECKOUT/$name/*" )
  done

  while IFS= read -r -d '' path; do
    local rel="${path#"$CHECKOUT"/}"
    should_skip_path "$rel" && continue
    chown "$OWNER:$GROUP" "$path"
  done < <(
    find "$CHECKOUT" -xdev \( "${prune_args[@]}" \) -prune -o -user "$INSTANCE" -print0 2>/dev/null || true
  )

  if [[ -n "$DEV_USER" ]]; then
    while IFS= read -r -d '' path; do
      local rel="${path#"$CHECKOUT"/}"
      should_skip_path "$rel" && continue
      chown "$OWNER:$GROUP" "$path"
    done < <(
      find "$CHECKOUT" -xdev \( "${prune_args[@]}" \) -prune -o -user "$DEV_USER" -print0 2>/dev/null || true
    )
  fi

  apply_checkout_acls
  write_stamp
}

case "$MODE" in
  normalize|--force)
    normalize_ownership
    ;;
  --check-stamp)
    if stamp_matches; then
      exit 0
    fi
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
