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
/ `rabbit mq` → **queue**; `proxysql` → **ingress**; `orchestrator` → **HA**; `uv` / `python` /
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


## Boot converge on a new server

`initOrchestration` is two steps: `bootstrapOrchestrationTools` (a few seconds)
and `runBootConverge` (`daemon-converge.yml`, about a minute and a half on a new
host). An enrolled host runs both before it connects, as it always did. A host
with no `server.id` yet (first start, daemon-only managed server) runs only the
tools step, connects to the control plane, and converges in the background so
the panel sees it within seconds. `boot-converge-gate.ts` holds command
dispatch (after the ack) until that converge has finished, passed or failed, so
no command runs a playbook on top of it. The fabric, forwarding, PHP and
background checks that normally precede the connection run after a successful
converge on that path.

## Runtime Integrity

- **Runtime integrity** — `deno-runtime` / `node-runtime` / `caddy` defaults
  carry `deno_sha256` / `node_sha256` / `corepack_sha256` / `caddy_sha256`
  tables keyed by version; those roles download with `get_url checksum:` and
  assert a digest exists for the pinned version + host arch, corepack installs
  from the verified tarball (`corepack_version`), hosting Caddy direct-download
  paths verify SHA-256 before extraction (`ensure-hosting-caddy.ts`,
  `install-hosting-caddy.sh`, instance `download-caddy.mjs`), and `run.sh`
  mirrors the Deno digests (`TP_DENO_SHA256_*`, checked before extraction).
  `src/orchestration/assets.test.ts` fails a version bump that lands without
  its digests, and it requires the hosting Caddy version plus both arch
  digests to match across the role default, `ensure-hosting-caddy.ts`,
  `install-hosting-caddy.sh`, and instance `download-caddy.mjs` (sibling
  checkout, or the trunk copy CI places at `.ci-instance-caddy-pin`). A
  missing instance downloader fails those tests.

## Scope Summary (Former Root Index Entry)

| Subsystem | Read before editing | Covers |
|---|---|---|
| **Installer presentation** | `src/orchestration/AGENTS.md` | Installer presenter + sanitizer / vocabulary map for `run.sh` install & converge |
