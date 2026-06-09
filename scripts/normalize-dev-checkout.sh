#!/usr/bin/env bash
# Reconcile co-located dev checkout ownership after git fetch/reset/pull.
#
# turbopanel (UID 9999) is the developer and git identity; instance (UID 9998,
# group turbopanel) runs systemd services and reads the tree via group perms.
# Git must never run as instance — it would create root-owned-by-9998 files that
# 9999 cannot save in the editor.
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

RUNTIME_DIRS=(.config .local .cache)

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
}

normalize_ownership() {
  # Top-level checkout: setgid so new files stay in the turbopanel group.
  install -d -m 2770 -o "$OWNER" -g "$GROUP" "$CHECKOUT"

  # Runtime dirs inside the checkout (.local / .config are gitignored; owned by instance).
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
    local rel="${path#"$CHECKOUT"/}"
    should_skip "$rel" && continue
    chown "$OWNER:$GROUP" "$path"
  done < <(find "$CHECKOUT" -xdev -user "$INSTANCE" -print0 2>/dev/null || true)
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
