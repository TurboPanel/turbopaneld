# Testing — AGENTS.md

Daemon repo context: `../../AGENTS.md`. Cross-repo `../<repo>/…` links are relative to the repo root.

## Testing

Local commands: **`deno task verify:ci`** is the guest mirror of `verify.yml`
minus the Sonar upload: `verify:static` (`fmt:check`, `lint`, `check`,
`check:layout`, `check:vocabulary`, `check:contract-drift`) then
`notices:check`, `check:orchestration` (needs `ansible-playbook` /
`ansible-lint` on PATH — prepend `/opt/turbopanel/vendor/ansible/current/bin`
in the guest), and **`test:coverage`** (the LCOV Sonar imports).
**`deno task verify`** is the faster host-runnable cousin (`test` instead of
`test:coverage`, no orchestration). `deno task verify:static` alone is the
offline sanity pass. Fleet-wide from the host `dev` checkout:
`./scripts/ci-verify.sh` (re-execs via `vagrant ssh`). Individual tasks
(`test`, `test:coverage`, `fmt:check`, `lint`, `check`, `check:layout`,
`check:vocabulary`) remain available. See **Guards / tests** in `.github/AGENTS.md` for the
`-A` grant, per-test `permissions:` rule, and Sonar-way **80% new-code** floor.

**Test style:** use the mandatory `const test = Deno.test.bind(Deno);` alias and
`new TypeError()` for shape assertions — both under TypeScript style
(SonarQube) in `src/AGENTS.md`; do not restate them here.

**Coverage dir must stay absolute.** `test:coverage` passes
`--coverage=$PWD/coverage/profile`, not a relative path. Several suites (and
the `Deno.chdir("/")` fallbacks in `src/dev-sync/apply.ts` /
`src/instance/run-reconcile.ts`) move the process cwd, and `deno test
--coverage` resolves a *relative* coverage dir at end-of-run against whatever
cwd it is left with — which fails with `Error generating coverage report:
Failed to create output file` and silently drops that data. Absolute path, no
dependence on ambient cwd.

**LCOV paths:** `test:coverage` ends with `scripts/normalize-lcov.ts`, which
rewrites `SF:` to repo-relative and asserts nothing absolute remains. Deno
emits absolute `SF:` paths; SonarCloud resolves `SF:` against the project root,
so an absolute path silently drops the whole report (green build, 0% coverage).
CI re-runs the same script as an idempotent gate, so a local report is
byte-identical to what SonarCloud imports.

**Orchestration is gated too.** `deno task check:orchestration`
(`scripts/check-orchestration.sh`, wired into CI `verify.yml`) runs
`ansible-playbook --syntax-check` on every playbook plus `ansible-lint
--profile min`. Before this the Ansible layer — 25 playbooks, 42 first-party
roles — had no CI gate of any kind, so a broken role reference or malformed
task list only surfaced as a converge failure on a real host. Needs
`ansible-playbook` / `ansible-lint` on PATH: in the guest,
`export PATH="/opt/turbopanel/vendor/ansible/current/bin:$PATH"`. CI installs
that toolchain from `orchestration/requirements.lock.txt` (`pip install
--require-hashes`). Syntax-check
resolves `ansible.posix.acl` / `ansible.posix.sysctl`: when the collection is
not already vendored under `$TURBOPANEL_RUNTIMES_DIR/ansible/galaxy-collections`
(CI has ansible-core from pip and no vendor tree), the script installs the
bundled tarball from `orchestration/vendor/galaxy/` offline. Rules that
still fire on first-party content (`partial-become`, `parser-error`) are in
`warn_list` in `.ansible-lint` with the reasoning; the full ansible-lint
profile is deliberately **not** gated (~360 findings, nearly all style).

**Real-`git` suites:** use `withTempGitRepo` from `src/testing/temp-git-repo.ts`
rather than running git against the ambient checkout. Ambient-tree suites break
in a `git worktree` whose `.git` points outside the visible filesystem, in
exported tarballs, and in containers without `.git`. Where a test must cover a
helper's `cwd = ROOT` *default argument*, guard it with
`ignore: !await ambientCheckoutIsGitRepo(...)` so it skips rather than fails
off-checkout; CI always has a real checkout.

**Daemon identity files in tests:** a test that writes `server.id`, the server
key, `server-key-id`, the sealing key, the license files, the CA pin or
`trust-level` gives the code a temp state dir (`createTempLayout` /
`withTempLayout`, or a `Deno.makeTempDir` passed as `stateDir`). In a
`deno test` run `writeDaemonFile`, `removeDaemonFile`, the key-id writer, the
in-flight command journal and the update progress queue refuse any path
outside `/tmp` or `/var/tmp`, with symlinks resolved
(`src/permissions/test-write-guard.ts`); `test-write-guard.test.ts` fails when
a module that names these files writes them some other way. CI seeds
`/var/lib/turbopanel` with stand-in files before the tests and fails when any
of them changed or a new entry appeared (`scripts/daemon-state-sentinel.ts`).
Its first run caught suites writing `commands/inflight/` and
`update/progress-queue.jsonl` there, which is why those two writers are
guarded too. A `TMPDIR` outside `/tmp` makes `Deno.makeTempDir` dirs fail the
guard, so unset it for test runs.
On a box with a real daemon (the dev box), leave the full suite to CI or the
guest; locally run only the files you touched, and never with
`TURBOPANEL_DAEMON_STATE_DIR` or `TURBOPANEL_STATE_DIR` pointing at a real
state dir.

**Where to run tests:** host VirtFS checkouts lack a usable Deno tree. Run
suites **inside the Vagrant guest** from the host `dev` checkout:

```bash
vagrant ssh -c 'export PATH="/opt/turbopanel/vendor/deno/current:$PATH"; cd ~/turbopanel/turbopaneld && deno task test'
```

Interactive `vagrant ssh` then `cd ~/turbopanel/turbopaneld` also works. Canonical
detail: `../dev/AGENTS.md` → Testing. Do not run `deno task test` on the
host.

## Shared Test Helpers

**Shared test helpers:** new tests must consume the helpers in `src/testing/`
(`fake-websocket.ts`, `fake-clock.ts`, `temp-layout.ts`, `fake-instance-api.ts`,
`jwks-test-helpers.ts`, re-exported from `src/testing/index.ts`) instead of
hand-rolled doubles. `src/testing/**` is test-only and must never be imported
from production code.
