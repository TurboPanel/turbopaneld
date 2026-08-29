#!/bin/sh
# Orchestration guard: validate the Ansible layer the way deno lint / deno
# check validate the TypeScript layer.
#
# CI gates every TypeScript path (fmt, lint, typecheck, tests, coverage) but
# nothing validated `orchestration/` -- 20+ playbooks and 30+ first-party roles
# whose only feedback was a converge failure on a real host. `.ansible-lint`
# and the pinned `ansible-lint` in orchestration/requirements.txt ("IDE/CI
# linting") always anticipated this gate; it was simply never wired up.
#
# Two tiers, both cheap and host-free:
#   1. `ansible-playbook --syntax-check` on every playbook -- catches an
#      unresolvable role, a malformed task list, a bad include. Zero false
#      positives; every playbook passes today. Playbooks FQCN
#      `ansible.posix.acl` / `ansible.posix.sysctl`, so this step installs
#      the pin from orchestration/requirements.yml when the collection is
#      not already vendored (CI pip-installs requirements.lock.txt).
#      Do not install the deferred Docker Galaxy role — it is on-demand
#      and is not needed to resolve first-party syntax.
#   2. `ansible-lint --profile min` -- ansible-lint's most conservative
#      profile (correctness only, no style). Rules that currently fire on
#      first-party content are in `warn_list` in .ansible-lint, so they are
#      reported without failing; anything new fails.
#
# Deliberately NOT gated: the default/full ansible-lint profile. It reports
# ~360 findings here, almost all style (yaml[line-length], role-name,
# var-naming[no-role-prefix]). Turning that into a gate is a cleanup project,
# not a guard.
#
# Usage: sh scripts/check-orchestration.sh
#        deno task check:orchestration
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Vendored runtime root (and the Apple Silicon OPENSSL_armcap workaround that
# ansible-playbook needs). Never hardcode the vendor root here --
# check:layout rejects that literal outside the layout modules.
# shellcheck source=scripts/lib/runtime-paths.sh
. "$ROOT/scripts/lib/runtime-paths.sh"

if ! command -v ansible-playbook >/dev/null 2>&1; then
  echo "check-orchestration: ansible-playbook not on PATH." >&2
  echo "  Guest:  export PATH=\"$TURBOPANEL_RUNTIMES_DIR/ansible/current/bin:\$PATH\"" >&2
  echo "  CI:     pip install --require-hashes --only-binary :all: -r orchestration/requirements.lock.txt" >&2
  exit 1
fi

if ! command -v ansible-lint >/dev/null 2>&1; then
  echo "check-orchestration: ansible-lint not on PATH (see orchestration/requirements.txt)." >&2
  exit 1
fi

# ansible.cfg collections_path is the FHS vendor tree. CI (pip ansible-core)
# has none of those dirs, so syntax-check cannot resolve ansible.posix.* until
# the collection is on ANSIBLE_COLLECTIONS_PATH. Skip Galaxy when converge has
# already vendored it; install from requirements.yml otherwise (3 attempts).
ensure_posix_collection() {
  vendored="$TURBOPANEL_RUNTIMES_DIR/ansible/galaxy-collections"
  if [ -d "$vendored/ansible_collections/ansible/posix" ]; then
    echo "    using vendored ansible.posix ($vendored)"
    return 0
  fi

  if ! command -v ansible-galaxy >/dev/null 2>&1; then
    echo "check-orchestration: ansible-galaxy not on PATH (need ansible.posix for syntax-check)." >&2
    echo "  CI: pip install --require-hashes --only-binary :all: -r orchestration/requirements.lock.txt" >&2
    exit 1
  fi

  collections_dir="${TMPDIR:-/tmp}/turbopanel-orchestration-collections"
  req="$ROOT/orchestration/requirements.yml"
  stamp_file="$collections_dir/.requirements.sha256"
  req_hash="none"
  if command -v sha256sum >/dev/null 2>&1; then
    req_hash=$(sha256sum "$req" | cut -d " " -f1)
  fi
  if [ -d "$collections_dir/ansible_collections/ansible/posix" ] &&
    [ -f "$stamp_file" ] &&
    [ "$req_hash" != "none" ] &&
    [ "$(cat "$stamp_file")" = "$req_hash" ]; then
    echo "    using cached ansible.posix ($collections_dir)"
    ANSIBLE_COLLECTIONS_PATH="$collections_dir"
    export ANSIBLE_COLLECTIONS_PATH
    return 0
  fi

  # Export before galaxy install so -p is a configured collections path
  # (otherwise galaxy may no-op with "already installed" from ansible.cfg's
  # FHS entries and leave this directory empty).
  ANSIBLE_COLLECTIONS_PATH="$collections_dir"
  export ANSIBLE_COLLECTIONS_PATH

  echo "    installing ansible.posix from orchestration/requirements.yml"
  rm -rf "$collections_dir"
  mkdir -p "$collections_dir"
  attempt=1
  while [ "$attempt" -le 3 ]; do
    # --force: galaxy treats a collection found in any other collections_path
    # as installed and skips -p. CI has no other copy; a guest with a vendor
    # tree we are not using still might.
    if ansible-galaxy collection install --force -r "$req" -p "$collections_dir" &&
      [ -d "$collections_dir/ansible_collections/ansible/posix" ]; then
      if [ "$req_hash" != "none" ]; then
        printf "%s\n" "$req_hash" > "$stamp_file"
      fi
      return 0
    fi
    echo "check-orchestration: galaxy collection install failed (attempt $attempt/3)" >&2
    if [ "$attempt" -eq 3 ]; then
      break
    fi
    sleep 2
    attempt=$((attempt + 1))
  done
  echo "check-orchestration: failed to install ansible.posix from orchestration/requirements.yml" >&2
  exit 1
}

echo "==> ansible.posix collection"
ensure_posix_collection

echo "==> ansible-playbook --syntax-check"
failed=0
checked=0
for playbook in orchestration/playbooks/*.yml; do
  [ -e "$playbook" ] || continue
  checked=$((checked + 1))
  # Default callback: ansible.cfg enables ansible.posix.jsonl, which is for
  # converge streaming, not a human syntax-check failure dump.
  if ! output="$(cd orchestration && ANSIBLE_CONFIG=ansible.cfg \
    ANSIBLE_STDOUT_CALLBACK=default ansible-playbook \
    --syntax-check "${playbook#orchestration/}" 2>&1)"; then
    failed=$((failed + 1))
    echo "FAIL $playbook" >&2
    printf '%s\n' "$output" | sed 's/^/    /' >&2
  fi
done

if [ "$checked" -eq 0 ]; then
  echo "check-orchestration: no playbooks found under orchestration/playbooks/" >&2
  exit 1
fi

if [ "$failed" -ne 0 ]; then
  echo "check-orchestration: $failed of $checked playbook(s) failed syntax-check" >&2
  exit 1
fi
echo "    $checked playbook(s) OK"

echo "==> ansible-lint --profile min"
# Run from the repo root so the root .ansible-lint (exclude_paths, warn_list)
# applies. --offline keeps CI from reaching Galaxy.
ansible-lint --offline --profile min --nocolor

echo "check-orchestration: OK"
