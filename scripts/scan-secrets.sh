#!/usr/bin/env sh
# Scan staged/changed files for secret-like content and secret-bearing paths.
# Pre-commit scans the staged (else modified) files; `--all` scans every
# tracked file, which is what CI runs.
#
# This file is byte-identical in turbopanel, turbopaneld, ui, website and dev.
# Change all five together; each repo's test checks the copy against the rules.
#
# Three checks, the union of what every copy used to do:
#   1. A secret-bearing file (license.token, server-key.json, .pgpass, …)
#      must never be committed, whatever it contains.
#   2. Credential material on a line: a connection URL with user:password@,
#      or an assignment / JSON binding of TURBOPANEL_SECRET(S).
#   3. A line that names a secret-bearing file (license.token,
#      server-key.json, .pgpass, .rabbitmq_pass). Most are docs or code that
#      only mention the path; each such line is allowlisted exactly, so a new
#      mention gets a second look before it lands.
#
# Allowlist: exact "path:lineno:full line" fixture lines only (see
# .secretscan-allowlist). Do not add broad wildcards.
set -eu

SCAN_ALL=0
if [ "${1:-}" = "--all" ]; then
  SCAN_ALL=1
fi

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ALLOWLIST="$ROOT/.secretscan-allowlist"
if [ ! -f "$ALLOWLIST" ]; then
  echo "scan-secrets: missing $ALLOWLIST" >&2
  exit 1
fi

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if [ "$SCAN_ALL" = 1 ]; then
    FILES="$(git ls-files)"
  else
    FILES="$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null || true)"
  fi
  if [ -z "$FILES" ] && [ "$SCAN_ALL" = 0 ]; then
    FILES="$(git diff --name-only --diff-filter=ACM 2>/dev/null || true)"
  fi
else
  echo "scan-secrets: not a git repository" >&2
  exit 1
fi

if [ -z "$FILES" ]; then
  exit 0
fi

# True when the path basename is a known secret-on-disk artifact that must never
# be committed (co-located daemon identity / local DB password files).
is_secret_bearing_path() {
  path=$1
  base=${path##*/}
  case "$base" in
    license.token|license.id|server-key.json|server-key-id|server.id|.pgpass|.rabbitmq_pass)
      return 0
      ;;
  esac
  case "$path" in
    *.pgpass|*.rabbitmq_pass)
      return 0
      ;;
  esac
  return 1
}

# True when the line carries credential material or names a secret-bearing file.
line_looks_like_secret() {
  line=$1
  case "$line" in
    # Connection URLs with embedded user:password@
    *amqp://*:*@*|*amqps://*:*@*|*postgresql://*:*@*|*postgres://*:*@*)
      return 0
      ;;
  esac
  # Env / YAML / JSON binding of the root secret (not bare mentions).
  # Deliberately requires `=` or `:` right after the name so prose like
  # "TURBOPANEL_SECRET is required" is clean.
  case "$line" in
    *TURBOPANEL_SECRET=*|*TURBOPANEL_SECRETS=*|*TURBOPANEL_SECRET:*|*TURBOPANEL_SECRETS:*)
      return 0
      ;;
    *'"TURBOPANEL_SECRET":'*|*'"TURBOPANEL_SECRETS":'*)
      return 0
      ;;
  esac
  # Mentions of secret-bearing files: allowlisted line by line.
  case "$line" in
    *license.token*|*server-key.json*|*.rabbitmq_pass*|*.pgpass*)
      return 0
      ;;
  esac
  return 1
}

line_is_allowlisted() {
  file=$1
  lineno=$2
  line=$3
  grep -Fxq -- "$file:$lineno:$line" "$ALLOWLIST" 2>/dev/null
}

fail=0
for file in $FILES; do
  [ -f "$file" ] || continue
  case "$file" in
    .secretscan-allowlist|scripts/scan-secrets.sh)
      # The allowlist echoes the exact fixture lines and this script names the
      # patterns; skip both.
      continue
      ;;
    *.png|*.jpg|*.jpeg|*.gif|*.webp|*.ico|*.woff|*.woff2|*.ttf|*.otf|*.zip|*.tar|*.zst|*.gz)
      continue
      ;;
  esac

  if is_secret_bearing_path "$file"; then
    echo "scan-secrets: secret-bearing path must not be committed: $file" >&2
    fail=1
    continue
  fi

  lineno=0
  while IFS= read -r line || [ -n "$line" ]; do
    lineno=$((lineno + 1))
    if line_looks_like_secret "$line"; then
      if line_is_allowlisted "$file" "$lineno" "$line"; then
        continue
      fi
      echo "scan-secrets: suspected secret in $file:$lineno" >&2
      fail=1
    fi
  done < "$file"
done

exit "$fail"
