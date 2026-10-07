#!/bin/sh
# Builds the vendored Apache httpd (+ bundled APR / APR-util) once, for the
# CPU this script runs on, and writes apache-<httpdver>-<arch>.tar.gz plus its
# .sha256 file into OUT_DIR. The `apache` Ansible role downloads that tarball
# instead of compiling on every host; .github/workflows/vendor-apache.yml runs
# this on a native x86_64 and a native arm64 runner so both come from the same
# flags.
#
# Usage: sh scripts/build-apache.sh <out-dir>
# Versions and source URLs come from orchestration/roles/apache/defaults/main.yml
# (the single pin). Needs: build-essential libexpat1-dev libpcre2-dev
# libssl-dev zlib1g-dev curl.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
DEFAULTS="$ROOT/orchestration/roles/apache/defaults/main.yml"
OUT_DIR="${1:?usage: build-apache.sh <out-dir>}"

pin() {
  key="$1"
  sed -n "s/^${key}: \"\\(.*\\)\"\$/\\1/p" "$DEFAULTS" | head -n 1
}
HTTPD_VER="$(pin apache_version)"
APR_VER="$(pin apache_apr_version)"
APU_VER="$(pin apache_apr_util_version)"
[ -n "$HTTPD_VER" ] && [ -n "$APR_VER" ] && [ -n "$APU_VER" ] || {
  echo "could not read the Apache pins from $DEFAULTS" >&2
  exit 1
}

case "$(uname -m)" in
  x86_64) ARCH=x86_64 ;;
  aarch64 | arm64) ARCH=aarch64 ;;
  *) echo "unsupported CPU: $(uname -m)" >&2; exit 1 ;;
esac

BASE="https://archive.apache.org/dist"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
STAGE="$TMP/stage"
mkdir -p "$STAGE" "$OUT_DIR"
OUT_DIR="$(CDPATH= cd -- "$OUT_DIR" && pwd)"

curl --proto "=https" --tlsv1.2 -fsSL -o "$TMP/httpd.tar.gz" "$BASE/httpd/httpd-$HTTPD_VER.tar.gz"
curl --proto "=https" --tlsv1.2 -fsSL -o "$TMP/apr.tar.gz" "$BASE/apr/apr-$APR_VER.tar.gz"
curl --proto "=https" --tlsv1.2 -fsSL -o "$TMP/apr-util.tar.gz" "$BASE/apr/apr-util-$APU_VER.tar.gz"
tar -xzf "$TMP/httpd.tar.gz" -C "$TMP"
tar -xzf "$TMP/apr.tar.gz" -C "$TMP"
tar -xzf "$TMP/apr-util.tar.gz" -C "$TMP"
mv "$TMP/apr-$APR_VER" "$TMP/httpd-$HTTPD_VER/srclib/apr"
mv "$TMP/apr-util-$APU_VER" "$TMP/httpd-$HTTPD_VER/srclib/apr-util"

# The compiled-in prefix is only a default: the role's httpd.conf sets
# ServerRoot explicitly, so the tree runs from any vendor directory.
cd "$TMP/httpd-$HTTPD_VER"
./configure \
  --prefix="/opt/apache-build/$HTTPD_VER" \
  --with-included-apr \
  --enable-mpms-shared=event \
  --with-mpm=event \
  --enable-mods-shared=most \
  --enable-so \
  --disable-imagemap
make -j"$(nproc)"
make install DESTDIR="$STAGE"

# The staged tree is the prefix's contents; ship it rooted at the version dir.
TREE="$STAGE/opt/apache-build/$HTTPD_VER"
rm -rf "$TREE/manual" "$TREE/htdocs" "$TREE/cgi-bin"
mkdir -p "$TREE/htdocs"

ASSET="apache-$HTTPD_VER-$ARCH.tar.gz"
tar -czf "$OUT_DIR/$ASSET" -C "$TREE" .
(cd "$OUT_DIR" && sha256sum "$ASSET" >"$ASSET.sha256")
cat "$OUT_DIR/$ASSET.sha256"
