#!/usr/bin/env sh
# Self-test for scripts/scan-secrets.sh and scripts/scan-secrets.patterns.
#
# Proves that every rule in the patterns file fires on a matching fixture, that
# ordinary code stays clean, that the allowlist rules hold, and that the commit
# range scan catches a secret a PR adds and removes again. Fixtures are built
# at run time from fragments, so this file holds nothing a scanner (this one,
# GitGuardian, GitHub push protection) would flag. Keep it that way: never
# write a fixture here as one contiguous literal.
#
# Byte-identical in turbopanel, turbopaneld, ui, website and dev.
set -eu

HERE="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
SCANNER="$HERE/scan-secrets.sh"
PATTERNS="$HERE/scan-secrets.patterns"

# The throwaway repos must not pick up the caller's git config (signing, hooks).
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

W="$(mktemp -d)"
trap 'rm -rf "$W"' EXIT INT TERM
R="$W/repo"
COVERED="$W/covered"
: > "$COVERED"
checks=0
failures=0

bad() {
  echo "selftest FAIL: $1" >&2
  failures=$((failures + 1))
}

new_repo() {
  rm -rf "$R"
  mkdir -p "$R/scripts" "$R/src"
  cp "$SCANNER" "$PATTERNS" "$R/scripts/"
  printf '# no entries\n' > "$R/.secretscan-allowlist"
  git -C "$R" init -q
  git -C "$R" config user.name selftest
  git -C "$R" config user.email selftest@example.invalid
  git -C "$R" config commit.gpgsign false
}

# Run the scanner in $R; sets $code and writes stderr to $W/err.
scan() {
  git -C "$R" add -A
  code=0
  (cd "$R" && sh scripts/scan-secrets.sh "$@") > /dev/null 2> "$W/err" || code=$?
}

# --- fixture pieces (fragments; joined only at run time) ----------------------
# A 40 character base64-looking body with letters and digits.
BODY40="$(printf '%s%s' aB3dE5gH7jK9mN1pQ3sT5vW7yZ0bC2dE 4fG6hI8j)"
BODY24="$(printf '%s%s' aB3dE5gH7jK9m N1pQ3sT5vW7)"
HEX40="$(printf '%s%s' 0123456789abcdef0123 456789abcdef01234567)"
SEP='://'

# expect_flag RULE CONTENT: a file holding CONTENT must be flagged by RULE, and
# the report must name the rule without echoing the matching text.
expect_flag() {
  rule=$1
  content=$2
  checks=$((checks + 1))
  new_repo
  printf 'const ok = 1;\n%s\n' "$content" > "$R/src/f.txt"
  scan --all
  [ "$code" = 1 ] || bad "$rule: expected exit 1, got $code"
  grep -q "src/f.txt:2 ($rule)" "$W/err" || bad "$rule: not reported as $rule at src/f.txt:2"
  if grep -qF -- "$BODY40" "$W/err" || grep -qF -- "$BODY24" "$W/err" || grep -qF -- "$HEX40" "$W/err"; then
    bad "$rule: the report echoed fixture text"
  fi
  printf '%s\n' "$rule" >> "$COVERED"
}

expect_clean() {
  label=$1
  content=$2
  checks=$((checks + 1))
  new_repo
  printf '%s\n' "$content" > "$R/src/f.txt"
  scan --all
  [ "$code" = 0 ] || bad "clean case '$label' was flagged: $(cat "$W/err")"
}

# expect_path_flag RULE PATH: a file named PATH must be refused.
expect_path_flag() {
  rule=$1
  path=$2
  checks=$((checks + 1))
  new_repo
  mkdir -p "$R/$(dirname "$path")"
  printf 'nothing secret in here\n' > "$R/$path"
  scan --all
  [ "$code" = 1 ] || bad "path $path: expected exit 1, got $code"
  grep -q "($rule): $path" "$W/err" || bad "path $path: not reported as $rule"
  printf '%s\n' "$rule" >> "$COVERED"
}

expect_path_clean() {
  path=$1
  checks=$((checks + 1))
  new_repo
  mkdir -p "$R/$(dirname "$path")"
  printf 'nothing secret in here\n' > "$R/$path"
  scan --all
  [ "$code" = 0 ] || bad "path $path was refused: $(cat "$W/err")"
}

# --- content rules ------------------------------------------------------------
PEM_HEAD="$(printf '%s%s' '-----BEGIN ' 'PRIVATE KEY-----')"
SSH_HEAD="$(printf '%s%s' '-----BEGIN OPENSSH ' 'PRIVATE KEY-----')"
expect_flag pem-private-key-inline "$(printf '%s%s' "$PEM_HEAD" "$BODY40")"
expect_flag pem-private-key-inline "$(printf '{"k":"%s\\n%s"}' "$SSH_HEAD" "$BODY40")"
expect_flag pem-header-line "$(printf '%s\n%s' "$PEM_HEAD" "$BODY40")"
expect_flag pem-header-line "$(printf '%s\n%s' "$SSH_HEAD" "$BODY40")"
expect_flag jwk-private-d "$(printf '{"kty":"OKP","crv":"Ed25519","d":"%s"}' "$BODY40")"
expect_flag jwk-private-binding "$(printf 'private%s = "%s"' Jwk '{}')"
expect_flag stripe-key "$(printf '%s%s%s' sk_ live_ "$BODY24")"
expect_flag stripe-key "$(printf '%s%s%s' sk_ test_ "$BODY24")"
expect_flag stripe-key "$(printf '%s%s%s' rk_ live_ "$BODY24")"
expect_flag stripe-webhook-secret "$(printf '%s%s' whsec_ "$BODY24")"
expect_flag github-token "$(printf '%s%s' ghp_ "$BODY40")"
expect_flag github-token "$(printf '%s%s' gho_ "$BODY40")"
expect_flag github-token "$(printf '%s%s' ghs_ "$BODY40")"
expect_flag github-fine-grained-pat "$(printf '%s%s' github_pat_ "$BODY40")"
expect_flag aws-access-key-id "$(printf '%s%s' AKIA IOSFODNN7EXAMPLE)"
expect_flag aws-access-key-id "$(printf '%s%s' ASIA IOSFODNN7EXAMPLE)"
expect_flag slack-token "$(printf '%s%s' xoxb- 1234567890-abcdefghij)"
expect_flag slack-webhook "$(printf '%s%s' 'https://hooks.slack.com/services/T0123ABC/B0123ABC/' "$BODY24")"
expect_flag cloudflare-api-token "$(printf '%s%s' CLOUDFLARE_API_TOKEN= "$BODY40")"
expect_flag bearer-token-40 "$(printf '%s%s' 'Authorization: Bearer ' "$BODY40")"
expect_flag sonar-token "$(printf '%s%s' sqp_ "$HEX40")"
expect_flag ci-token-assignment "$(printf '%s%s' SONAR_TOKEN= "$HEX40")"
expect_flag jwt "$(printf '%s.%s.%s' eyJhbGciOiJIUzI1NiJ9 eyJzdWIiOiIxMjM0NTY3ODkwIn0 abcdefghijklmnopqrst)"
expect_flag db-url-credentials "$(printf 'postgres%suser:pw@db:5432/app' "$SEP")"
expect_flag db-url-credentials "$(printf 'amqps%suser:pw@mq/' "$SEP")"
expect_flag url-credentials "$(printf 'mysql%suser:hunter2@db/app' "$SEP")"
expect_flag url-credentials "$(printf 'mongodb%suser:hunter2@db/app' "$SEP")"
expect_flag redis-url-credentials "$(printf 'redis%s:hunter2@cache:6379' "$SEP")"
expect_flag turbopanel-secret "$(printf '%s%s' TURBOPANEL_ SECRETS=abc)"
expect_flag turbopanel-secret "$(printf '"%s%s": "abc"' TURBOPANEL_ SECRET)"
expect_flag secret-file-mention "$(printf 'cat state/%s%s' license. token)"
expect_flag secret-file-mention "$(printf 'read %s%s' server-key. json)"
expect_flag secret-file-mention "$(printf '%s%s' '~/.' pgpass)"
expect_flag generic-secret-assignment "$(printf 'API_KEY = "%s"' "$BODY40")"
expect_flag generic-secret-assignment "$(printf "password: '%s'" "$BODY24")"
expect_flag generic-secret-assignment "$(printf 'const clientSecret = "%s";' "$BODY24")"
expect_flag generic-secret-env "$(printf 'DB_PASSWORD=%s' "$BODY40")"
expect_flag generic-secret-unquoted "$(printf 'password: %s' "$BODY24")"
expect_flag generic-secret-unquoted "$(printf 'api_key=%s # from the vault' "$BODY40")"
expect_flag generic-secret-unquoted "$(printf '  clientSecret: %s' "$BODY40")"
# A trailing comment word with no digit must not hide the value.
expect_flag generic-secret-assignment "$(printf 'token = "%s" # see_loaded_from_vault_secret_name' "$BODY24")"
expect_flag generic-secret-unquoted "$(printf 'token: %s # see_loaded_from_vault_secret_name' "$BODY24")"
expect_flag google-api-key "$(printf '%s%s' AIza "$BODY40" | cut -c1-39)"
expect_flag npm-token "$(printf '%s%s' npm_ "$BODY40" | cut -c1-40)"
expect_flag anthropic-openai-key "$(printf '%s%s' sk-ant- "$BODY24")"
expect_flag anthropic-openai-key "$(printf '%s%s' sk-proj- "$BODY24")"
expect_flag generic-aws-secret-key "$(printf 'aws_secret_access_key = %s' "$BODY40")"
expect_flag generic-aws-secret-key "$(printf 'AWS_SECRET_KEY: "%s"' "$BODY40")"

# --- ordinary code and prose stay clean ---------------------------------------
expect_clean "plain code" 'export function add(a: number, b: number) { return a + b; }'
expect_clean "prose about the root secret" 'TURBOPANEL_SECRET is required before the daemon starts.'
expect_clean "pem header named in code" "const HEADER = \"$PEM_HEAD\";"
expect_clean "pem header with a stub body" "$(printf '%s\nstub' "$PEM_HEAD")"
expect_clean "placeholder password" 'password: "changeme-changeme-changeme-1"'
expect_clean "identifier without digits" 'const tokenRefreshIntervalDescription = "refresh-the-token-every-so-often";'
expect_clean "numeric setting" 'const TOKEN_TTL_SECONDS = 3600;'
expect_clean "reference, not a value" 'api_key = os.environ["API_KEY"]'
expect_clean "templated password" "$(printf 'dsn: mysql%suser:${PASSWORD}@db/app' "$SEP")"
expect_clean "short sk_ prefix in prose" 'keys start with sk_live_ or sk_test_ and are secret'
expect_clean "unquoted placeholder" "$(printf '%s: changeme-changeme-changeme-1' pass"word")"
expect_clean "unquoted reference" 'token: ${TOKEN_FROM_THE_VAULT_ENTRY_NUMBER_1}'
expect_clean "unquoted words without a digit" 'secret_name: tenant-database-credential-reference-prod'
expect_clean "short unquoted value" "$(printf '%s: hunter2' pass"word")"
expect_clean "aws example key" "$(printf 'aws_secret_%s = %s%s%s' access_key wJalrXUtnFEMI/ K7MDENG/bPxRfiCY EXAMPLEKEY)"
expect_clean "jwt prefix alone" 'tokens look like eyJhbGciOi and so on'

# --- forbidden file names ------------------------------------------------------
expect_path_flag env-file .env
expect_path_flag env-file .env.local
expect_path_flag env-file apps/api/.env.production
expect_path_flag env-dash-file .env-backup
expect_path_flag dev-vars-file .dev.vars
expect_path_flag pem-file certs/server.pem
expect_path_flag key-file tls/site.key
expect_path_flag private-key-file id_rsa
expect_path_flag private-key-file home/.ssh/id_ed25519
expect_path_flag pkcs-keystore store.p12
expect_path_flag pkcs-keystore store.jks
expect_path_flag credentials-json gcp/credentials-prod.json
expect_path_flag daemon-identity-file "state/$(printf '%s%s' license. token)"
expect_path_flag daemon-identity-file "$(printf '%s%s' server-key. json)"
expect_path_flag password-file "db/.$(printf '%s%s' pg pass)"
expect_path_flag password-file ".$(printf '%s%s' rabbitmq_ pass)"
expect_path_clean .env.example
expect_path_clean .dev.vars.example
expect_path_clean docs/pem-notes.md
expect_path_clean src/monkey.ts
expect_path_clean src/environment.ts

# --- every rule in the patterns file has a fixture above -----------------------
checks=$((checks + 1))
while IFS= read -r rule || [ -n "$rule" ]; do
  case "$rule" in
    line\ *|path\ *)
      id=${rule#* }
      id=${id%% *}
      grep -Fxq -- "$id" "$COVERED" || bad "rule $id has no fixture in the self-test"
      ;;
    *) ;;
  esac
done < "$PATTERNS"

# --- allowlist ------------------------------------------------------------------
LINE="$(printf 'cat state/%s%s' license. token)"
allow_case() {
  label=$1
  allowlist=$2
  want=$3
  checks=$((checks + 1))
  new_repo
  printf 'ok\n%s\n' "$LINE" > "$R/src/f.txt"
  printf '%s\n' "$allowlist" > "$R/.secretscan-allowlist"
  scan --all
  [ "$code" = "$want" ] || bad "allowlist case '$label': expected exit $want, got $code: $(cat "$W/err")"
}

allow_case "exact entry with a reason" "# reason: docs mention the path only
src/f.txt:$LINE" 0
allow_case "entry without a reason" "src/f.txt:$LINE" 1
allow_case "reason ends at a blank line" "# reason: docs mention the path only

src/f.txt:$LINE" 1
allow_case "empty reason" "# reason:
src/f.txt:$LINE" 1
allow_case "line text changed" "# reason: docs
src/f.txt:$LINE (edited)" 1
allow_case "other path" "# reason: docs
src/g.txt:$LINE" 1
allow_case "wildcard path" "# reason: docs
src/*.txt:$LINE" 1
allow_case "path traversal" "# reason: docs
../src/f.txt:$LINE" 1
allow_case "deprecated line number form" "# reason: docs
src/f.txt:2:$LINE" 0

checks=$((checks + 1))
new_repo
printf 'ok\ncat state/still-here-text\n' > "$R/src/f.txt"
printf '# reason: gone\nsrc/f.txt:cat state/still-here-text\n' > "$R/.secretscan-allowlist"
scan --all
[ "$code" = 0 ] || bad "stale entry must not fail the scan"
grep -q 'stale allowlist entry' "$W/err" || bad "stale entry was not reported"

checks=$((checks + 1))
new_repo
mkdir -p "$R/certs"
printf 'public certificate chain\n' > "$R/certs/ca.pem"
printf '# reason: public CA bundle, no key\n@path certs/ca.pem\n' > "$R/.secretscan-allowlist"
scan --all
[ "$code" = 0 ] || bad "an exact @path entry must allow the file: $(cat "$W/err")"
printf '# reason: public CA bundle, no key\n@path certs/*.pem\n' > "$R/.secretscan-allowlist"
scan --all
[ "$code" = 1 ] || bad "a wildcard @path entry must be rejected"

# --- archives are opened ----------------------------------------------------------
TOK="$(printf '%s%s' ghp_ "$BODY40")"
archive_case() {
  label=$1
  want=$2
  checks=$((checks + 1))
  new_repo
  printf 'ok\n' > "$R/src/a.txt"
  shift 2
  "$@"
  scan --all
  [ "$code" = "$want" ] || bad "archive case '$label': expected exit $want, got $code: $(cat "$W/err")"
}
archive_body() { printf 'line\n%s\n' "$TOK"; }
make_gz() { archive_body | gzip -c > "$R/src/f.gz"; }
make_tar() {
  archive_body > "$R/src/inner.txt"
  tar -C "$R/src" -cf "$R/src/f.tar" inner.txt
  rm "$R/src/inner.txt"
}
make_tgz() {
  archive_body > "$R/src/inner.txt"
  tar -C "$R/src" -czf "$R/src/f.tgz" inner.txt
  rm "$R/src/inner.txt"
}
make_clean_gz() { printf 'nothing here\n' | gzip -c > "$R/src/f.gz"; }
make_bad_gz() { printf 'not gzip data\n' > "$R/src/f.gz"; }
archive_case "token inside a .gz" 1 make_gz
archive_case "token inside a .tar" 1 make_tar
archive_case "token inside a .tgz" 1 make_tgz
archive_case "clean .gz" 0 make_clean_gz
archive_case "corrupt .gz fails closed" 1 make_bad_gz
if command -v zip > /dev/null 2>&1 && command -v unzip > /dev/null 2>&1; then
  make_zip() {
    archive_body > "$W/inner.txt"
    (cd "$W" && zip -q "$R/src/f.zip" inner.txt)
  }
  archive_case "token inside a .zip" 1 make_zip
fi
checks=$((checks + 1))
new_repo
make_gz
scan --all
grep -q 'src/f.gz (inside the archive, line 2) (github-token)' "$W/err" || bad "archive report lacks file, line and rule"
if grep -qF -- "$BODY40" "$W/err"; then bad "archive report echoed fixture text"; fi
printf '# reason: archived sample\nsrc/f.gz:%s\n' "$TOK" > "$R/.secretscan-allowlist"
scan --all
[ "$code" = 0 ] || bad "an exact allowlist entry must allow a line inside an archive: $(cat "$W/err")"

# --- the allowlist itself is checked ---------------------------------------------
checks=$((checks + 1))
new_repo
printf 'ok\n' > "$R/src/f.txt"
printf '# reason: pasted\nsrc/f.txt:%s\n' "$TOK" > "$R/.secretscan-allowlist"
scan --all
[ "$code" = 1 ] || bad "an entry for a line the file does not hold must fail"
grep -q 'matches no line in src/f.txt' "$W/err" || bad "missing-line entry not reported"
if grep -qF -- "$BODY40" "$W/err"; then bad "allowlist report echoed fixture text"; fi
printf '# reason: gone\nsrc/missing.txt:%s\n' "$TOK" > "$R/.secretscan-allowlist"
scan --all
[ "$code" = 1 ] || bad "an entry for a missing file must fail"
printf '# reason: gone\n@path certs/missing.pem\n' > "$R/.secretscan-allowlist"
scan --all
[ "$code" = 1 ] || bad "an @path entry for a missing file must fail"
printf '# reason: %s\n' "$TOK" > "$R/.secretscan-allowlist"
scan --all
[ "$code" = 1 ] || bad "a secret in an allowlist comment must fail"
grep -q 'comment of .secretscan-allowlist (github-token)' "$W/err" || bad "comment secret not reported"
printf '# reason: refresh the token every so often\n' > "$R/.secretscan-allowlist"
scan --all
[ "$code" = 0 ] || bad "an ordinary allowlist comment must pass: $(cat "$W/err")"

# --- staged files (the pre-commit run) -------------------------------------------
checks=$((checks + 1))
new_repo
printf 'ok\n' > "$R/src/a.txt"
git -C "$R" add -A
git -C "$R" commit -q -m base
printf '%s\n' "$(printf '%s%s' ghp_ "$BODY40")" > "$R/src/b.txt"
git -C "$R" add src/b.txt
code=0
(cd "$R" && sh scripts/scan-secrets.sh) > /dev/null 2> "$W/err" || code=$?
[ "$code" = 1 ] || bad "staged scan missed a token"

# --- commit range: a secret added and removed inside the range ------------------
checks=$((checks + 1))
new_repo
printf 'ok\n' > "$R/src/a.txt"
git -C "$R" add -A
git -C "$R" commit -q -m base
BASE="$(git -C "$R" rev-parse HEAD)"
printf 'more\n' > "$R/src/c.txt"
git -C "$R" add -A
git -C "$R" commit -q -m clean
CLEAN_HEAD="$(git -C "$R" rev-parse HEAD)"
code=0
(cd "$R" && sh scripts/scan-secrets.sh --range "$BASE..$CLEAN_HEAD") > /dev/null 2> "$W/err" || code=$?
[ "$code" = 0 ] || bad "clean range was flagged: $(cat "$W/err")"
printf '%s\n' "$(printf '%s%s' ghp_ "$BODY40")" > "$R/src/leak.txt"
printf 'x\n' > "$R/.env"
git -C "$R" add -A
git -C "$R" commit -q -m add
git -C "$R" rm -q src/leak.txt .env
git -C "$R" commit -q -m remove
code=0
(cd "$R" && sh scripts/scan-secrets.sh --all) > /dev/null 2> "$W/err" || code=$?
[ "$code" = 0 ] || bad "tree is clean after the removal but --all failed: $(cat "$W/err")"
code=0
(cd "$R" && sh scripts/scan-secrets.sh --range "$BASE..HEAD") > /dev/null 2> "$W/err" || code=$?
[ "$code" = 1 ] || bad "range scan missed a secret that was removed later in the range"
grep -q 'src/leak.txt in commit .* (github-token)' "$W/err" || bad "range report lacks file, commit and rule"
grep -q 'secret-bearing path must not be committed (env-file): .env' "$W/err" || bad "range scan missed the .env file"
if grep -qF -- "$BODY40" "$W/err"; then bad "range report echoed fixture text"; fi
code=0
(cd "$R" && sh scripts/scan-secrets.sh --range "no-such-ref..HEAD") > /dev/null 2> "$W/err" || code=$?
[ "$code" = 1 ] || bad "an unresolvable range must fail closed"

# --- usage and environment -------------------------------------------------------
checks=$((checks + 1))
NOGIT="$W/nogit"
mkdir -p "$NOGIT/scripts"
cp "$SCANNER" "$PATTERNS" "$NOGIT/scripts/"
: > "$NOGIT/.secretscan-allowlist"
code=0
(cd "$NOGIT" && sh scripts/scan-secrets.sh --all) > /dev/null 2> "$W/err" || code=$?
[ "$code" = 1 ] || bad "must refuse to run outside a git repository"

if [ "$failures" -gt 0 ]; then
  echo "scan-secrets selftest: $failures of $checks checks failed" >&2
  exit 1
fi
echo "scan-secrets selftest: $checks checks passed"
