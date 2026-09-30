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
# Allowlist (.secretscan-allowlist): one "path:full line text" entry per
# allowed line, e.g. "docs/a.md:see license.token in the state dir". A flagged
# line passes only when that exact path has an entry with that exact full line
# text (whitespace included). There is no line number, so edits elsewhere in
# the file do not break the entry; the same text anywhere in that one file is
# allowed. Lines starting with # are comments. Do not add broad wildcards.
#
# Deprecated: the old "path:lineno:full line" form is still accepted with the
# number ignored, so repos can migrate one at a time. (So a new-form entry
# whose text itself starts with "digits:" is read as the old form.)
#
# With --all, an entry that allows no flagged line is reported as stale on
# stderr. That is a warning only; it does not change the exit status.
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
    *)
      ;;
  esac
  case "$path" in
    *.pgpass|*.rabbitmq_pass)
      return 0
      ;;
    *)
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
    *)
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
    *)
      ;;
  esac
  # Mentions of secret-bearing files: allowlisted line by line.
  case "$line" in
    *license.token*|*server-key.json*|*.rabbitmq_pass*|*.pgpass*)
      return 0
      ;;
    *)
      ;;
  esac
  return 1
}

# The allowlist entries as "path:line": comments and blank lines dropped, and
# the deprecated "path:lineno:line" form rewritten without its number.
ALLOWED="$(sed -e '/^#/d' -e '/^[[:space:]]*$/d' \
  -e 's/^\([^:]*\):[0-9][0-9]*:/\1:/' "$ALLOWLIST")"

NL='
'
# Every flagged line seen, as "path:line", for the stale-entry report.
FLAGGED=""

line_is_allowlisted() {
  file=$1
  line=$2
  printf '%s\n' "$ALLOWED" | grep -Fxq -- "$file:$line"
}

# Warn (stderr only) about allowlist entries that allow no flagged line.
report_stale_entries() {
  printf '%s\n' "$ALLOWED" | while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    if ! printf '%s' "$FLAGGED" | grep -Fxq -- "$entry"; then
      echo "scan-secrets: warning: stale allowlist entry (allows no flagged line): $entry" >&2
    fi
  done
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
    *)
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
      FLAGGED="$FLAGGED$file:$line$NL"
      if line_is_allowlisted "$file" "$line"; then
        continue
      fi
      echo "scan-secrets: suspected secret in $file:$lineno" >&2
      fail=1
    fi
  done < "$file"
done

if [ "$SCAN_ALL" = 1 ]; then
  report_stale_entries
fi

exit "$fail"
