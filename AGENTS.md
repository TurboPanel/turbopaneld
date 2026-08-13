# AGENTS.md

TurboPanel **daemon** — Ansible-driven host daemon; connects to the instance over
HTTPS/WSS (or Unix socket when co-located).

## Documentation discipline

**Keep this file current.** When you learn something durable about daemon ↔
instance contracts — WS presence, reconnect behavior, command handlers,
orchestration — add or update a note here in the same PR/session as the code
change. Cross-repo cell/cost rules live in `../instance/AGENTS.md` (Daemon Cell
section); link there instead of duplicating DO hibernation detail.

### TypeScript style (SonarQube)

- Prefer **`String#replaceAll()`** over **`String#replace()` with a global
  regex** when replacing every occurrence of a substring (`typescript:S7781`).
- Use **`String.raw`** for string literals that contain backslashes so escapes
  stay readable and correct (`typescript:S7780`).
- Prefer **optional chaining** (`obj?.prop`) over `!obj || obj.prop`
  (`typescript:S6582`).
- Use **`new TypeError()`** for type/shape assertions in tests
  (`typescript:S7786`).
- Avoid **nested ternaries** — use `if`/`switch` or helpers
  (`typescript:S3358`).
- Extract helpers when **cognitive complexity** exceeds 15 (`typescript:S3776`).
- Add **`// NOSONAR rule-key — reason`** for intentional read-only `/tmp`
  path-prefix checks (`typescript:S5443`).
- Deno tests: Sonar `typescript:S2187` only recognizes `test()` / `it()` /
  `describe()`, not `Deno.test`. **Every `*.test.ts` file MUST** use BDD
  (`import { describe, it } from '@std/testing/bdd'`) or the canonical alias —
  never leave a bare `Deno.test(` in a test file. Place the alias once, right
  after the imports, and call `test('...', …)` (or the object form
  `test({ name, fn })`):

  ```ts
  /**
   * Jest/Mocha-shaped alias for {@link Deno.test}.
   *
   * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
   * reports Deno suites as empty; keep this alias so analysis sees real tests.
   */
  const test = Deno.test.bind(Deno);
  ```

  When adding a new Deno test file, add this alias from the start. Applied to
  every existing Deno test file in this repo and `../instance`.

### Ansible style (SonarQube)

- Prefer **`mode: "0640"`** / **`0750"`** with explicit **`owner`** /
  **`group`** over world-readable modes (`ansible:S2612`).

## Filesystem layout & path model (dev vs prod)

`src/paths/layout.ts` is the **single source of truth** for every managed
install location. `resolveLayout(env, opts)` returns mode-aware defaults;
`detectInstallMode()` picks `development` vs `production` (a resolvable daemon
checkout — `orchestration/ansible.cfg` or `main.ts`, and not a `deno-compile-*`
extraction dir — means development, otherwise production). Every path is
env-overridable (`TURBOPANEL_HOME`, `TURBOPANEL_BIN_DIR`, `TURBOPANEL_LIB_DIR`,
`TURBOPANEL_RUNTIME_DIR`, `TURBOPANEL_SHARE_DIR`, `TURBOPANEL_UI_DIR`,
`TURBOPANEL_ORCHESTRATION_DIR`, `TURBOPANEL_CONFIG_DIR`, `TURBOPANEL_STATE_DIR`,
`TURBOPANEL_DAEMON_STATE_DIR`, `TURBOPANEL_LOG_DIR`, `TURBOPANEL_RUN_DIR`,
`TURBOPANEL_RUNTIMES_DIR`, `TURBOPANEL_DAEMON_ROOT`,
`TURBOPANEL_PRINCIPAL_HOME_ROOT`).
`src/orchestration/paths.ts` and `src/instance/paths.ts` derive their constants
from `resolveLayout` — do **not** hardcode absolute paths in runtime code;
add/extend a layout field instead. The development default checkout root is
`<devRoot>/daemon` (from `TURBOPANEL_DEV_ROOT` / `$HOME`); production runtime
code must never name the retired `/opt/turbopanel/platform` token — the layout
module and CI guard are the only places allowed to reference it.

**Production (managed / FHS)** — compiled release, no source checkout. The daemon runs as **`tp:tp`** (UID/GID 9999); per-service accounts (`tpctrl`, `tpcache`, `tpdata`, `tpqueue`, `tpmetrics`, `tpcaddy`) are listed in **`../instance/AGENTS.md`** (Production UID/GID allocation):

| Purpose                                                           | Path                                  |
| ----------------------------------------------------------------- | ------------------------------------- |
| Native daemon binary                                              | `/opt/turbopanel/bin/turbopaneld`     |
| Deno JS runtime (`turbopaneld.js`; page-size-incompatible hosts)  | `/opt/turbopanel/bin/turbopaneld.js`  |
| Orchestration assets (Ansible)                                    | `/opt/turbopanel/share/orchestration` |
| Static UI export                                                  | `/opt/turbopanel/share/ui`            |
| Vendored runtimes (node/deno/caddy/uv/python/ansible/cloudflared) | `/opt/turbopanel/vendor`              |
| Daemon install root (`daemonRootDefault`)                         | `/opt/turbopanel/lib/daemon`          |
| Config (`daemon.env`, `instance-ca.pem`)                          | `/etc/turbopanel`                     |
| Persistent identity (license, `server.id`, keys, tunnels)         | `/var/lib/turbopanel`                 |
| Tenant principal homes (`principalHomeRoot`)                      | `/srv/users/<username>`               |
| Logs                                                              | `/var/log/turbopanel`                 |
| Runtime (sockets, `daemon.lock`)                                  | `/run/turbopanel`                     |

The **host** allocates UID/GID via `useradd`/`groupadd`. The control plane may
send an optional operator override, which must clear the `tp*` service band
**9989–9999**. Homes are keyed on the username. Override the home root with
`TURBOPANEL_PRINCIPAL_HOME_ROOT` (`layout.principalHomeRoot`).

**Development (co-located checkout)** — `./console` from
[turbopanel/dev](https://github.com/turbopanel/dev) runs the daemon from source
(`deno run main.ts`); all mutable paths are **dev-user-owned**:

| Purpose                          | Path                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| Daemon checkout / install root   | `<TURBOPANEL_DEV_ROOT or $HOME>/daemon`                                            |
| Orchestration assets             | `<checkout>/orchestration` (prod roles); overlay in `<dev checkout>/orchestration` |
| Vendored runtimes                | `/opt/turbopanel/vendor`                                                           |
| Daemon env file                  | `/etc/turbopanel/daemon.env`                                                       |
| Daemon state                     | `/var/lib/turbopanel`                                                              |
| Logs                             | `/var/log/turbopanel`                                                              |
| Config dir                       | `/etc/turbopanel`                                                                  |
| Runtime (sockets, `daemon.lock`) | `/run/turbopanel`                                                                  |

**Development identity:** co-located dev creates **no** dedicated `tp`,
`tpctrl`, or `tpcache` / `tpmetrics` service accounts. The
`turbopaneld`, instance, UI, and Caddy systemd units, plus Docker-backed
services (Postgres, RabbitMQ, and ClickHouse consolidated under the single
`turbopanel-system-stack` Compose stack — see **System services Compose stack**
below — plus standalone Redis, Mailpit, Tabix — `turbopanel-tabix`), all run as
the **current dev user**. Production managed installs keep the dedicated
service users `tp`, `tpctrl`, `tpcache`, `tpdata`, `tpqueue`, `tpmetrics`, and
`tpcaddy` — see **`../instance/AGENTS.md`** (Production UID/GID allocation).

**Deno version pin:** `DENO_VERSION` (`src/orchestration/paths.ts`) =
**`2.9.5`**. Keep it in step with `deno_version` in
`orchestration/roles/deno-runtime/defaults/main.yml`, `TP_DENO_VERSION` in
`scripts/run.sh`, and `DENO_VERSION` in
[turbopanel/dev](https://github.com/turbopanel/dev) `src/lib/paths.ts` (dev
console bootstrap fallback + status label). `src/orchestration/paths.test.ts`
pins the const to the role default.

**Vendored Node/Deno layout:** Ansible roles install pinned runtimes under
`/opt/turbopanel/vendor/<tool>/<version>/` with a `current` symlink (see
`node-runtime`, `deno-runtime`, `caddy`). Consumers resolve `turbopanel_node`
(`…/node/current/bin/node`), `turbopanel_deno` (`…/deno/current/deno`), and
`turbopanel_runtime_path` (colon-separated PATH prefix for systemd/Ansible
tasks). Node **24.17.0** is pinned in `node-runtime/defaults/main.yml` — keep in
step with `NODE_VERSION` in [turbopanel/dev](https://github.com/turbopanel/dev)
`scripts/lib/paths.sh`. The vendored runtime root is defined once in
`src/paths/layout.ts` (`resolveRuntimesDir()` / `PROD_RUNTIME_DIR_DEFAULT`);
shell helpers live in `scripts/lib/runtime-paths.sh`.

**Manual troubleshooting (retired `/opt/turbopanel/runtimes` shell-rc line):**
an old Deno bootstrap may have appended a line like
`. "/opt/turbopanel/runtimes/deno/.install/env"` to `~/.bashrc` / `~/.profile` /
similar. That path is gone after the vendor rename, so every login prints "No
such file or directory". Managed install/converge does **not** rewrite shell
profiles — remove the stale line by hand (or reset the dev environment) if it
appears.

**Ansible home (no root pollution):** `ansibleEnv()` /
`devOrchestrationAnsibleEnv()` set `ANSIBLE_HOME` to `/tmp/turbopanel-ansible`
(alongside `ANSIBLE_LOCAL_TEMP` under `vendor/uv/cache/ansible-tmp`). Galaxy
download cache is disposable scratch — first-party roles live under FHS
`share/orchestration/roles`; Galaxy collections/roles live under
`vendor/ansible/galaxy-collections` and `vendor/ansible/galaxy-roles`. Managed
`run.sh` + `daemon-install.yml` remove `/tmp/turbopanel-ansible` and any
accidental `/root/.ansible` after install. Runtime orchestration runs as
`tp` (dev: the current dev user).

**Galaxy content is not committed:** collection pins live in
`orchestration/requirements.yml` (`ansible.posix`); Docker role pins live in
`orchestration/requirements-docker.yml` (`geerlingguy.docker`). Bootstrap
(`ensureGalaxyCollections`) installs only collections under
`vendor/ansible/galaxy-collections` — needed for the JSONL callback and
`ansible.posix.sysctl` on every playbook. The Docker Galaxy role is deferred
(`ensureGalaxyDockerRole`) until a host actually needs the container runtime
(`runDockerSetup` / co-located dev converge via
`scripts/run-orchestration-action.ts` `instance-dev-install` /
postgres|rabbitmq|clickhouse setup), so fresh daemon installs and pre-Docker
hosts skip that download. **Install path:** `ensureGalaxyDockerRole` reads the
version pin from `requirements-docker.yml` and downloads the matching tag via
**codeload.github.com** (`galaxyDockerRoleCodeloadUrl`) into
`vendor/ansible/galaxy-roles/geerlingguy.docker` — it does **not** call
`ansible-galaxy role install`, which resolves classic roles through
`github.com/.../archive/*.tar.gz` and intermittently fails with edge 503s.
First-party
roles (e.g. `docker`, which wraps Galaxy via `include_role`) stay in git;
Galaxy install trees land under `vendor/ansible/galaxy-roles/` (never the
checkout `orchestration/roles/` tree — that path is a Vagrant VirtFS mount and
is not guest-writable). Do not vend them into the repo — Sonar would scan
third-party `mode: 0644`/`0755` as false vulnerabilities, and release hosts
reinstall collections at bootstrap and the Docker role on first Docker use.
Keep leftover checkout copies out of ansible-lint / the Ansible IDE extension:
`exclude_paths` in repo-root + `orchestration/.ansible-lint`, `files.exclude`
in `.vscode` / `dev.code-workspace`, and after Galaxy install
`ensureGalaxyDockerRole` rewrites each present layout's nested `.ansible-lint`
(`geerlingguy.docker/` and `geerlingguy/docker/`) with a near-total
`skip_list` (and removes upstream `.yamllint`) so opening files under the role
— including `tasks/docker-*.yml` — is quiet. Path exclusions only apply to
discovery, not explicitly opened files.

**Apple Silicon VMs (UTM / Parallels) + ansible cryptography:** hypervisors often
advertise SVE2 in the guest without implementing it. cryptography 47+ ships
OpenSSL that probes those features at import and **SIGILL**s (`ansible-playbook
--version` exits 132). Orchestration `runtimeEnv()` and shell
`scripts/lib/runtime-paths.sh` always set `OPENSSL_armcap=0` so OpenSSL skips
ARM CPU probing (harmless on real aarch64 and x86_64). The Vagrant guest profile
exports the same for interactive shells. Shell wrappers that invoke ansible under
`sudo` must source `runtime-paths.sh` (or export the var explicitly) because
`sudo` resets the user environment.

**Debian `/bin/sh` is dash:** `ansible.builtin.shell` defaults to `/bin/sh`.
Dash rejects `set -o pipefail` (`set: Illegal option -o pipefail`), which is
how cache/Deno/Caddy/… install snippets start — the task then fails with
“non-zero return code” before curl/dpkg run. Runtime `ansible.cfg` sets
`executable = /bin/bash`, and `ansibleEnv()` / `devOrchestrationAnsibleEnv()`
export `ANSIBLE_EXECUTABLE=/bin/bash`. Keep those in step; do not drop
`pipefail` from bash snippets that actually pipe (password generators).

**`instance-dev-install --if-needed`:** `scripts/run-orchestration-action.ts`
accepts an `--if-needed` flag on `instance-dev-install`. When set, it calls
`coLocatedInstanceServiceEnabled()` + `emitDevConvergeSkippedIfNeeded()`
(`src/orchestration/converge-stamp.ts`) and, when the stamp matches, emits a
single `dev_converge_skipped` JSONL event and exits **before**
`ensureAnsible` / `ensureGalaxyDockerRole` / the playbook run. Unflagged
invocations (and any flow with `TURBOPANEL_FORCE_CONVERGE=1` set) behave
exactly as before via `shouldSkipDevConverge()` / `forceConvergeRequested()`.
The [dev](https://github.com/turbopanel/dev) console threads this as
`installDevEnvironment(..., mode)` with `mode: "if-needed" | "force"` —
`"if-needed"` only for the post-daemon-install chain; `"force"` (and
`TURBOPANEL_FORCE_CONVERGE=1`) for Developer → Converge / re-converge and
legacy reset/provisioner callers. Optional co-located tooling
(`TURBOPANEL_OPTIONAL_*` → `turbopanel_optional_*`) starts Drizzle Studio,
Mailpit, Expo UI, website, Redis Insight, and Tabix only when selected; units
are still installed so the TUI can enable them later.

## Project metadata

GitHub repository:
[turbopanel/turbopaneld](https://github.com/turbopanel/turbopaneld). Deno
package name: `turbopaneld` (`deno.json`), aligned with the repo slug and the
compiled `/opt/turbopanel/bin/turbopaneld` binary.

**Public naming:** **TurboPanel Daemon** → [turbopanel/turbopaneld](https://github.com/turbopanel/turbopaneld); internal term `daemon`. **License:** AGPL-3.0-only ([`LICENSE`](./LICENSE), `deno.json`). **Maturity:** **Private alpha**. README is product-facing; AGENTS.md is maintainer-facing.

**Host-base prerequisite boundary:** TurboPanel-managed vendors (uv, Python,
Ansible venv, Deno, Node, Caddy, Redis, cloudflared) install under `vendor` via
orchestration bootstrap — not via apt in `run.sh`. The minimal host-base set is
**sudo, curl, ca-certificates, tar, python3-minimal** (`run.sh` may apt-install
these only when absent). `python3-minimal` extracts Deno release zips without
apt `unzip`. The `daemon-prereqs` role covers the broader managed-host set (git,
gnupg, pamtester, xz-utils, …) once Ansible can converge; Redis is vendored by
extracting the official `packages.redis.io` `.deb` with `dpkg-deb -x` (no
compile toolchain).

**Guards / tests:**

- `deno task check:layout` (`scripts/check-production-layout.ts`) — asserts the
  production FHS tree resolves to the canonical absolute paths and that no
  production source (`src/**`, excluding `*.test.ts` and `src/paths/layout.ts`)
  references `/opt/turbopanel/platform` or the retired `share/ansible`. Wired
  into `publish-daemon-trunk.yml`.
- `deno task test` / `test:coverage` / `lint` / `fmt:check` / `check` — quality
  surface in `deno.json`. The `test` task grants `-A` at the process level on
  purpose: Deno's per-test `permissions` option can only *reduce* from the
  process grant, so a narrower task grant would silently break
  `src/instance/commands/ping.test.ts` (`sys: ["hostname"]`),
  `src/instance/commands/stop-environment.test.ts` (`run: true`), and the
  twelve `permissions:` blocks in `src/instance/client.test.ts`. **Do not
  weaken or remove any existing per-test `permissions` block.** Coverage
  writes `coverage/lcov.info` (gitignored; already in Sonar / layout
  `SKIP_DIRS`).
- **SonarCloud coverage (CI):** `.github/workflows/verify.yml` runs
  `deno task test:coverage` then uploads LCOV via
  `sonar.javascript.lcov.reportPaths=coverage/lcov.info` (CI-based analysis;
  Automatic Analysis must stay **off** for `turbopanel_turbopaneld`). Deno may
  emit absolute `SF:/home/runner/work/...` paths on Actions; verify.yml strips
  the checkout prefix to repo-relative `SF:src/...` before upload. The
  project uses the built-in **Sonar way** quality gate, which fails when
  **coverage on new code is below 80%** (`new_coverage` LT 80); the scan waits
  on the gate (`sonar.qualitygate.wait=true`). When `SONAR_TOKEN` is unset the
  require/scan steps soft-fail / skip (`continue-on-error`) so fmt/lint/tests
  still gate PRs and trunk publish — wire the secret on the repo/org to enforce
  the Sonar gate. Sibling repos (`instance`, `ui`, `website`) have no Actions
  Sonar step; they rely on SonarCloud **Automatic Analysis**
  (`.sonarcloud.properties`) instead. Coverage exclusions include
  `**/*.test.ts`, `src/testing/**`, `src/build-info.ts`, `dist/**`,
  `publish/**`, the Galaxy Docker role tree, and `workers/**`. The
  `denoS2187` issue-ignore (`typescript:S2187` on `**/*.test.ts`) remains —
  LCOV import does not replace that false-positive suppression.
- `src/orchestration/paths.test.ts` — production/dev default trees, env
  overrides, and the `DENO_VERSION` ↔ role pin
  (`deno test src/orchestration/paths.test.ts`).
- `scripts/verify-release-root.sh` / `tp_verify_release_root`
  (`scripts/lib/release-artifacts.sh`) — reject dev-only paths, TS sources,
  `share/ansible`, or a leaked daemon source tree in a packaged release root.
  Release packaging helpers (`release-artifacts.sh`,
  `package-daemon-release.sh`, `bundle-orchestration.sh`,
  `verify-release-root.sh`) are **bash** — `deno.json` must invoke them with
  `bash`, not `sh` (Debian `/bin/sh` is dash and silently skips prune/verify
  checks that use `[[`). `run.sh` stays POSIX and inlines a separate copy of the
  manifest helpers for `curl | sh`.
- **CI gate:** `.github/workflows/verify.yml` is the canonical quality gate —
  reusable via `workflow_call`, the trunk `publish` job `needs: verify`, and
  promotion re-verifies artifact hashes only (no new compile from source).

## Testing

Local commands: `deno task test`, `deno task test:coverage`, `deno task
fmt:check`, `deno task lint`, `deno task check`, `deno task check:layout`. See
**Guards / tests** above for the `-A` grant, per-test `permissions:` rule, and
Sonar-way **80% new-code** floor.

**Test style:** use the mandatory `const test = Deno.test.bind(Deno);` alias and
`new TypeError()` for shape assertions — both under TypeScript style
(SonarQube) above; do not restate them here.

**Pre-commit** (`.githooks/pre-commit`): `scripts/scan-secrets.sh` only (never
skippable). Fmt/lint/tests are **temporarily disabled** in the hook until the
toolchain can run inside the Vagrant guest (host VirtFS checkouts often lack a
usable Deno tree). CI `verify.yml` still owns fmt/lint and the full suite. The
dev console’s daemon install (`cloneOrUpdateRepo` in
`../dev/src/lib/platform-install.ts`) sets `core.hooksPath=.githooks` after a
successful clone or update when `.githooks/pre-commit` exists. Production
`scripts/run.sh` never wires hooks.

**Shared test helpers:** new tests must consume the helpers in `src/testing/`
(`fake-websocket.ts`, `fake-clock.ts`, `temp-layout.ts`, `fake-instance-api.ts`,
`jwks-test-helpers.ts`, re-exported from `src/testing/index.ts`) instead of
hand-rolled doubles. `src/testing/**` is test-only and must never be imported
from production code.

**Gate matrix** (one policy with the dev repo):

| Stage | dev | daemon | Rationale |
| ----- | --- | ------ | --------- |
| pre-commit | scan-secrets only (tests deferred) | scan-secrets only (tests deferred) | secret scan on commit; suites in CI / guest |
| PR → `trunk` | `verify.yml` | `verify.yml` | blocks merge |
| push `trunk` | `verify.yml` | `verify.yml`; `publish` job `needs: verify` | nothing compiles from failing code |
| promote → canary/rc/release | n/a | **artifact integrity only** (S3 sha256/size + CDN fetch) | no new code enters after publish |

## Installer script hosting (`workers/turbopanel-sh/`)

**https://turbopanel.sh** is the canonical **assets-only** Workers Static Assets
host for the daemon installer script — **no Worker script**, so public installer traffic
can never generate Worker invocation billing. `_headers` sets the shellscript
content type + `no-store` on `/`.
Deploy tooling lives in the isolated `workers/turbopanel-sh/` package (Node +
wrangler only — not part of the Deno graph). Manual deploy: `npm install` then
`npm run deploy` from that directory; the stage step copies `scripts/run.sh` to
`public/bootstrap` (plus committed `assets/_headers` and `assets/_redirects`) into
gitignored `public/` at deploy time so the script stays a single source of truth. The
`workers/` tree is deploy tooling only and is
excluded from release packaging (`package-daemon-release.sh` /
`bundle-orchestration.sh` stage from `orchestration/` and `dist/.build` only).

### Host facts + command handlers (time sync)

- **Host OS** — `src/host/os-release.ts` (process-cached; attached once on hello).
- **Time sync** — `src/host/time-sync.ts` (cache-light `timedatectl show`,
  with `timedatectl status` + `/etc/timezone` fallbacks, plus `timesyncd.conf`
  read; carried on hello and change-detected heartbeats with `addresses` from
  `src/server-addresses.ts`).
- **Commands** — `server.hostname.set`, `server.reboot`, `server.timezone.set`,
  `server.ntp.set` (and deploy/lifecycle/stop/ping) via `src/instance/commands/`.
  `environment.lifecycle` is non-destructive `compose start|stop|restart`
  (volumes, deployment dir, and hosting Caddy sites untouched). Timezone
  / NTP apply through Ansible role `time-sync` + playbook `time-sync-apply.yml`
  (`runTimeSyncApply`); contracts in `contracts.ts` must match the instance
  canonical `server.timezone.set` / `server.ntp.set` shapes. **`server.wireguard.apply`**
  applies org VPN meshes via the `wireguard` role + `wireguard-apply.yml`
  (`runWireguardApply` in `src/orchestration/ansible.ts`); interface private keys
  and decrypted peer preshared keys live under `<daemonStateDir>/wireguard/` at
  mode `0600` (PSK files under `psk/`, deleted after apply) and never appear in
  Ansible `-e` extra-vars or leave the host. **`server.fabric.reconcile`**
  (TurboFabric) is additive and opt-in: `enabled: false` is a successful no-op
  (no `tp0`, no key, no WireGuard requirement). When enabled, the daemon
  ensures interface `tp0`, persists the private key at
  `<daemonStateDir>/network/wireguard/private.key` (mode `0600`, via
  `fabricNetworkDir`), syncs peers with `wg syncconf`, creates listed Docker
  routed-bridge networks, and hangs a `TP-FORWARD` chain off `DOCKER-USER`.
  **`environment.deploy`** may carry
  `traditionalWebSites[]` for host-native nginx/Apache/OpenLiteSpeed sites
  (compose `serviceKind: traditional-web`); engines are vendored under
  `/opt/turbopanel/vendor/{nginx,apache,openlitespeed}` and Apache PHP via
  vendored php-fpm under `/opt/turbopanel/vendor/php/` — see
  `src/deploy/AGENTS.md` and `orchestration/AGENTS.md`.
  Secret values never land in durable `compose.yaml`: the daemon writes
  Compose standalone secret files under `/run/turbopanel/deployments/…/secrets/`
  and a non-secret `.env` next to `compose.yaml`. After JWT, it rehydrates
  those `/run` files (`POST /api/daemon/v1/deployments/secrets/rehydrate` then
  `/secrets/decrypt`) and `compose up -d`. `environment.deploy` `storageMaterial[]`
  is location-aware: host paths are
  `<stateDir>/storage/<orgId>/<storageId>/<locationId>/data`. Overlay mounts come
  from each entry's `mounts[]`. TurboFabric `server.fabric.reconcile` still
  carries `networks: [{ name, subnet }]` — the Postgres table is `segment`
  (renamed from `bridge`); the wire payload is unchanged.

## Subsystem docs (nested `AGENTS.md`)

Large subsystems live in focused `AGENTS.md` files next to their code — Cursor loads the nearest one automatically when you work in that directory. **Read the matching file before editing that area.** This root keeps the foundational path model + conventions; the detail moved to:

| Subsystem | Read before editing | Covers |
|---|---|---|
| **Instance client** | `src/instance/AGENTS.md` | WSS / Unix-socket connection, idle presence + heartbeats (`timeSync`/`addresses`), reconnect / parked backoff, JWKS JWT verification, daemon TLS trust model |
| **Host metrics (collector)** | `src/metrics/AGENTS.md` | `/proc`-based collection + scheduling, `POST /api/daemon/v1/metrics`, 20-metric contract |
| **Tenant deploy & hosting ingress** | `src/deploy/AGENTS.md` | `environment.deploy` / `.lifecycle` / `.stop`, Docker Compose + Traefik, hosting Caddy, TLS materialization |
| **Managed engines (daemon runtime)** | `src/managed/AGENTS.md` | `managed.apply` / `.lifecycle` / `.destroy`, `managed.ingress.reconcile` (shared ProxySQL `turbopanel-proxysql` on network `turbopanel-managed`), engine registry (Postgres first); separate from tenant deploy |
| **Installer presentation** | `src/orchestration/AGENTS.md` | Installer presenter + sanitizer / vocabulary map for `run.sh` install & converge |
| **ClickHouse (analytics)** | `orchestration/AGENTS.md` | `clickhouse` Ansible role (Docker), idle-CPU tuning, app-user grants, dev-only Tabix GUI |
| **Time sync (Ansible)** | `orchestration/AGENTS.md` | `time-sync` role + `time-sync-apply.yml` (NTP / timezone) |

Ansible playbooks/roles live under `orchestration/`; runtime TypeScript under `src/`.
