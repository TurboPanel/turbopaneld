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
#      positives; every playbook passes today.
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
  echo "  CI:     pip install -r orchestration/requirements.txt" >&2
  exit 1
fi

if ! command -v ansible-lint >/dev/null 2>&1; then
  echo "check-orchestration: ansible-lint not on PATH (see orchestration/requirements.txt)." >&2
  exit 1
fi

echo "==> ansible-playbook --syntax-check"
failed=0
checked=0
for playbook in orchestration/playbooks/*.yml; do
  [ -e "$playbook" ] || continue
  checked=$((checked + 1))
  if ! output="$(cd orchestration && ANSIBLE_CONFIG=ansible.cfg ansible-playbook \
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
