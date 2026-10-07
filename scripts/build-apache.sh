#!/bin/sh
# Builds the vendored Apache httpd (+ bundled APR / APR-util) once, for the
# CPU this script runs on, and writes apache-<httpdver>-<arch>.tar.gz plus its
# .sha256 file into OUT_DIR. The `apache` Ansible role downloads that tarball
# instead of compiling on every host; .github/workflows/vendor-apache.yml runs
# this on a native x86_64 and a native arm64 runner so both come from the same
# flags.
#
# Usage: APACHE_VENDOR_ROOT=<vendor dir> sh scripts/build-apache.sh <out-dir>
# APACHE_VENDOR_ROOT is the production vendor directory (the workflow sets it);
# it is baked into apxs / config_vars.mk / envvars as the install prefix, and the
# tree is staged with DESTDIR so nothing is installed on the build machine.
# Source tarballs are verified against the SHA-256 pins in the role defaults.
# Versions and source URLs come from orchestration/roles/apache/defaults/main.yml
# (the single pin). Needs: build-essential libexpat1-dev libpcre2-dev
# libssl-dev zlib1g-dev curl.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
DEFAULTS="$ROOT/orchestration/roles/apache/defaults/main.yml"
OUT_DIR="${1:?usage: build-apache.sh <out-dir>}"
VENDOR_ROOT="${APACHE_VENDOR_ROOT:?set APACHE_VENDOR_ROOT to the production vendor directory}"

pin() {
  key="$1"
  sed -n "s/^${key}: \"\\(.*\\)\"\$/\\1/p" "$DEFAULTS" | head -n 1
}
HTTPD_VER="$(pin apache_version)"
APR_VER="$(pin apache_apr_version)"
APU_VER="$(pin apache_apr_util_version)"
HTTPD_SHA="$(pin apache_httpd_sha256)"
APR_SHA="$(pin apache_apr_sha256)"
APU_SHA="$(pin apache_apr_util_sha256)"
[ -n "$HTTPD_VER" ] && [ -n "$APR_VER" ] && [ -n "$APU_VER" ] &&
  [ -n "$HTTPD_SHA" ] && [ -n "$APR_SHA" ] && [ -n "$APU_SHA" ] || {
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

fetch() { # <url> <file> <sha256>
  curl --proto "=https" --tlsv1.2 -fsSL -o "$2" "$1"
  echo "$3  $2" | sha256sum -c -
}
fetch "$BASE/httpd/httpd-$HTTPD_VER.tar.gz" "$TMP/httpd.tar.gz" "$HTTPD_SHA"
fetch "$BASE/apr/apr-$APR_VER.tar.gz" "$TMP/apr.tar.gz" "$APR_SHA"
fetch "$BASE/apr/apr-util-$APU_VER.tar.gz" "$TMP/apr-util.tar.gz" "$APU_SHA"
tar -xzf "$TMP/httpd.tar.gz" -C "$TMP"
tar -xzf "$TMP/apr.tar.gz" -C "$TMP"
tar -xzf "$TMP/apr-util.tar.gz" -C "$TMP"
mv "$TMP/apr-$APR_VER" "$TMP/httpd-$HTTPD_VER/srclib/apr"
mv "$TMP/apr-util-$APU_VER" "$TMP/httpd-$HTTPD_VER/srclib/apr-util"

# Real production prefix, so apxs / config_vars.mk / envvars carry the right
# paths. Optional modules that would pull in libraries the hosts do not install
# are switched off explicitly; the ldd gate below catches anything else.
cd "$TMP/httpd-$HTTPD_VER"
./configure \
  --prefix="$VENDOR_ROOT/apache/$HTTPD_VER" \
  --with-included-apr \
  --enable-mpms-shared=event \
  --with-mpm=event \
  --enable-mods-shared=most \
  --enable-so \
  --disable-imagemap \
  --disable-http2 \
  --disable-proxy-http2 \
  --disable-brotli \
  --disable-lua \
  --disable-md \
  --disable-proxy-html \
  --disable-xml2enc \
  --disable-session-crypto
make -j"$(nproc)"
make install DESTDIR="$STAGE"

# The staged tree is the prefix's contents; ship it rooted at the version dir.
PREFIX="$VENDOR_ROOT/apache/$HTTPD_VER"
TREE="$STAGE$PREFIX"
rm -rf "$TREE/manual" "$TREE/htdocs" "$TREE/cgi-bin"
mkdir -p "$TREE/htdocs"

# Fail the build if httpd or any module links a library the hosts do not get
# from the role's runtime package list (apache_runtime_packages): libc family,
# zlib, expat, pcre2, openssl, libuuid, plus the bundled APR under the tree.
BAD=""
for f in "$TREE/bin/httpd" "$TREE"/modules/*.so; do
  while read -r lib rest; do
    case "$lib" in
      linux-vdso* | /lib*/ld-linux* | ld-linux*) continue ;;
      libc.so* | libm.so* | libdl.so* | libpthread.so* | libcrypt.so* | librt.so*) continue ;;
      libz.so* | libexpat.so* | libpcre2-8.so* | libssl.so* | libcrypto.so* | libuuid.so*) continue ;;
    esac
    case "$rest" in
      *"=> $TREE/"*) continue ;;
    esac
    BAD="$BAD $f:$lib"
  done <<LDD
$(LD_LIBRARY_PATH="$TREE/lib" ldd "$f")
LDD
done
[ -z "$BAD" ] || {
  echo "unexpected shared library dependencies (add the package to apache_runtime_packages and the allow list, or disable the module):$BAD" >&2
  exit 1
}

ASSET="apache-$HTTPD_VER-$ARCH.tar.gz"
tar --sort=name --owner=0 --group=0 --numeric-owner -czf "$OUT_DIR/$ASSET" -C "$TREE" .
(cd "$OUT_DIR" && sha256sum "$ASSET" >"$ASSET.sha256")
cat "$OUT_DIR/$ASSET.sha256"
