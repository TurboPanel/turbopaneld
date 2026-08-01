#!/bin/sh
# Install the vendored hosting Caddy binary on a managed daemon host.
# Used when environment.deploy fails with:
#   Hosting Caddy runtime is missing: <runtimesDir>/caddy/current/caddy
# before the daemon has on-demand caddy-setup (or when Sync Dev Build cannot
# reach managed installs).
#
# Usage (on the target host, with sudo):
#   curl -fsSL … | sudo sh
#   — or —
#   sudo sh scripts/install-hosting-caddy.sh

set -eu

CADDY_VER="${CADDY_VER:-2.10.2}"
CADDY_TAG="${CADDY_TAG:-v${CADDY_VER}}"
# Same composition as scripts/lib/runtime-paths.sh (keep curl|sh self-contained).
TURBOPANEL_HOME="${TURBOPANEL_HOME:-/opt/turbopanel}"
VENDOR_DIR="${TURBOPANEL_RUNTIMES_DIR:-${TURBOPANEL_HOME}/vendor}"
GROUP="${TURBOPANEL_GROUP:-tp}"

arch="$(uname -m)"
case "$arch" in
  aarch64 | arm64) CADDY_ARCH=arm64 ;;
  x86_64 | amd64) CADDY_ARCH=amd64 ;;
  *)
    echo "unsupported architecture: $arch" >&2
    exit 1
    ;;
esac

target_dir="${VENDOR_DIR}/caddy/${CADDY_VER}"
target_bin="${target_dir}/caddy"
current_link="${VENDOR_DIR}/caddy/current"

if [ -x "$target_bin" ] && [ -L "$current_link" ]; then
  echo "hosting Caddy already present at ${current_link}/caddy"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
ASSET="caddy_${CADDY_VER}_linux_${CADDY_ARCH}.tar.gz"
# HTTPS-only fetch (block clear-text redirect downgrades; Sonar shell:S6506).
curl -fsSL --proto "=https" --proto-redir "=https" -o "${TMP}/${ASSET}" \
  "https://github.com/caddyserver/caddy/releases/download/${CADDY_TAG}/${ASSET}"
tar -xzf "${TMP}/${ASSET}" -C "$TMP" caddy

install -d "$target_dir"
install -m 0750 "${TMP}/caddy" "$target_bin"
chown "root:${GROUP}" "$target_bin"
ln -sfn "$target_dir" "$current_link"

echo "installed ${current_link}/caddy (${CADDY_VER} ${CADDY_ARCH})"
