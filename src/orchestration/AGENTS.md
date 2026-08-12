# Installer presentation layer — AGENTS.md

The installer presenter (`src/orchestration/install-presenter.ts` + `install-presenter-context.ts`) and the vocabulary / sanitizer map (`presentation.ts`) that scrub raw tool output during remote `run.sh` install and converge (spinner + rolling window on TTY; one sanitized line per update otherwise).

Root context: `../../AGENTS.md`. Ansible roles/playbooks tree: `../../orchestration/AGENTS.md`. Cross-repo `../<repo>/…` links are relative to the repo root.

### Installer presentation layer

Remote `run.sh` install, `runBootstrapOrchestration()`, and `runInstaller()`
drive an **installer presenter** (`src/orchestration/install-presenter.ts` +
`install-presenter-context.ts`) instead of dumping raw tool output on the
terminal. TTY hosts get a spinner and a rolling status window; non-TTY hosts get
one sanitized status line per update plus a final outcome line.

**Vocabulary map (installer-facing only):** structured log/event components and
free-text status lines pass through `relabelComponent()` /
`sanitizeStatusLine()` while the presenter is active
(`src/orchestration/presentation.ts`). Common mappings: `ansible` /
`ansible-galaxy` / `galaxy` → **orchestration**; `redis` → **cache**; `rabbitmq`
/ `rabbit mq` → **queue**; `proxysql` → **ingress**; `uv` / `python` /
`cpython` → **runtime**. Ansible
JSONL events (`logAnsibleEvent` / `InstallEventPresenter`) and orchestration
`logInfo` lines (`runRedisSetup`, `runRabbitmqSetup`, `runPostgresSetup`,
`runProxySqlSetup`, `runDockerSetup`, `runInstanceDevInstall`,
`runDaemonConverge`, …) all funnel through the same helpers when
`setActiveInstallPresenter()` is set.

**Intentionally unchanged:** vendor directory names
(`/opt/turbopanel/vendor/redis/…`), Ansible role directory names (`roles/redis`,
`roles/rabbitmq`), playbook filenames (`redis-setup.yml`, `rabbitmq-setup.yml`),
handlers/templates, env vars, and internal identifiers (`redis_*`, `rabbitmq_*`,
`TURBOPANEL_REDIS_*`, …). User-facing Ansible task `name:` strings in the
cache/queue roles use neutral wording where practical so labels read cleanly
even outside the sanitizer.

**Apple Silicon VM note:** `runtimeEnv()` sets `OPENSSL_armcap=0` so ansible's
cryptography wheel does not SIGILL when the hypervisor advertises SVE2 without
implementing it (UTM/Parallels). See root `AGENTS.md`.

**Debian dash:** `ansibleEnv()` sets `ANSIBLE_EXECUTABLE=/bin/bash` because
Debian `/bin/sh` is dash and rejects `set -o pipefail` in role `shell:`
snippets. See root `AGENTS.md`.

**Logs:** when the presenter is **inactive** (normal daemon converge /
`daemon.log`), structured logs keep full vendor detail. When the presenter is
**active**, stdout/stderr show the scrubbed rolling view; `daemon.log` is not
duplicated on that path — operators rely on post-install logs for full detail.

Tests: `src/orchestration/presentation.test.ts`, `install-presenter.test.ts`,
`ansible-events.test.ts` ( `formatAnsibleEventLog` ), `ansible.test.ts`
(internal path vs presented status lines).

