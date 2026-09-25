# AGENTS.md

TurboPanel **daemon** — Ansible-driven host daemon; connects to the instance over
HTTPS/WSS (or Unix socket when co-located).

## Documentation discipline

**Keep this file current.** When you learn something durable about daemon ↔
instance contracts — WS presence, reconnect behavior, command handlers,
orchestration — add or update a note here in the same PR/session as the code
change. Cross-repo cell/cost rules live in `../turbopanel/AGENTS.md` (Daemon Cell
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
  every existing Deno test file in this repo and `../turbopanel`.

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
`TURBOPANEL_DAEMON_STATE_DIR`, `TURBOPANEL_LOG_DIR`, `TURBOPANEL_BACKUP_DIR`,
`TURBOPANEL_RUN_DIR`, `TURBOPANEL_RUNTIMES_DIR`, `TURBOPANEL_DAEMON_ROOT`,
`TURBOPANEL_PRINCIPAL_HOME_ROOT`).
`src/orchestration/assets.ts` and `src/instance/sockets.ts` derive their constants
from `resolveLayout` — do **not** hardcode absolute paths in runtime code;
add/extend a layout field instead. The development default checkout root is
`<devRoot>/turbopaneld` (from `TURBOPANEL_DEV_ROOT` / `$HOME`); production runtime
code must never name the retired `/opt/turbopanel/platform` token — the layout
module and CI guard are the only places allowed to reference it.

**Production (managed / FHS)** — compiled release, no source checkout. The daemon runs as **`tp:tp`** (UID/GID 9999); per-service accounts (`tpctrl`, `tpcache`, `tpdata`, `tpqueue`, `tpcaddy`) are listed in **`../turbopanel/AGENTS.md`** (Production UID/GID allocation):

| Purpose                                                           | Path                                  |
| ----------------------------------------------------------------- | ------------------------------------- |
| Native daemon binary                                              | `/opt/turbopanel/bin/turbopaneld`     |
| Deno JS runtime (`turbopaneld.js`; page-size-incompatible hosts)  | `/opt/turbopanel/bin/turbopaneld.js`  |
| Orchestration assets (Ansible)                                    | `/opt/turbopanel/share/orchestration` |
| Static UI export                                                  | `/opt/turbopanel/share/ui`            |
| Vendored runtimes (node/deno/caddy/uv/python/ansible/cloudflared) | `/opt/turbopanel/vendor`              |
| Daemon install root (`daemonRootDefault`)                         | `/opt/turbopanel/lib/daemon`          |
| Config (`daemon.env`, `instance-ca.pem` — **Platform CA** bundle fetched from the control plane; no Organization CA material is ever stored there) | `/etc/turbopanel`                     |
| Persistent identity (license, `server.id`, keys, tunnels)         | `/var/lib/turbopanel`                 |
| Tenant principal homes (`principalHomeRoot`)                      | `/srv/users/<username>`               |
| Logs                                                              | `/var/log/turbopanel`                 |
| Managed-engine backups (`backupDir`, one subdir per `managedId`)   | `/backup`                             |
| Runtime (sockets, `daemon.lock`)                                  | `/run/turbopanel`                     |

`backupDir` is deliberately **outside** the FHS state tree and carries the same
`/backup` default in development and production: backups are the one artifact
an operator is expected to point at other storage (a second disk, a NAS mount,
an attached volume), so `TURBOPANEL_BACKUP_DIR` repoints them without moving
anything else. Artifacts live at `<backupDir>/<managedId>/` (`managed/engine-paths.ts`'s
`managedBackupsDir`), written 0600 by the daemon user itself. Repointing the
override affects **new** backups only — nothing relocates an existing tree —
and `managed.destroy` still removes an engine's backup directory along with its
state dir, so destroying an engine never leaves an orphan tree on that storage.

The **host** allocates UID/GID via `useradd`/`groupadd` from **15001–60000**
(`-K` on that one command; `/etc/login.defs` is not edited). The control plane
may send an optional operator override, which must be ≥ **15001** and clear
the `tp*` service band **9989–9999**. Homes are keyed on the username. Override
the home root with
`TURBOPANEL_PRINCIPAL_HOME_ROOT` (`layout.principalHomeRoot`). **Platform CA**
vs **Organization CA** (two-CA distinction):
`../turbopanel/src/lib/tls/AGENTS.md`.

**Development (co-located checkout)** — `./console` from
[TurboPanel/dev](https://github.com/TurboPanel/dev) runs the daemon from source
(`deno run main.ts`); all mutable paths are **dev-user-owned**:

| Purpose                          | Path                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| Daemon checkout / install root   | `<TURBOPANEL_DEV_ROOT or $HOME>/turbopaneld`                                            |
| Orchestration assets             | `<checkout>/orchestration` (prod roles); overlay in `<dev checkout>/orchestration` |
| Vendored runtimes                | `/opt/turbopanel/vendor`                                                           |
| Daemon env file                  | `/etc/turbopanel/daemon.env`                                                       |
| Daemon state                     | `/var/lib/turbopanel`                                                              |
| Logs                             | `/var/log/turbopanel`                                                              |
| Managed-engine backups           | `/backup`                                                                          |
| Config dir                       | `/etc/turbopanel`                                                                  |
| Runtime (sockets, `daemon.lock`) | `/run/turbopanel`                                                                  |

**Development identity:** co-located dev creates **no** dedicated `tp`,
`tpctrl`, or `tpcache` service accounts. The
`turbopaneld`, instance, UI, and Caddy systemd units, plus Docker-backed
services (Postgres and RabbitMQ consolidated under the single
`turbopanel-system-stack` Compose stack — see
`orchestration/roles/system-compose/AGENTS.md` — plus standalone Redis and Mailpit), all run as
the **current dev user**. The optional Stripe CLI forwarder
(`orchestration/roles/stripe-listen`, unit `turbopanel-stripe-listen`,
extra-var `turbopanel_optional_stripe_listen`, off by default) is dev-only
too: it vendors the pinned `stripe` binary under `vendor/stripe-cli/` and keeps
the hand-supplied test key and the CLI's forwarding secret in
`/etc/turbopanel/stripe-listen/stripe.env` (seeded once, never re-templated).
The instance unit does **not** load that file: billing exists only in the
Workers build, a self-hosted Deno instance has no billing surface and must
never see a Stripe key, and a `wrangler dev` instance takes its secrets from
`.dev.vars`. Production managed installs keep the dedicated
service users `tp`, `tpctrl`, `tpcache`, `tpdata`, `tpqueue`, and
`tpcaddy` — see **`../turbopanel/AGENTS.md`** (Production UID/GID allocation).

**Deno version pin:** `DENO_VERSION` (`src/orchestration/assets.ts`) =
**`2.9.7`**. Keep it in step with `deno_version` in
`orchestration/roles/deno-runtime/defaults/main.yml`, `TP_DENO_VERSION` in
`scripts/run.sh`, and `DENO_VERSION` in
[TurboPanel/dev](https://github.com/TurboPanel/dev) `src/lib/paths.ts` (dev
console bootstrap fallback + status label). `src/orchestration/assets.test.ts`
pins the const to the role default. Bumping the pin is a fleet-wide rollout:
`deno-runtime` runs on the install/converge path (`daemon-install.yml`,
`daemon-converge.yml`) and on the instance-launch refresh path
(`instance-launch-only.yml`, ahead of `instance-launch`), because instance and
mailer units ExecStart through the vendored Deno path — it is not only the
daemon's JS-fallback concern. `src/orchestration/assets.test.ts` pins that
ordering too.

## Versions on the wires

Two-way peer support. The control plane holds `daemonBuild.version` against
`MIN_SUPPORTED_DAEMON_VERSION` (`turbopanel/src/lib/version-wire.ts`) and keeps
an unsupported daemon connected while refusing its command dispatches. This
daemon holds the control plane's version against
`MIN_SUPPORTED_INSTANCE_VERSION` in `src/instance/version-wire.ts`.

Capture points: `x-turbopanel-version` on every `DaemonApiClient` response,
including non-OK responses and the 401 that precedes a session refresh
(enrollment, session, JWKS, and later calls — before cell traffic), and the
attach acknowledgement `{ type: "version", instanceVersion }` on
`/ws/daemon/v1` for a socket-only session. A response or attach frame that
omits the version is the current peer: the daemon clears the last observation
back to `unknown`. `InstanceClient.connectionState` exposes the resolved
status. `unknown` (no header and no field) passes silently. `unsupported`
logs once, greppable as `instance-version: … flagged — the daemon keeps
reconnecting`, and does **not** close the socket or stop retrying. It is a
flag, not a park.

Each floor tolerates every peer semver at or above the constant. Today both
floors are **`0.1.0`** against package **`0.1.1`**, so a `0.1.x` peer is in
window and a `0.0.x` peer is not. The window may trail the current release by
several minor versions. There is no fixed upgrade order. Bump
`MIN_SUPPORTED_DAEMON_VERSION` and `MIN_SUPPORTED_INSTANCE_VERSION` together,
in the same change, and record why in this section and in
`turbopanel/AGENTS.md` → Versions on the wires. Never raise either floor
silently. A release that introduces a new wire message leaves both floors
where they are. Each new message is feature-gated: the peer advertises
support in `features[]` (`DAEMON_WIRE_FEATURES`, kept equal in both
`version-wire.ts` files) and the daemon checks `InstanceClient.instanceSupports()`
before treating the peer as able to speak it. `update-progress`
(`update-progress-v1`) is the worked example — fire-and-forget progress,
ignored by a peer that does not list the feature. A control-plane update the daemon is about to install is refused
when the target version is below `MIN_SUPPORTED_INSTANCE_VERSION`; the
daemon's own self-update does not consult that floor, and the control plane
does not gate `instance-update` on the daemon version.

`DAEMON_FEATURE_MIN_VERSIONS` (kept equal in both `version-wire.ts` files) is
the peer-version feature gate — not the metrics hardware-profile capability
plan. A panel-visible admin feature that depends on a daemon-rendered artifact
adds an entry here. The UI phase calls `resolveDaemonCapabilities` and does
not re-implement semver comparison. An unknown peer version is not supported
for a feature. The first entry is `instance-cert-sources-per-hostname` at
daemon **`0.1.1`**, the release that renders per-hostname certificate sources
in `orchestration/roles/instance-launch/templates/Caddyfile.j2`. Operational detail:
`src/instance/AGENTS.md`.

**Vendored Node/Deno layout:** Ansible roles install pinned runtimes under
`/opt/turbopanel/vendor/<tool>/<version>/` with a `current` symlink (see
`node-runtime`, `deno-runtime`, `caddy`). Consumers resolve `turbopanel_node`
(`…/node/current/bin/node`), `turbopanel_deno` (`…/deno/current/deno`), and
`turbopanel_runtime_path` (colon-separated PATH prefix for systemd/Ansible
tasks). Node **26.7.0** is pinned in `node-runtime/defaults/main.yml` — keep in
step with `NODE_VERSION` in [TurboPanel/dev](https://github.com/TurboPanel/dev)
`scripts/lib/paths.sh`. Node 25+ no longer ships Corepack; the `node-runtime`
role installs it with vendored `npm install -g corepack` into the versioned
prefix, then `corepack enable pnpm`. The vendored runtime root is defined once in
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
postgres|rabbitmq setup), so fresh daemon installs and pre-Docker
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

**Upstream licenses:** Ansible Core, `ansible-lint`, the `ansible.posix`
collection, the `geerlingguy.docker` Galaxy role, and any packages these
playbooks install remain under their upstream licenses (pins in
`orchestration/requirements.txt` (constraints),
`orchestration/requirements.lock.txt` (CI hash lock),
`orchestration/requirements.yml`, and `orchestration/requirements-docker.yml`). Installing them on a host is a
different licensing event from redistributing them. Any TurboPanel-published
appliance, VM/OCI image, or offline bundle that ships copies must carry the
applicable upstream license, copyright, notice, and source-compliance
material. Canonical copy of this boundary: `orchestration/AGENTS.md`.

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
The [dev](https://github.com/TurboPanel/dev) console threads this as
`installDevEnvironment(..., mode)` with `mode: "if-needed" | "force"` —
`"if-needed"` only for the post-daemon-install chain; `"force"` (and
`TURBOPANEL_FORCE_CONVERGE=1`) for Developer → Converge / re-converge and
legacy reset/provisioner callers. Optional co-located tooling arrives as
**one** structured payload — `TURBOPANEL_DEV_CONVERGE_OPTIONS`, JSON
`{ "optionalServices": { "<stem>": bool } }` keyed by Ansible stem, built from
the dev console's single catalog (`dev/src/lib/optional-dev-services.ts`).
`src/orchestration/dev-converge-options.ts` parses it once per
`instance-dev-install` and emits a single `-e '{"turbopanel_optional_<stem>": …}'`
extra-vars object; the same normalised payload is folded into the converge
stamp. No payload means no optional extra-vars (playbook `vars:` and role
`| default()` filters decide). Drizzle Studio, Mailpit, Expo UI, website, and
Redis Insight start only when selected; units are still installed so the TUI
can enable them later.

## Project metadata

GitHub repository:
[TurboPanel/turbopaneld](https://github.com/TurboPanel/turbopaneld). Deno
package name: `turbopaneld` (`deno.json`), aligned with the repo slug and the
compiled `/opt/turbopanel/bin/turbopaneld` binary.

**Public naming:** **TurboPanel Daemon** → [TurboPanel/turbopaneld](https://github.com/TurboPanel/turbopaneld); internal term `daemon`. **License:** AGPL-3.0-only ([`LICENSE`](./LICENSE), `deno.json`). Trademarks are not granted by the software license ([`TRADEMARKS.md`](./TRADEMARKS.md)). Third-party components keep their own licenses ([`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)); release packaging stages that file at `opt/turbopanel/share/THIRD_PARTY_NOTICES.md`. Published story: `../website` `/open-source` and `docs/getting-started/licensing.mdx`. Contributions require the [CLA](https://github.com/TurboPanel/.github/blob/trunk/CLA.md). **Maturity:** **Private alpha**. README is product-facing; AGENTS.md is maintainer-facing.

**Host-base prerequisite boundary:** TurboPanel-managed vendors (uv, Python,
Ansible venv, Deno, Node, Caddy, Redis, cloudflared) install under `vendor` via
orchestration bootstrap — not via apt in `run.sh`. The minimal host-base set is
**sudo, curl, ca-certificates, tar, python3-minimal** (`run.sh` may apt-install
these only when absent). `python3-minimal` extracts Deno release zips without
apt `unzip`. The `daemon-prereqs` role covers the broader managed-host set (git,
gnupg, pamtester, xz-utils, iptables, …) once Ansible can converge, and
**removes the distribution firewall front-ends** — ufw, firewalld,
iptables-persistent/netfilter-persistent purged, nftables.service disabled — on
every converge of every host (`tasks/firewall-takeover.yml`; TurboPanel owns
the host firewall, decided 2026-09-20; every step moves the kernel toward
ACCEPT so it cannot lock a host out); Redis is vendored by
extracting the official `packages.redis.io` `.deb` with `dpkg-deb -x` (no
compile toolchain).

**Guards / tests:**

- `deno task check:layout` (`scripts/check-production-layout.ts`) — asserts the
  production FHS tree resolves to the canonical absolute paths and that no
  production source (`src/**`, excluding `*.test.ts` and `src/paths/layout.ts`)
  references `/opt/turbopanel/platform` or the retired `share/ansible`. Wired
  into `publish-daemon-trunk.yml`.
- `deno task check:metrics-legacy` (`scripts/check-metrics-legacy.ts`) — fails
  on any ClickHouse/Tabix reference outside the managed-engine allowlist (the
  metrics store is DuckDB + Parquet / Analytics Engine); scans this repo plus
  the co-located `turbopanel`/`dev`/`ui` `src` trees when present.
- `deno task test` / `test:coverage` / `lint` / `fmt:check` / `check` / `notices:check` — quality
  surface in `deno.json`. `notices:generate` writes `THIRD_PARTY_NOTICES.md` from
  `deno.lock`, `workers/turbopanel-sh/pnpm-lock.yaml`, and orchestration pins
  (GPL-3.0-or-later Ansible tooling is a reviewed orchestration exception).
  Release packaging stages that file at `opt/turbopanel/share/THIRD_PARTY_NOTICES.md`.
  `tp_install_verified_channel_release` copies the verified notice into
  `/opt/turbopanel/share/THIRD_PARTY_NOTICES.md` on install/update.
  The `test` task grants `-A` at the process level on
  purpose: Deno's per-test `permissions` option can only *reduce* from the
  process grant, so a narrower task grant would silently break
  `src/commands/ping.test.ts` (`sys: ["hostname"]`),
  `src/commands/stop-environment.test.ts` (`run: true`), and the
  twelve `permissions:` blocks in `src/instance/client.test.ts`. **Do not
  weaken or remove any existing per-test `permissions` block.** A scoped
  `run: ["cmd"]` cannot inherit `LD_*` / `DYLD_*` (Deno 2.9 `NotCapable`);
  CI `actions/setup-python` exports `LD_LIBRARY_PATH` before
  `test:coverage`, so those `Deno.Command` spawns must `clearEnv: true` (or
  otherwise unset the vars). Unscoped `run: true` / process `-A` is fine.
  Coverage writes `coverage/lcov.info` (gitignored; already in Sonar / layout
  `SKIP_DIRS`).
- **SonarCloud coverage (CI):** `.github/workflows/verify.yml` runs
  `deno task test:coverage` then uploads LCOV via
  `sonar.javascript.lcov.reportPaths=coverage/lcov.info` (CI-based analysis;
  Automatic Analysis must stay **off** for `turbopanel_turbopaneld`). Deno may
  emit absolute `SF:/home/runner/work/...` paths on Actions; verify.yml strips
  the checkout prefix to repo-relative `SF:src/...` before upload. The
  project uses the built-in **Sonar way** quality gate, which fails when
  **coverage on new code is below 80%** (`new_coverage` LT 80); the scan waits
  on the gate (`sonar.qualitygate.wait=true`). Same-repo PRs and trunk
  **require** `SONAR_TOKEN` (hard fail); fork PRs skip the scan so fmt/lint/tests
  still gate. Quality gate failure fails verify (and therefore trunk
  `publish`, which `needs: verify`). After switching from Automatic Analysis,
  reset **New Code** (Administration → New Code) so the baseline is not months
  of uncovered history. Sibling `turbopanel` / `ui` also use CI-based analysis;
  `website` still uses Automatic Analysis. Coverage exclusions include
  `**/*.test.ts`, `src/testing/**`, `src/build-info.ts`, `dist/**`,
  `publish/**`, the Galaxy Docker role tree, and `workers/**`.
  **`sonar.sources` / `sonar.tests` / `sonar.test.inclusions`** must stay set
  (`src` + `orchestration` + `scripts` + `main.ts`; tests = `**/*.test.ts` and
  `src/testing/**`). The `denoS2187` issue-ignore (`typescript:S2187` on
  `**/*.test.ts`) remains — LCOV import does not replace that false-positive
  suppression.
- `src/orchestration/assets.test.ts` — production/dev default trees, env
  overrides, and the `DENO_VERSION` ↔ role pin
  (`deno test src/orchestration/assets.test.ts`).
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

Local commands: **`deno task verify:ci`** is the guest mirror of `verify.yml`
minus the Sonar upload: `verify:static` (`fmt:check`, `lint`, `check`,
`check:layout`, `check:vocabulary`, `check:metrics-legacy`) then
`notices:check`, `check:orchestration` (needs `ansible-playbook` /
`ansible-lint` on PATH — prepend `/opt/turbopanel/vendor/ansible/current/bin`
in the guest), and **`test:coverage`** (the LCOV Sonar imports).
**`deno task verify`** is the faster host-runnable cousin (`test` instead of
`test:coverage`, no orchestration). `deno task verify:static` alone is the
offline sanity pass. Fleet-wide from the host `dev` checkout:
`./scripts/ci-verify.sh` (re-execs via `vagrant ssh`). Individual tasks
(`test`, `test:coverage`, `fmt:check`, `lint`, `check`, `check:layout`,
`check:vocabulary`) remain available. See **Guards / tests** above for the
`-A` grant, per-test `permissions:` rule, and Sonar-way **80% new-code** floor.

**Test style:** use the mandatory `const test = Deno.test.bind(Deno);` alias and
`new TypeError()` for shape assertions — both under TypeScript style
(SonarQube) above; do not restate them here.

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
(CI has ansible-core from pip and no vendor tree), the script installs the pin
from `orchestration/requirements.yml` (not `requirements-docker.yml`). Rules that
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

**Where to run tests:** host VirtFS checkouts lack a usable Deno tree. Run
suites **inside the Vagrant guest** from the host `dev` checkout:

```bash
vagrant ssh -c 'export PATH="/opt/turbopanel/vendor/deno/current:$PATH"; cd ~/turbopaneld && deno task test'
```

Interactive `vagrant ssh` then `cd ~/turbopaneld` also works. Canonical
detail: `../dev/AGENTS.md` → Testing. Do not run `deno task test` on the
host.

**Editor:** this repo has no `tsconfig.json`. Folder `.vscode/settings.json`
sets `deno.enable`, Deno as the default formatter for TS/JS/JSON, and
format-on-save so `deno fmt` matches CI before a commit. It also turns off
the built-in TypeScript/JavaScript validators so Cursor/VS Code does not
report `Cannot find name 'Deno'` / missing `@std/*` on Deno sources. Install
**Deno** (`denoland.vscode-deno`); the sibling `dev` folder keeps
`deno.enable: false` (Node console). Typecheck with `deno task check` /
`deno task test`, not `tsc`.

**Pre-commit** (`.githooks/pre-commit`): `scripts/scan-secrets.sh` is never
skippable. The hook then runs `deno fmt` and restages files already in the
commit so the index cannot stay unformatted, followed by the **offline static
gates from `verify.yml`, in CI order**: `deno lint`, `deno task check:layout`,
`deno task check:vocabulary`. Those three are whole-tree scans (not
staged-diff scans) and finish in ~1s together — they exist here because a new
file that hardcodes a layout path or uses retired phrasing is otherwise only
caught minutes into a PR run, which was the single most common cause of a red
`verify` on an otherwise-good change. Deno resolution is pin-aware and delegated to
`../dev/scripts/lib/hook-toolchain.sh` (`tp_hook_ensure_deno_toolchain`), so the
hook, `./console` and CI all run the one pinned release: the pinned
`/opt/turbopanel/vendor/deno/<DENO_VERSION>/deno` wins;
`vendor/deno/current` is used only once it resolves to that pin (the hook
relinks it where it can write, and otherwise runs the versioned binary
directly); an absent pin is fetched from `dl.deno.land` when `curl` + `python3`
are present; a PATH Deno is a last resort, never the default — `deno fmt` /
`lint` output differs between releases, so a stale host Deno reformats the tree
the pinned CI runner then rejects. When none of that yields a pinned Deno the
hook falls back to `vagrant ssh -c '… cd ~/turbopaneld && deno <args>'` from the
sibling `dev` checkout (same guest command as Testing below). Resolution is
memoized across the four guards, and `tp_precommit_deno_exec` propagates the
exit status, so a failing guard aborts the commit. Typecheck and
the suites stay deferred to `deno task verify` / CI. Set
`TURBOPANEL_SKIP_HOOK_TESTS=1` to skip fmt **and** the guards (secret scan still
runs; CI still gates all of them). The dev console’s daemon install
(`cloneOrUpdateRepo` in `../dev/src/lib/platform-install.ts`) sets
`core.hooksPath=.githooks` after a successful clone or update when
`.githooks/pre-commit` exists. Production `scripts/run.sh` never wires hooks.

**Shared test helpers:** new tests must consume the helpers in `src/testing/`
(`fake-websocket.ts`, `fake-clock.ts`, `temp-layout.ts`, `fake-instance-api.ts`,
`jwks-test-helpers.ts`, re-exported from `src/testing/index.ts`) instead of
hand-rolled doubles. `src/testing/**` is test-only and must never be imported
from production code.

**Gate matrix** (one policy with the dev repo):

| Stage | dev | daemon | Rationale |
| ----- | --- | ------ | --------- |
| pre-commit | scan-secrets only (tests deferred) | scan-secrets + `deno fmt` + `lint` + `check:layout` + `check:vocabulary` (typecheck/tests deferred) | secret scan always; daemon fmt/guards via the pinned Deno or `vagrant ssh`; the cheap half of `verify.yml` runs in ~1s so contract breaks never reach CI; suites in CI / guest |
| PR → `trunk` | `verify.yml` | `verify.yml` | blocks merge |
| push `trunk` | `verify.yml` | `verify.yml`; `publish` job `needs: verify` → the `trunk` CDN drop **and** the rolling GitHub `canary` pre-release (`canary` job, via `TurboPanel/dev` `gh-canary.yml`) | nothing compiles from failing code |
| promote → rc/release | n/a | **artifact integrity only** (re-download + sha256/size against the release's manifest) | no new code enters after publish |

## Managed-host privilege boundary (2026-09-19 hardening)

Six controls, each with a test that fails the build when it regresses:

- **Deno grants** — `src/permissions/daemon-permissions.ts` is the one definition of what
  the production daemon may read/write/run; `renderDaemonPermissionFlags()`
  is copied verbatim into the three `compile*` tasks in `deno.json` and the
  JS-fallback `ExecStart` in `daemon-launch/templates/turbopaneld.service.j2`,
  and `renderInstallerPermissionFlags()` into `TP_INSTALLER_DENO_PERMISSIONS`
  in `scripts/run.sh` (the root-run `bootstrap-orchestration` /
  `run-installer` verbs). `src/permissions/daemon-permissions.test.ts` pins every copy,
  refuses `--allow-all` and any bare `--allow-read/write/run/ffi/sys`, and
  derives the `--allow-run` set from every literal `Deno.Command` / `run(…)`
  target in `src/` — add a new spawn target there or the test fails. The
  compiled binary is also the **installer**: `run.sh` runs the root-only
  `bootstrap-orchestration` / `run-installer` verbs through it on hosts where
  it executes, and `deno compile` bakes one grant set the binary cannot widen
  at runtime (the JS fallback gets `renderInstallerPermissionFlags()`; the
  native binary cannot). The daemon write grant therefore also carries
  `INSTALLER_VENDOR_DIRS` (`vendor/uv`, `vendor/python`, `vendor/ansible`) —
  inert at daemon runtime because those trees are `root:tp 0750` and the
  process is `tp` — and the test maps every orchestration bootstrap write
  target (`UV_INSTALL_DIR`, `PYTHON_RUNTIME_DIR`, `ANSIBLE_INSTALL_DIR`, the
  Galaxy dirs, the stamps) onto that grant, which is what the first canary
  install after this hardening tripped over (`Requires write access to
  "/opt/turbopanel/vendor/uv/<version>"`). Two
  grants stay unscoped and are documented as `DAEMON_UNSCOPED_GRANTS`:
  `--allow-net` (operator-configured control-plane origin, ACME probes to
  tenant domains, container-address scrapes, ProxySQL bind — Deno has no
  wildcard/CIDR host grant) paired with `--deny-net` for the cloud metadata
  endpoints, and `--allow-env` (`Deno.env.toObject()` needs it). Bumping
  `UV_VERSION` / `ANSIBLE_CORE_VERSION` / `CLOUDFLARED_VERSION` changes the
  rendered `--allow-run` paths: re-render (see the test failure) and commit
  all copies. NVML is opened by absolute path first (`NVML_LIBRARY_CANDIDATES`)
  because a scoped `--allow-ffi` resolves bare names against the cwd.
- **Two writes `--allow-write` never covers** — `src/permissions/scoped-writes.ts`.
  Deno refuses *every* write (`writeFile`, `copyFile`, `chmod`, `rename`,
  `remove`) to a path on the **`--allow-run`** allowlist, so uv, uvx, and
  cloudflared — run targets that the binary-as-installer also has to install —
  go through `installVendorExecutable` (`cp` + `chmod`). And **`Deno.symlink()`
  requires *unscoped* read and write**: a link's target is only resolved on
  traversal, so no path-scoped grant covers it however wide, and every
  `current` link — vendor runtimes, release promote, railpack, hosting Caddy —
  goes through `createSymlink` (`ln -sfn`). Neither is reported at compile
  time: the first broke the first canary install after this hardening, the
  second silently skipped every vendor `current` symlink on the same run.
  `cp` / `chmod` / `ln` are therefore on both run allowlists, and
  `src/permissions/scoped-writes.test.ts` reproduces both refusals in a child process with
  production-shaped grants and fails on a new `Deno.symlink(` anywhere in
  `src/`. A helper that fails throws **`ScopedWriteError`**, which is the
  subprocess counterpart of `PermissionDenied`: privilege ladders that retry
  under `sudo` (`release/promote.ts`) must treat both as "the unprivileged
  attempt could not do it" — `Deno.symlink`'s own refusal is `NotCapable`, so
  catching `PermissionDenied` alone silently skipped the sudo tier.
- **Install root ownership** — `/opt/turbopanel`, `bin/`, `lib/`, `share/`,
  `share/orchestration` and every vendored runtime are `root:tp 0750`
  (`turbopanel-user`, `daemon-layout`); `daemon-install.yml` no longer chowns
  the vendor or orchestration trees to `tp`. The daemon can write only
  `DAEMON_WRITABLE_VENDOR_DIRS` (`vendor/uv/cache`, `vendor/cloudflared`) plus
  the FHS state/config/log/run/backup trees — ownership, not the Deno grant,
  is the boundary here (the grant also names `INSTALLER_VENDOR_DIRS` for the
  root-run install verbs, see above); `turbopanel_daemon_vendor_cache_dirs`
  mirrors the chowned list and `src/orchestration/sudoers-contract.test.ts`
  pins the two together. `tp`'s home is `/var/lib/turbopanel`, and the JS unit sets
  `DENO_DIR` under it. `repointUvCurrent` & co. are no-ops when the root-owned
  `current` symlink is already right; `ensurePython` skips uv when the pinned
  interpreter is present.
- **sudo** — `roles/turbopanel-user/templates/sudoers.j2` replaces
  `NOPASSWD:ALL`: absolute-path `Cmnd_Alias` groups for the host utilities the
  deploy code invokes through `sudo -n`, `(tp) NOPASSWD: ALL` for the
  self re-exec pattern, engine config validation as the engine service users,
  and **`tp-orchestrate`** (`orchestration/scripts/tp-orchestrate`, POSIX sh,
  `root:tp 0750`). Ansible `become` from `tp` would need `sudo /bin/sh`, so on
  managed hosts `runPlaybookStreaming` routes through
  `sudo -n tp-orchestrate playbook …` (`src/orchestration/privileged.ts`):
  the helper accepts only `-i localhost, -c local`, `-e key=value` and one
  shipped playbook **basename** resolved under the root-owned tree, rebuilds
  PATH/ANSIBLE_* itself, and keeps Ansible's temp/home in a root-only
  `/tmp/turbopanel-orchestrate`. `galaxy-docker-role` fetches the pinned
  geerlingguy.docker role into the root-owned roles dir; `update` fetches
  `run.sh` (CDN, or an HTTPS overlay host with the canonical
  Platform CA — never `-k`) and runs it with re-validated flags, which is how
  panel-driven daemon updates work now (`executeRunReconcile` →
  `rootHelperReconcileInvocation`; the daemon never hands root a script body).
  **`tp-update-guard`** (`orchestration/scripts/tp-update-guard`, POSIX sh,
  `root:tp 0750`) is installed with `turbopaneld-update-guard.service` /
  `.timer` and runs only as **root** via `OnFailure=` and the one-shot timer
  after a daemon self-update — not through `sudo` and not from the `tp` user.
  `daemon-launch` also copies it to `/opt/turbopanel/lib/tp-update-guard`, and
  the unit's `ExecStart` is that path, so restoring an older orchestration
  tree cannot remove the only executable the timer can run.
  The control plane is a separate verb, `sudo -n tp-orchestrate update-instance
  --channel canary|rc|release [--manifest-url …] --no-start`
  (`rootHelperInstanceUpdateInvocation`). It takes no license, host, overlay,
  or Platform CA. `--manifest-url` is passed to `run.sh` as
  `--instance-manifest-url` so it does not set `TURBOPANEL_MANIFEST_URL` (that
  pin is the daemon package). `trunk` and `edge` are refused: the instance and
  UI packages publish only through GitHub Releases. `--no-start` is required;
  the daemon restarts `turbopanel-instance` and `turbopanel-caddy` after a
  successful install and does not restart itself. Before the helper runs, the
  daemon refuses a target below `MIN_SUPPORTED_INSTANCE_VERSION`. A missing
  or non-semver target is unknown and is allowed. The control plane accepts
  `instance-update` from any connected daemon. Daemon self-update does not
  consult the instance floor. Detail: `src/instance/AGENTS.md` (Managed updates).
  Root (`run-installer`) and co-located dev run `ansible-playbook` directly.
  Tests: `src/orchestration/tp-orchestrate.test.ts`, `privileged.test.ts`,
  `sudoers-contract.test.ts`.
- **Signed manifests** — `src/update/signing.ts`: every production channel
  manifest carries an Ed25519 `signature` over its canonical JSON (sorted
  keys, compact, `signature` removed). `generate-channel-manifest.ts` signs
  with `RELEASE_SIGNING_KEY` (PKCS#8 PEM; the CI secret) and **refuses to
  write an unsigned manifest**. The public key is pinned twice —
  `RELEASE_SIGNING_PUBLIC_KEY_HEX` and `TP_RELEASE_SIGNING_PUBLIC_KEY` in
  `run.sh` (`signing.test.ts` pins them together, and byte-compares Deno's
  canonicaliser with run.sh's python3 one). `resolveUpdate` verifies **before
  parsing** for any production install; run.sh verifies before any artifact
  download (`tp_verify_manifest_signature`, openssl `pkeyutl -rawin`). The
  only bypass is development-side and host-side: a source checkout
  (development install mode), or a `--dl-base` overlay host whose
  `daemon.env` carries `TURBOPANEL_DEV_ALLOW_UNSIGNED_MANIFEST=1`
  (`daemon-config/dotenv.j2` writes it for overlay installs only). The
  built-in rail and `TURBOPANEL_MANIFEST_URL` pins always verify. Instance/UI
  repo manifests (`--instance` installs) are verified when signed and reported
  loudly when not — their release jobs do not sign yet.
- **Automatic-update TLS** — `resolveAutomaticUpdateTrust`
  (`src/instance/run-reconcile.ts`): public trust or the
  configured Platform CA file; otherwise `UpdateTrustRepairError` naming
  `--instance-ca`. `TURBOPANEL_RELEASE_TLS_INSECURE` and `--insecure-tls` are
  never consulted on that path (manual `run.sh` keeps the flag).
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
- **Deploy hooks** — `preDeployCommand` / `postDeployCommand` run **inside the
  service container** (`docker compose run --rm --no-deps -T --entrypoint sh`
  before `up`, `compose exec -T … sh -c` after), never via a host shell; the
  contract requires `confinement: "compose-service"` on any command-bearing
  hook and `deploy-environment.ts` refuses hooks naming a service the deploy
  does not run (`assertHooksConfined`). The control plane only emits hooks
  when the organization's owner enabled `deployHooksEnabled`
  (`PUT /organizations/:id/deploy-hooks`; `parseServiceOptions` drops the
  command fields otherwise).

## Uninstall script

`scripts/uninstall.sh` removes a TurboPanel install from a managed host. It
lives only in this repository: release packages do not ship it, and
`workers/turbopanel-sh` does not serve it.

Canonical command (root, no sudo re-exec):

```sh
curl -fsSL https://raw.githubusercontent.com/TurboPanel/turbopaneld/trunk/scripts/uninstall.sh | sudo sh
```

The script refuses to continue unless it is already root. It does not
re-execute itself under sudo. `--dry-run` is root-only as well and still
needs a controlling terminal; there is no non-interactive bypass.

Server-type detection (self-hosted control plane, a daemon enrolled with
TurboPanel High Availability, a daemon enrolled with some other control
plane, or leftovers from an older or partial install) only changes the
labels and warnings printed before the prompt. Every removal step runs
either way, so a partial install is cleared by the same path as a full one.

A development environment is refused before anything is changed:
`TURBOPANEL_MODE=development`, `TURBOPANEL_DEV_ROOT`, or `TURBOPANEL_DEV_USER`
in `daemon.env`, `/etc/sudoers.d/turbopanel-dev-nopasswd`,
`/etc/turbopanel/dev-forward-hosts`, or a `turbopaneld.service` `ExecStart`
that runs `main.ts`. The message points at `~/dev/console` → Developer →
**Reset development environment** / **Purge completely**.

Three maintenance rules:

1. A new host file that lives outside the FHS folders this script already
   deletes must use a `turbopanel-*` or `tp*` name the scan already matches,
   or be added to the script explicitly.
2. When a release renames or retires a unit, account, path, or container
   name, add the old name to the `TP_LEGACY_*` block at the top of
   `scripts/uninstall.sh`.
3. A role that installs apt packages or adds an apt repository must add
   those packages to the purge candidate list in `scripts/uninstall.sh`
   (`TP_PURGE_BASE_PACKAGES`, `TP_PURGE_APACHE_PACKAGES`, `TP_DOCKER_PACKAGES`,
   or the `php*` / `debsuryorg-archive-keyring` scan). A repository file has
   to be named there too, unless the Docker `download.docker.com` scan or the
   `sury-php.sources` / `sury-php.list` removal already matches it.

Option 1 stops at the remove-only steps. Option 2 runs those same steps,
then `tp_purge_hosted_data`. Detection still only changes labels; purge runs
for every server type. Each purge step checks what is actually present and is safe to run again
after an earlier run stopped partway. After confirmation, option 2 writes a
root-only marker and a resume manifest under `/var/lib/turbopanel-uninstall/`
(directory `0700`, files `0600`, never through a symlink). That directory is
outside the trees purge deletes. `--dry-run` does not write either file.
`tp_main` checks the marker before the empty-inventory exit, so a rerun
resumes purge when only apt packages or Docker data are left. Docker being
installed is not, by itself, a TurboPanel install. The manifest is loaded
from `tp_discover_paths` and restores discovered config, state, log, run,
backup, and principal-root paths, including overrides such as a custom
backup directory. Both files are removed only after purge finishes with no
recorded failures. Commands go through `tp_run`, so `--dry-run` logs them and
does not run them. Folder deletion uses `tp_safe_rm_tree` (unsafe paths,
symlink-only unlink, mount contents cleared and the mount kept). There is one
copy of that function.

Purge order:

1. **Principal users.** Accounts are found by home directory under each
   discovered principal home root (default `/srv/users`), whatever the UID,
   including when that root directory is already gone. Directory enumeration
   and deletion of the root run only when the path exists. Older installs
   used ids from 1000 (host-picked) or 10001 (overrides); the current band
   starts at 15001. Matching the home is what still finds them. For each
   account: kill its processes, `userdel` it, then `groupdel` its
   `<user>-grp` group. A directory in the root with no account (an earlier
   run already deleted the user) gets `groupdel <name>-grp` only when that
   group still exists and has no members. Homes are removed after the groups,
   with `tp_safe_rm_tree`, so a stopped run can still find a leftover
   `<user>-grp` from the directory name. `/srv` itself is left; Debian ships
   it, and `tp_path_is_safe` refuses it. The preflight inventory records
   passwd accounts whose homes lie under a discovered root even when those
   directories are absent.
2. **Docker Engine.** The confirmation screen warns that this removes every
   container, volume, and image on the host, including ones TurboPanel did
   not create. Before Docker is stopped, the script reads the effective data
   root (`docker info` while the daemon responds, otherwise `data-root` in
   `/etc/docker/daemon.json`, otherwise `--data-root` on the docker unit).
   The Docker role preserves operator keys in `daemon.json`, including
   `data-root`. A nondefault root is shown in the confirmation report and
   removed with `tp_safe_rm_tree` after the same path-safety checks. If it
   cannot be determined or removed, the summary says so; a root that was
   determined is kept in the resume manifest. Stop `docker.socket`, `docker`,
   and `containerd`. `apt-get purge` the installed Docker packages (Docker's
   own set and Debian's `docker.io` / `docker-compose` / `containerd` /
   `runc`). Remove `/var/lib/docker`, `/var/lib/containerd`, the nondefault
   data root, and `/etc/docker` even when the packages are already gone.
   Remove any file in `/etc/apt/sources.list.d` that references
   `download.docker.com`, and the keyring named in that file's `Signed-By`
   (usually `/etc/apt/keyrings/docker.asc`). `groupdel docker`, and delete
   the `docker0` bridge when it is present.
3. **Data folders.** Every discovered config, state, log, run, and backup
   path, plus `/etc/ssh/turbopanel`.
4. **Apt packages**, last, because earlier steps use `iptables`, `acl`, and
   `openssl`. Remove `/etc/apt/sources.list.d/sury-php.sources` and the legacy
   `sury-php.list`, then `apt-get update`. Candidates are the base set from
   `daemon-prereqs` (plus `apt-transport-https`), the Apache build
   dependencies, installed `php*` packages, and
   `debsuryorg-archive-keyring`. Keep only installed packages. Drop anything
   Essential or priority `required` (this skips `tar`). Drop `ca-certificates`
   and `openssl` when any remaining apt source uses `https://`. `--dry-run`
   evaluates that check against the sources that will still exist after the
   Docker and sury repository files are removed, so those packages are not
   kept only because the files are still on disk. Installed `sudo` and
   `systemd-timesyncd` are added to the kept set and marked manual before
   `autoremove`; the purge summary names that protection. `autoremove` is
   skipped if they cannot be marked manual, so it cannot remove them. The
   time-sync role installs `systemd-timesyncd`; `/etc/systemd/timesyncd.conf`
   stays as TurboPanel wrote it. `apt-get -s purge` runs first. If that would
   remove packages that are not candidates, each candidate is simulated alone
   and any that still pull extras are dropped, including when adding one to
   an otherwise safe set would pull them. Kept packages are `apt-mark manual`
   so the following `autoremove` does not undo that decision. Then `apt-get
   purge -y` the final list and `apt-get autoremove --purge -y`.

The summary adds, on top of the remove-only skipped steps and the "could not
remove" list from the second scan: hosted data that is still present
(config, state, log, run, and backup paths, principal roots and homes, and
`/etc/ssh/turbopanel`), compared with the pre-removal snapshot. Empty
mountpoints kept on purpose are left off that list. It also lists packages
kept and why, including `sudo` and `systemd-timesyncd` when they were marked
manual; a warning that sury-provided library versions stay installed (the
php-fpm role treats that repo as permanent while PHP remains — purge removes
the repo and the `php*` packages, and does not downgrade the libraries sury
replaced); that `ufw` / `firewalld` were removed at install and are not
restored; that `/etc/systemd/timesyncd.conf` is left as written; a reboot so
leftover kernel state (bridges, NAT rules) is cleared; and the commands to
install a daemon or a self-hosted control plane again.

## Installer script hosting (`workers/turbopanel-sh/`)

Moved to `workers/turbopanel-sh/AGENTS.md` — the assets-only
**turbopanel.sh** Workers Static Assets host, deploy tooling, channel
manifests, and build/commit stamping.

## Host facts & command handlers

Moved to `src/host/AGENTS.md` — host OS, time sync, docker, machine key, and
runtime inventory probes.

## Subsystem docs (nested `AGENTS.md`)

Large subsystems live in focused `AGENTS.md` files next to their code — Cursor loads the nearest one automatically when you work in that directory. **Read the matching file before editing that area.** This root keeps the foundational path model + conventions; the detail moved to:

| Subsystem | Read before editing | Covers |
|---|---|---|
| **Command handlers** | `src/commands/AGENTS.md` | Daemon command implementations (`command-router.ts`); injected into `InstanceClient` from `src/entry/run.ts` so transport never imports handlers |
| **Instance client** | `src/instance/AGENTS.md` | WSS / Unix-socket connection, idle presence + heartbeats (`timeSync`/`ips`/`docker`), reconnect / parked backoff, JWKS JWT verification, daemon TLS trust model |
| **Host metrics (collector)** | `src/metrics/AGENTS.md` | `/proc`-based collection + scheduling, `POST /api/daemon/v1/metrics`, schema v3 four-part contract (`core`/`extended`/`sensors`/`traffic`), sensor discovery, live-mode leases |
| **Tenant deploy & hosting ingress** | `src/deploy/AGENTS.md` | `environment.deploy` / `.lifecycle` / `.stop`, Docker Compose + Traefik, hosting Caddy, TLS materialization. Nested per-area docs: `src/deploy/release/AGENTS.md` (git-backed releases), `src/deploy/native/AGENTS.md` (host-run Node/Next), `src/deploy/site/AGENTS.md` (nginx/Apache/OLS sites), `src/deploy/cron/AGENTS.md` (scheduled jobs), `src/deploy/ssh/AGENTS.md` (tenant SSH) |
| **Command execution logs** | `src/logs/` | Streamed command transcripts: redaction deny-set, `<stateDir>/spool/execution-logs/` spool, batched upload to `POST /api/daemon/v1/commands/:commandId/log`, orphan sweep. Control-plane side: `../turbopanel/src/features/execution-logs/AGENTS.md`; capture details in `src/deploy/AGENTS.md` (Streamed transcript capture). This is the **only** log class uploaded and retained. |
| **Managed engines (daemon runtime)** | `src/managed/AGENTS.md` | `managed.apply` / `.lifecycle` / `.destroy`, `managed.ingress.reconcile` (shared ProxySQL — compose project = the `managed-ingress` `serviceId` — on the organization's managed network, a bare-UUID name carried as `managedNetwork` on the command), engine registry (Postgres first); separate from tenant deploy. On-demand tails ride the same correlated cell round trip as `managed-logs-request` / `managed-logs-result`: engine `compose logs`, and running-container `docker container logs`. Neither is stored or collected; presence does not carry `containerLogsEnabled`. |
| **Installer presentation** | `src/orchestration/AGENTS.md` | Installer presenter + sanitizer / vocabulary map for `run.sh` install & converge |
| **Installer script hosting** | `workers/turbopanel-sh/AGENTS.md` | Assets-only **turbopanel.sh** Workers Static Assets host, deploy tooling, channel manifests, build/commit stamping |
| **Host facts** | `src/host/AGENTS.md` | Host OS, time sync, docker, machine key, runtime inventory probes (hello + change-detected heartbeats) |
| **Time sync (Ansible)** | `orchestration/AGENTS.md` | `time-sync` role + `time-sync-apply.yml` (NTP / timezone) |

Ansible playbooks/roles live under `orchestration/`; runtime TypeScript under `src/`.
