#!/usr/bin/env bash
#
# Bootstrap the orchestration runtime (uv -> Python -> ansible) before the main
# agent-install playbook can run. Idempotent: safe to re-run.
#
# Mirrors src/orchestration/{uv,python,ansible}.ts so install.sh does not need
# Deno to get Ansible on the host.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ORCHESTRATION="$ROOT/orchestration"
RUNTIME="$ORCHESTRATION/runtime"
BIN="$RUNTIME/bin"
VENV="$RUNTIME/venv"
REQUIREMENTS="$ORCHESTRATION/requirements.txt"

UV_VERSION="0.11.19"
PYTHON_VERSION="3.12"

log() { printf '\033[1;36m[bootstrap]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[bootstrap]\033[0m %s\n' "$*" >&2; }

resolve_uv_asset() {
  local arch
  arch="$(uname -m)"
  case "$arch" in
    aarch64|arm64) echo "uv-aarch64-unknown-linux-gnu.tar.gz" ;;
    x86_64|amd64) echo "uv-x86_64-unknown-linux-gnu.tar.gz" ;;
    *) err "unsupported architecture: $arch"; exit 1 ;;
  esac
}

installed_uv_version() {
  if [ ! -x "$BIN/uv" ]; then
    return 0
  fi
  "$BIN/uv" --version 2>/dev/null | awk '{print $2}'
}

ensure_uv() {
  local current asset url sha_url tmp inner
  current="$(installed_uv_version || true)"
  if [ "$current" = "$UV_VERSION" ]; then
    log "uv $UV_VERSION already installed"
    return 0
  fi

  asset="$(resolve_uv_asset)"
  url="https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset}"
  sha_url="${url}.sha256"
  log "downloading uv $UV_VERSION"

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  curl -fsSL "$url" -o "$tmp/$asset"
  curl -fsSL "$sha_url" -o "$tmp/${asset}.sha256"
  expected="$(awk '{print $1}' "$tmp/${asset}.sha256" | tr '[:upper:]' '[:lower:]')"
  actual="$(sha256sum "$tmp/$asset" | awk '{print $1}')"
  if [ "$expected" != "$actual" ]; then
    err "uv archive checksum mismatch"
    exit 1
  fi

  mkdir -p "$BIN"
  tar -xzf "$tmp/$asset" -C "$tmp"
  inner="$tmp/${asset%.tar.gz}"
  install -m 0755 "$inner/uv" "$BIN/uv"
  install -m 0755 "$inner/uvx" "$BIN/uvx"

  current="$(installed_uv_version || true)"
  if [ "$current" != "$UV_VERSION" ]; then
    err "uv install verification failed (got ${current:-none})"
    exit 1
  fi
  log "uv $UV_VERSION installed at $BIN/uv"
}

ensure_python() {
  log "ensuring Python $PYTHON_VERSION"
  export PATH="$BIN:$PATH"
  export UV_PYTHON_INSTALL_DIR="$RUNTIME/python"
  export UV_CACHE_DIR="$RUNTIME/cache"
  export UV_NO_MODIFY_PATH=1
  export UV_PYTHON_DOWNLOADS=automatic
  "$BIN/uv" python install "$PYTHON_VERSION"
  log "Python $PYTHON_VERSION ready"
}

ansible_playbook_works() {
  [ -x "$VENV/bin/ansible-playbook" ] && "$VENV/bin/ansible-playbook" --version >/dev/null 2>&1
}

ensure_ansible() {
  export PATH="$BIN:$PATH"
  export UV_PYTHON_INSTALL_DIR="$RUNTIME/python"
  export UV_CACHE_DIR="$RUNTIME/cache"
  export UV_NO_MODIFY_PATH=1
  export UV_PYTHON_DOWNLOADS=automatic

  if ansible_playbook_works; then
    log "ansible already installed, skipping setup"
    return 0
  fi

  log "creating ansible venv at $VENV"
  "$BIN/uv" venv --python "$PYTHON_VERSION" "$VENV"
  "$BIN/uv" pip install --python "$VENV" --requirements "$REQUIREMENTS"

  if ! ansible_playbook_works; then
    err "ansible install verification failed"
    exit 1
  fi
  log "ansible installed at $VENV/bin/ansible-playbook"
}

mkdir -p "$RUNTIME"
ensure_uv
ensure_python
ensure_ansible
