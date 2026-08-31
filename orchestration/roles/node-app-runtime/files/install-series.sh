#!/bin/bash
# Vendors one tenant Node series. Invoked by vendor-series.yml with env:
# NODE_APP_SERIES, NODE_APP_ARCH, NODE_APP_RESOLVED, NODE_APP_GROUP,
# NODE_APP_SERIES_DIR. Kept out of the playbook so Ansible does not try to
# parse shell quotes as Jinja.
set -euo pipefail

SERIES="${NODE_APP_SERIES:?}"
ARCH="${NODE_APP_ARCH:?}"
RESOLVED="${NODE_APP_RESOLVED:?}"
GROUP="${NODE_APP_GROUP:?}"
SERIES_DIR="${NODE_APP_SERIES_DIR:?}"
DEST="${SERIES_DIR}/${RESOLVED}"

if [[ ! -x "${DEST}/bin/node" ]]; then
  NODE_DIR="node-v${RESOLVED}-linux-${ARCH}"
  TMP="${SERIES_DIR}/.install"
  rm -rf "$TMP" "$DEST"
  mkdir -p "$TMP"
  curl -fsSL --proto '=https' --tlsv1.2 -o "${TMP}/${NODE_DIR}.tar.gz" \
    "https://nodejs.org/dist/v${RESOLVED}/${NODE_DIR}.tar.gz"
  tar -xzf "${TMP}/${NODE_DIR}.tar.gz" -C "$TMP"
  install -d "$DEST"
  cp -a "${TMP}/${NODE_DIR}/bin" "${TMP}/${NODE_DIR}/include" \
    "${TMP}/${NODE_DIR}/lib" "${TMP}/${NODE_DIR}/share" "$DEST/"
  rm -rf "$TMP"
  echo "turbopanel-installed ${SERIES} ${RESOLVED}"
fi

# Unconditional: cp -a keeps upstream 0755, and a tree vendored before the
# per-series group still needs ownership repaired on a skip-install path.
chown -R "root:${GROUP}" "$DEST"
chmod -R u=rwX,g=rX,o= "$DEST"

CURRENT="$(readlink "${SERIES_DIR}/current" || true)"
if [[ "$CURRENT" != "$DEST" ]]; then
  ln -sfn "$DEST" "${SERIES_DIR}/.current.tmp"
  mv -Tf "${SERIES_DIR}/.current.tmp" "${SERIES_DIR}/current"
  echo "turbopanel-linked ${SERIES} ${RESOLVED}"
fi
