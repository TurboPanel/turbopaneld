#!/usr/bin/env bash
# Write a Clang compilation database for the tp-php-launch C sources, for
# SonarCloud's C analysis (sonar.cfamily.compile-commands).
#
#   bash scripts/tp-php-launch/compile-commands.sh OUT_FILE
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:?usage: compile-commands.sh OUT_FILE}"
mkdir -p "$(dirname "$OUT")"
entry() { # FILE EXTRA-FLAG
	printf '  {"directory": "%s", "file": "%s", "arguments": ["cc", "-std=c11", "-O2", "-Wall", "-Wextra"%s, "-c", "%s", "-o", "/dev/null"]}' \
		"$ROOT" "$ROOT/$1" "${2:+, \"$2\"}" "$ROOT/$1"
}
{
	echo "["
	entry orchestration/scripts/tp-php-launch.c
	echo ","
	entry scripts/tp-php-launch/sockwrap.c
	echo ","
	entry scripts/tp-php-launch/fake-lsphp.c
	echo ","
	entry scripts/tp-php-launch/fuzz-registry.c -DTP_FUZZ_STANDALONE
	echo
	echo "]"
} > "$OUT"
