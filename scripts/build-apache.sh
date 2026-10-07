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

# ASF release-manager key fingerprints for these exact releases: the signers
# of httpd-2.4.63 (Jim Jagielski) and of apr-1.7.5 / apr-util-1.6.3 (Eric
# Covener), read from the VALIDSIG of each .asc against the ASF KEYS files.
# Bump them with the versions.
HTTPD_SIGNER="A93D62ECC3C8EA12DB220EC934EA76E6791485A8"
APR_SIGNER="65B2D44FE74BD5E3DE3AC3F082781DE46D5954FA"

GNUPGHOME="$TMP/gnupg"
export GNUPGHOME
mkdir -p "$GNUPGHOME"
chmod 700 "$GNUPGHOME"
KEYS_BASE="https://downloads.apache.org"
for k in httpd apr; do
  curl --proto "=https" --tlsv1.2 -fsSL -o "$TMP/$k.KEYS" "$KEYS_BASE/$k/KEYS"
  gpg --batch --quiet --import "$TMP/$k.KEYS"
done

fetch() { # <url> <file> <sha256> <signer fingerprint>
  fetch_url="$1"
  fetch_file="$2"
  fetch_sha="$3"
  fetch_signer="$4"
  curl --proto "=https" --tlsv1.2 -fsSL -o "$fetch_file" "$fetch_url"
  curl --proto "=https" --tlsv1.2 -fsSL -o "$fetch_file.asc" "$fetch_url.asc"
  echo "$fetch_sha  $fetch_file" | sha256sum -c -
  # The signature must verify and come from the pinned release manager.
  gpg --batch --status-fd 1 --verify "$fetch_file.asc" "$fetch_file" 2>/dev/null |
    grep -q "^\[GNUPG:\] VALIDSIG $fetch_signer " || {
    echo "signature check failed for $fetch_url (expected signer $fetch_signer)" >&2
    exit 1
  }
}
fetch "$BASE/httpd/httpd-$HTTPD_VER.tar.gz" "$TMP/httpd.tar.gz" "$HTTPD_SHA" "$HTTPD_SIGNER"
fetch "$BASE/apr/apr-$APR_VER.tar.gz" "$TMP/apr.tar.gz" "$APR_SHA" "$APR_SIGNER"
fetch "$BASE/apr/apr-util-$APU_VER.tar.gz" "$TMP/apr-util.tar.gz" "$APU_SHA" "$APR_SIGNER"
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
  --disable-session-crypto \
  --disable-ldap \
  --disable-authnz-ldap \
  --disable-socache-dc \
  --without-sqlite3 \
  --without-sqlite2 \
  --without-pgsql \
  --without-mysql \
  --without-odbc \
  --without-oracle \
  --without-freetds \
  --without-berkeley-db \
  --without-gdbm \
  --without-ldap \
  --without-nss
make -j"$(nproc)"
make install DESTDIR="$STAGE"

# The staged tree is the prefix's contents; ship it rooted at the version dir.
PREFIX="$VENDOR_ROOT/apache/$HTTPD_VER"
TREE="$STAGE$PREFIX"
rm -rf "$TREE/manual" "$TREE/htdocs" "$TREE/cgi-bin"
mkdir -p "$TREE/htdocs"

# Fail the build if httpd, any module, or any bundled library (APR, APR-util
# and its drivers) links a library the hosts do not get from the role's runtime
# package list (apache_runtime_packages): libc family, zlib, expat, pcre2,
# openssl, libuuid, plus the bundled APR under the tree. A failing ldd or any
# "not found" line also fails the build, allow-listed or not.
LDD_OUT="$TMP/ldd.out"
BAD=""
FILES="$TMP/elf.list"
find "$TREE/bin" "$TREE/modules" "$TREE/lib" -type f \
  \( -name httpd -o -name '*.so' -o -name '*.so.*' \) >"$FILES"
[ -s "$FILES" ] || { echo "no binaries found to check in $TREE" >&2; exit 1; }
while read -r f; do
  LD_LIBRARY_PATH="$TREE/lib" ldd "$f" >"$LDD_OUT" 2>&1 || {
    echo "ldd failed on $f" >&2
    cat "$LDD_OUT" >&2
    exit 1
  }
  if grep -q 'not found' "$LDD_OUT"; then
    echo "unresolved library in $f" >&2
    cat "$LDD_OUT" >&2
    exit 1
  fi
  while read -r lib rest; do
    case "$lib" in
      linux-vdso* | /lib*/ld-linux* | ld-linux*) continue ;;
      libc.so* | libm.so* | libdl.so* | libpthread.so* | libcrypt.so* | librt.so*) continue ;;
      libz.so* | libexpat.so* | libpcre2-8.so* | libssl.so* | libcrypto.so* | libuuid.so*) continue ;;
      *) ;;
    esac
    case "$rest" in
      *"=> $TREE/"*) continue ;;
      *) ;;
    esac
    BAD="$BAD $f:$lib"
  done <"$LDD_OUT"
done <"$FILES"
[ -z "$BAD" ] || {
  echo "unexpected shared library dependencies (add the package to apache_runtime_packages and the allow list, or disable the module):$BAD" >&2
  exit 1
}

ASSET="apache-$HTTPD_VER-$ARCH.tar.gz"
tar --sort=name --owner=0 --group=0 --numeric-owner -czf "$OUT_DIR/$ASSET" -C "$TREE" .
(cd "$OUT_DIR" && sha256sum "$ASSET" >"$ASSET.sha256")
cat "$OUT_DIR/$ASSET.sha256"
