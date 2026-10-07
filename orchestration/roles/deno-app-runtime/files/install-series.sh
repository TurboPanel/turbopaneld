#!/bin/bash
# Vendors one tenant Deno series. Invoked by vendor-series.yml with env:
# DENO_APP_SERIES, DENO_APP_ARCH, DENO_APP_RESOLVED, DENO_APP_GROUP,
# DENO_APP_SERIES_DIR, DENO_APP_DIST_URL. Kept out of the playbook so Ansible
# does not try to parse shell quotes as Jinja.
set -euo pipefail

SERIES="${DENO_APP_SERIES:?}"
ARCH="${DENO_APP_ARCH:?}"
RESOLVED="${DENO_APP_RESOLVED:?}"
GROUP="${DENO_APP_GROUP:?}"
SERIES_DIR="${DENO_APP_SERIES_DIR:?}"
DIST_URL="${DENO_APP_DIST_URL:?}"
DEST="${SERIES_DIR}/${RESOLVED}"

if [[ ! -x "${DEST}/bin/deno" ]]; then
  ARCHIVE="deno-${ARCH}-unknown-linux-gnu.zip"
  TMP="${SERIES_DIR}/.install"
  rm -rf "$TMP" "$DEST"
  mkdir -p "$TMP"
  curl -fsSL --proto '=https' --tlsv1.2 -o "${TMP}/${ARCHIVE}" \
    "${DIST_URL}/release/v${RESOLVED}/${ARCHIVE}"
  # The release publishes one SHA-256 per archive ("<hash>  <archive name>").
  curl -fsSL --proto '=https' --tlsv1.2 -o "${TMP}/${ARCHIVE}.sha256sum" \
    "${DIST_URL}/release/v${RESOLVED}/${ARCHIVE}.sha256sum"
  (cd "$TMP" && grep -F " ${ARCHIVE}" "${ARCHIVE}.sha256sum" | sha256sum -c -)
  unzip -q -o "${TMP}/${ARCHIVE}" -d "${TMP}/extract"
  install -d "${DEST}/bin"
  install -m 0755 "${TMP}/extract/deno" "${DEST}/bin/deno"
  rm -rf "$TMP"
  echo "turbopanel-installed ${SERIES} ${RESOLVED}"
fi

# Unconditional: a tree vendored before the per-series group still needs its
# ownership repaired on a skip-install path.
chown -R "root:${GROUP}" "$DEST"
chmod -R u=rwX,g=rX,o= "$DEST"

CURRENT="$(readlink "${SERIES_DIR}/current" || true)"
if [[ "$CURRENT" != "$DEST" ]]; then
  ln -sfn "$DEST" "${SERIES_DIR}/.current.tmp"
  mv -Tf "${SERIES_DIR}/.current.tmp" "${SERIES_DIR}/current"
  echo "turbopanel-linked ${SERIES} ${RESOLVED}"
fi
