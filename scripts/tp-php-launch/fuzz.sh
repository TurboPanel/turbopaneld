#!/usr/bin/env bash
# Fuzz tp-php-launch's registry parser: libFuzzer when clang has it, else the
# standalone mutator (fuzz-registry.c), both under ASan and UBSan.
#
#   bash scripts/tp-php-launch/fuzz.sh [RUNS]
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
RUNS="${1:-2000000}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FLAGS=(-g -O1 "-fsanitize=address,undefined" -fno-sanitize-recover=all -Wall -Wextra -Werror)

if clang "${FLAGS[@]}" -fsanitize=fuzzer -o "$WORK/fuzz" "$HERE/fuzz-registry.c" 2>/dev/null; then
	mkdir "$WORK/corpus"
	cp "$HERE"/corpus/* "$WORK/corpus/"
	"$WORK/fuzz" -runs="$RUNS" -max_len=8192 "$WORK/corpus"
else
	echo "fuzz.sh: no libFuzzer; using the standalone mutator" >&2
	cc "${FLAGS[@]}" -DTP_FUZZ_STANDALONE -o "$WORK/fuzz" "$HERE/fuzz-registry.c"
	"$WORK/fuzz" "$RUNS" "$HERE"/corpus/*
fi
