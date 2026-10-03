#!/usr/bin/env bash
# Build tp-php-launch (orchestration/scripts/tp-php-launch.c) for every
# release architecture: static, musl, stripped, with a pinned Zig toolchain,
# so the build is reproducible and the bytes match the SHA-256 pins the
# php-launch role installs against (roles/php-launch/defaults/main.yml).
#
#   bash scripts/build-tp-php-launch.sh OUT_DIR     build, then check the pins
#   bash scripts/build-tp-php-launch.sh --print     build, print the digests
#
# OUT_DIR receives tp-php-launch-amd64 and tp-php-launch-arm64. A digest that
# does not match its pin fails the build: a source change must update the pins
# in the same commit (run with --print to get them).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/orchestration/scripts/tp-php-launch.c"
PINS="$ROOT/orchestration/roles/php-launch/defaults/main.yml"

ZIG_VERSION=0.16.0
# sha256 of each host's Zig tarball (https://ziglang.org/download/index.json).
zig_pin() {
	local zig_host="$1"
	case "$zig_host" in
	x86_64-linux) echo 70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00 ;;
	aarch64-linux) echo ea4b09bfb22ec6f6c6ceac57ab63efb6b46e17ab08d21f69f3a48b38e1534f17 ;;
	aarch64-macos) echo b23d70deaa879b5c2d486ed3316f7eaa53e84acf6fc9cc747de152450d401489 ;;
	x86_64-macos) echo 0387557ed1877bc6a2e1802c8391953baddba76081876301c522f52977b52ba7 ;;
	*) return 1 ;;
	esac
}

sha256() {
	local file="$1"
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$file" | cut -d' ' -f1
	else
		shasum -a 256 "$file" | cut -d' ' -f1
	fi
}

MODE="${1:-}"
[[ -n "$MODE" ]] || { echo "usage: build-tp-php-launch.sh OUT_DIR | --print" >&2; exit 2; }

case "$(uname -s)" in Linux) os=linux ;; Darwin) os=macos ;; *) os=unknown ;; esac
case "$(uname -m)" in x86_64 | amd64) cpu=x86_64 ;; aarch64 | arm64) cpu=aarch64 ;; *) cpu=unknown ;; esac
host="$cpu-$os"
pin="$(zig_pin "$host")" || { echo "build-tp-php-launch: no pinned Zig for $host" >&2; exit 1; }

CACHE="${TP_ZIG_CACHE:-$ROOT/dist/.zig}"
ZIG_DIR="$CACHE/zig-$host-$ZIG_VERSION"
if [[ ! -x "$ZIG_DIR/zig" ]]; then
	mkdir -p "$CACHE"
	tarball="$CACHE/zig-$host-$ZIG_VERSION.tar.xz"
	curl -fsSL --proto '=https' --tlsv1.2 -o "$tarball" \
		"https://ziglang.org/download/$ZIG_VERSION/zig-$host-$ZIG_VERSION.tar.xz"
	if [[ "$(sha256 "$tarball")" != "$pin" ]]; then
		rm -f "$tarball"
		echo "build-tp-php-launch: Zig tarball digest mismatch" >&2
		exit 1
	fi
	tar -xJf "$tarball" -C "$CACHE"
	rm -f "$tarball"
fi

# Fixed paths and flags: the source is copied to a fixed relative name so no
# checkout path reaches the binary.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cp "$SRC" "$WORK/tp-php-launch.c"
export ZIG_GLOBAL_CACHE_DIR="$WORK/zig-cache" ZIG_LOCAL_CACHE_DIR="$WORK/zig-cache"
for arch in amd64 arm64; do
	case "$arch" in
	amd64) target=x86_64-linux-musl ;;
	*) target=aarch64-linux-musl ;;
	esac
	(cd "$WORK" && "$ZIG_DIR/zig" cc -target "$target" -std=c11 -O2 \
		-Wall -Wextra -Werror -Wconversion -Wshadow \
		-fstack-protector-strong -fno-ident -static -s \
		-o "tp-php-launch-$arch" tp-php-launch.c)
done

if [[ "$MODE" == "--print" ]]; then
	for arch in amd64 arm64; do echo "$arch: $(sha256 "$WORK/tp-php-launch-$arch")"; done
	exit 0
fi

mkdir -p "$MODE"
for arch in amd64 arm64; do
	want="$(sed -n "s/^  $arch: \"\([0-9a-f]\{64\}\)\"$/\1/p" "$PINS")"
	got="$(sha256 "$WORK/tp-php-launch-$arch")"
	if [[ -z "$want" || "$got" != "$want" ]]; then
		echo "build-tp-php-launch: $arch digest $got does not match the pin in $PINS" >&2
		exit 1
	fi
	install -m 0755 "$WORK/tp-php-launch-$arch" "$MODE/tp-php-launch-$arch"
done
echo "build-tp-php-launch: wrote $MODE/tp-php-launch-{amd64,arm64} (pins match)"
