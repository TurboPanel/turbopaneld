#!/usr/bin/env sh
# Scan tracked/staged files for secret-like content. Allowlist exact fixture lines only.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ALLOWLIST="$ROOT/.secretscan-allowlist"
if [ ! -f "$ALLOWLIST" ]; then
  echo "scan-secrets: missing $ALLOWLIST" >&2
  exit 1
fi

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  FILES="$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null || true)"
  if [ -z "$FILES" ]; then
    FILES="$(git diff --name-only --diff-filter=ACM 2>/dev/null || true)"
  fi
else
  echo "scan-secrets: not a git repository" >&2
  exit 1
fi

if [ -z "$FILES" ]; then
  exit 0
fi

fail=0
for file in $FILES; do
  [ -f "$file" ] || continue
  case "$file" in
    *.png|*.jpg|*.jpeg|*.gif|*.webp|*.ico|*.woff|*.woff2|*.ttf|*.otf|*.zip|*.tar|*.zst|*.gz)
      continue
      ;;
  esac
  lineno=0
  while IFS= read -r line || [ -n "$line" ]; do
    lineno=$((lineno + 1))
    case "$line" in
      *amqp://*:*@*|*postgresql://*:*@*|*TURBOPANEL_SECRET=*|*license.token*|*server-key.json*|*.rabbitmq_pass*|*.pgpass*)
        if grep -Fxq "$file:$lineno:$line" "$ALLOWLIST" 2>/dev/null; then
          continue
        fi
        echo "scan-secrets: suspected secret in $file:$lineno" >&2
        fail=1
        ;;
    esac
  done < "$file"
done

exit "$fail"
