#!/usr/bin/env sh
# Scan for secret-like content and secret-bearing paths.
#
#   scan-secrets.sh          staged files (else modified files); the pre-commit run
#   scan-secrets.sh --all    every tracked file; what CI runs on the tree
#   scan-secrets.sh --range A..B
#                            every line ADDED by any non-merge commit in A..B,
#                            and every file those commits added or changed, so a
#                            secret that a PR commits and removes again is still
#                            caught. CI runs this on pull requests.
#
# scan-secrets.sh, scan-secrets.patterns and scan-secrets.selftest.sh are
# byte-identical in turbopanel, turbopaneld, ui, website and dev. Change all
# five together; dev's test checks the copies and runs the self-test.
#
# The rules live in scripts/scan-secrets.patterns (private key blocks, vendor
# tokens, connection URLs, secret-looking assignments, forbidden file names).
# The scanner reports the rule id and the location, never the matching text, so
# a CI log does not become a second copy of the secret.
#
# Allowlist (.secretscan-allowlist): one "path:full line text" entry per
# allowed line, e.g. "docs/a.md:see license.token in the state dir". A flagged
# line passes only when that exact path has an entry with that exact full line
# text (whitespace included), whichever rule flagged it. There is no line
# number, so edits elsewhere in the file do not break the entry. A forbidden
# file name is allowed only by an "@path exact/path/to/file" entry.
#
# Every entry needs a reason: a "# reason: ..." comment above it, which covers
# the entries below it up to the next blank line or "# reason:" comment. An
# entry without a reason, a path with a wildcard, or an entry shorter than 8
# characters fails the scan: no broad allowlists. Other # lines are comments.
#
# Deprecated: the old "path:lineno:full line" form is still accepted with the
# number ignored. (So a new-form entry whose text itself starts with "digits:"
# is read as the old form.)
#
# With --all, an entry that allows nothing is reported as stale on stderr. That
# is a warning only; it does not change the exit status.
set -eu

MODE=staged
RANGE=
case "${1:-}" in
  --all) MODE=all ;;
  --range)
    MODE=range
    RANGE="${2:-}"
    if [ -z "$RANGE" ]; then
      echo "scan-secrets: --range needs a revision range such as BASE..HEAD" >&2
      exit 1
    fi
    ;;
  "") ;;
  *)
    echo "usage: scan-secrets.sh [--all | --range BASE..HEAD]" >&2
    exit 1
    ;;
esac

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ALLOWLIST="$ROOT/.secretscan-allowlist"
PATTERNS="$ROOT/scripts/scan-secrets.patterns"
for required in "$ALLOWLIST" "$PATTERNS"; do
  if [ ! -f "$required" ]; then
    echo "scan-secrets: missing $required" >&2
    exit 1
  fi
done

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "scan-secrets: not a git repository" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM
LINE_RE="$TMP/line.re"
PATH_RE="$TMP/path.re"
PATH_RULES="$TMP/path.rules"
PATHOK_RE="$TMP/pathok.re"
RULES="$TMP/line.rules"
ALLOWED="$TMP/allowed"
FLAGGED="$TMP/flagged"
: > "$LINE_RE"
: > "$PATH_RE"
: > "$PATH_RULES"
: > "$PATHOK_RE"
: > "$RULES"
: > "$ALLOWED"
: > "$FLAGGED"
fail=0

# --- rules -------------------------------------------------------------------
while IFS= read -r rule || [ -n "$rule" ]; do
  case "$rule" in
    "#"*|"") continue ;;
  esac
  kind=${rule%% *}
  rest=${rule#* }
  id=${rest%% *}
  re=${rest#* }
  if [ -z "$id" ] || [ -z "$re" ] || [ "$rest" = "$rule" ] || [ "$re" = "$rest" ]; then
    echo "scan-secrets: malformed rule in scan-secrets.patterns: $id" >&2
    exit 1
  fi
  case "$kind" in
    line)
      printf '%s\n' "$re" >> "$LINE_RE"
      printf '%s %s\n' "$id" "$re" >> "$RULES"
      ;;
    path)
      printf '%s\n' "$re" >> "$PATH_RE"
      printf '%s %s\n' "$id" "$re" >> "$PATH_RULES"
      ;;
    pathok) printf '%s\n' "$re" >> "$PATHOK_RE" ;;
    *)
      echo "scan-secrets: unknown rule kind '$kind' in scan-secrets.patterns" >&2
      exit 1
      ;;
  esac
done < "$PATTERNS"

# --- allowlist ---------------------------------------------------------------
# $ALLOWED holds "path:line" and "@path file" entries, the deprecated
# "path:lineno:line" form already rewritten without its number.
reason=
while IFS= read -r entry || [ -n "$entry" ]; do
  case "$entry" in
    "# reason:"*)
      reason=${entry#"# reason:"}
      case "$reason" in
        *[![:space:]]*) ;;
        *) reason= ;;
      esac
      continue
      ;;
    "#"*) continue ;;
  esac
  case "$entry" in
    *[![:space:]]*) ;;
    *)
      reason=
      continue
      ;;
  esac
  if [ -z "$reason" ]; then
    echo "scan-secrets: allowlist entry has no '# reason:' comment above it: ${entry%%:*}" >&2
    fail=1
    continue
  fi
  if [ "${#entry}" -lt 8 ]; then
    echo "scan-secrets: allowlist entry too short to be exact: $entry" >&2
    fail=1
    continue
  fi
  case "$entry" in
    "@path "*) apath=${entry#"@path "} ;;
    *) apath=${entry%%:*} ;;
  esac
  case "$apath" in
    ""|*[\*\?\[]*|*..*|/*)
      echo "scan-secrets: allowlist path must be one exact repo-relative path, no wildcards: $apath" >&2
      fail=1
      continue
      ;;
  esac
  printf '%s\n' "$entry" | sed -e 's/^\([^:@][^:]*\):[0-9][0-9]*:/\1:/' >> "$ALLOWED"
done < "$ALLOWLIST"

entry_allowed() {
  grep -Fxq -- "$1" "$ALLOWED"
}

# --- helpers -----------------------------------------------------------------
skip_file() {
  case "$1" in
    .secretscan-allowlist|scripts/scan-secrets.sh|scripts/scan-secrets.patterns)
      # The allowlist echoes the exact flagged lines and the patterns file
      # holds the regexes themselves; neither is scanned.
      return 0
      ;;
    *.png|*.jpg|*.jpeg|*.gif|*.webp|*.ico|*.woff|*.woff2|*.ttf|*.otf|*.zip|*.tar|*.zst|*.gz|*.pdf)
      return 0
      ;;
    *) return 1 ;;
  esac
}

# The rule id for a path that must never be committed; returns 1 otherwise.
forbidden_path() {
  if [ -s "$PATHOK_RE" ] && printf '%s\n' "$1" | grep -Eq -f "$PATHOK_RE"; then
    return 1
  fi
  while IFS= read -r prule || [ -n "$prule" ]; do
    [ -n "$prule" ] || continue
    if printf '%s\n' "$1" | grep -Eq -e "${prule#* }"; then
      printf '%s\n' "${prule%% *}"
      return 0
    fi
  done < "$PATH_RULES"
  return 1
}

# File names on stdin: report each that must never be committed. One grep
# narrows the list, so only the few candidates pay for the per-rule lookup.
check_paths() {
  grep -E -f "$PATH_RE" > "$TMP/path-hits" || true
  while IFS= read -r file || [ -n "$file" ]; do
    [ -n "$file" ] || continue
    pid="$(forbidden_path "$file")" || continue
    printf '@path %s\n' "$file" >> "$FLAGGED"
    if entry_allowed "@path $file"; then
      continue
    fi
    echo "scan-secrets: secret-bearing path must not be committed ($pid): $file" >&2
    fail=1
  done < "$TMP/path-hits"
}

# The generic assignment rules only count a value that looks random: 24+
# characters, a letter and a digit, no placeholder word.
looks_random() {
  value="$(printf '%s\n' "$1" | grep -Eo '[A-Za-z0-9+/=_-]{24,}' | tail -n 1)"
  [ -n "$value" ] || return 1
  printf '%s\n' "$value" | grep -Eq '[0-9]' || return 1
  printf '%s\n' "$value" | grep -Eq '[A-Za-z]' || return 1
  if printf '%s\n' "$value" | grep -Eiq 'example|changeme|change-me|placeholder|your[-_]|dummy|fake|sample|redacted|xxxxx|test|0000|1234'; then
    return 1
  fi
  return 0
}

# True when the line CTX_N of CTX_FILE looks like the body of a private key.
CTX_FILE=
CTX_N=0
next_is_key_body() {
  nxt="$(sed -n "${CTX_N}p" "$CTX_FILE" | tr -d '\r')"
  printf '%s\n' "$nxt" | grep -Eq '^[^A-Za-z0-9+/]*([A-Za-z0-9+/]{40,}={0,2}|Proc-Type:.*)[^A-Za-z0-9+/=]*$'
}

# The first rule id that flags this line; returns 1 when none does.
line_rule() {
  while IFS= read -r lrule || [ -n "$lrule" ]; do
    lid=${lrule%% *}
    lre=${lrule#* }
    if printf '%s\n' "$1" | grep -Eq -e "$lre"; then
      case "$lid" in
        generic-*) looks_random "$1" || continue ;;
        pem-header-line) next_is_key_body || continue ;;
        *) ;;
      esac
      printf '%s\n' "$lid"
      return 0
    fi
  done < "$RULES"
  return 1
}

# Handle one candidate line: $1 path, $2 where to report it, $3 the line text.
check_line() {
  id="$(line_rule "$3")" || return 0
  printf '%s:%s\n' "$1" "$3" >> "$FLAGGED"
  if entry_allowed "$1:$3"; then
    return 0
  fi
  echo "scan-secrets: suspected secret in $2 ($id)" >&2
  fail=1
}

# --- working tree and staged files: file names on stdin -----------------------
scan_files() {
  : > "$TMP/eligible"
  while IFS= read -r file || [ -n "$file" ]; do
    [ -f "$file" ] || continue
    skip_file "$file" && continue
    printf '%s\n' "$file" >> "$TMP/eligible"
  done
  check_paths < "$TMP/eligible"
  tr '\n' '\000' < "$TMP/eligible" |
    xargs -0 grep -nIHE -f "$LINE_RE" -- 2>/dev/null > "$TMP/hits" || true
  while IFS= read -r hit || [ -n "$hit" ]; do
    file=${hit%%:*}
    rest=${hit#*:}
    lineno=${rest%%:*}
    case "$lineno" in
      ''|*[!0-9]*)
        echo "scan-secrets: suspected secret in a file whose name holds a colon: $file" >&2
        fail=1
        continue
        ;;
    esac
    CTX_FILE=$file
    CTX_N=$((lineno + 1))
    check_line "$file" "$file:$lineno" "${rest#*:}"
  done < "$TMP/hits"
}

# --- commit range -------------------------------------------------------------
scan_range() {
  if ! git rev-list "$RANGE" >/dev/null 2>&1; then
    echo "scan-secrets: cannot resolve $RANGE (shallow checkout? fetch full history)" >&2
    exit 1
  fi
  git log --no-merges --name-only --diff-filter=ACMR --format= "$RANGE" | sort -u > "$TMP/range-files"
  : > "$TMP/range-eligible"
  while IFS= read -r file || [ -n "$file" ]; do
    [ -n "$file" ] || continue
    skip_file "$file" && continue
    printf '%s\n' "$file" >> "$TMP/range-eligible"
  done < "$TMP/range-files"
  check_paths < "$TMP/range-eligible"

  # added.lines and added.meta stay in step: line N of one is an added line
  # and line N of the other is "sha path" for it.
  git log --no-merges -p -U0 --no-color --no-ext-diff --format='@@commit %H' "$RANGE" |
    awk -v lines="$TMP/added.lines" -v meta="$TMP/added.meta" '
      /^@@commit / { sha = substr($2, 1, 12); inhdr = 0; next }
      /^diff --git / { inhdr = 1; next }
      inhdr && /^\+\+\+ / { path = substr($0, 5); sub(/^b\//, "", path); next }
      inhdr && /^@@ / { inhdr = 0; next }
      !inhdr && /^\+/ { print substr($0, 2) > lines; print sha " " path > meta }
    '
  [ -f "$TMP/added.lines" ] || return 0
  grep -naE -f "$LINE_RE" "$TMP/added.lines" > "$TMP/hits" 2>/dev/null || true
  while IFS= read -r hit || [ -n "$hit" ]; do
    n=${hit%%:*}
    meta="$(sed -n "${n}p" "$TMP/added.meta")"
    sha=${meta%% *}
    file=${meta#* }
    skip_file "$file" && continue
    CTX_FILE="$TMP/added.lines"
    CTX_N=$((n + 1))
    check_line "$file" "$file in commit $sha" "${hit#*:}"
  done < "$TMP/hits"
}

# --- run ----------------------------------------------------------------------
case "$MODE" in
  all)
    git ls-files > "$TMP/files"
    scan_files < "$TMP/files"
    ;;
  range) scan_range ;;
  *)
    git diff --cached --name-only --diff-filter=ACM > "$TMP/files" 2>/dev/null || true
    if [ ! -s "$TMP/files" ]; then
      git diff --name-only --diff-filter=ACM > "$TMP/files" 2>/dev/null || true
    fi
    scan_files < "$TMP/files"
    ;;
esac

if [ "$MODE" = all ]; then
  while IFS= read -r entry || [ -n "$entry" ]; do
    [ -n "$entry" ] || continue
    if ! grep -Fxq -- "$entry" "$FLAGGED"; then
      echo "scan-secrets: warning: stale allowlist entry (allows nothing): $entry" >&2
    fi
  done < "$ALLOWED"
fi

exit "$fail"
