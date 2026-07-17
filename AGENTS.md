# AGENTS.md

TurboPanel **daemon** — Ansible-driven node agent; connects to the instance over
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
  const test = Deno.test.bind(Deno)
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
`TURBOPANEL_RUNTIMES_DIR`, `TURBOPANEL_DAEMON_ROOT`).
`src/orchestration/paths.ts` and `src/instance/paths.ts` derive their constants
from `resolveLayout` — do **not** hardcode absolute paths in runtime code;
add/extend a layout field instead. The development default checkout root is
`<devRoot>/daemon` (from `TURBOPANEL_DEV_ROOT` / `$HOME`); production runtime
code must never name the retired `/opt/turbopanel/platform` token — the layout
module and CI guard are the only places allowed to reference it.

**Production (managed / FHS)** — compiled release, no source checkout:

| Purpose                                                           | Path                                  |
| ----------------------------------------------------------------- | ------------------------------------- |
| Native daemon binary                                              | `/opt/turbopanel/bin/turbopaneld`     |
| JS fallback (`deno run`; only when native binary cannot execute)  | `/opt/turbopanel/bin/turbopaneld.js`  |
| Orchestration assets (Ansible)                                    | `/opt/turbopanel/share/orchestration` |
| Static UI export                                                  | `/opt/turbopanel/share/ui`            |
| Vendored runtimes (node/deno/caddy/uv/python/ansible/cloudflared) | `/opt/turbopanel/vendor`              |
| Daemon install root (`daemonRootDefault`)                         | `/opt/turbopanel/lib/daemon`          |
| Config (`daemon.env`, `instance-ca.pem`)                          | `/etc/turbopanel`                     |
| Persistent identity (license, `server.id`, keys, tunnels)         | `/var/lib/turbopanel`                 |
| Logs                                                              | `/var/log/turbopanel`                 |
| Runtime (sockets, `daemon.lock`)                                  | `/run/turbopanel`                     |

**Development (co-located checkout)** — `./console` from
[turbopanel/dev](https://github.com/turbopanel/dev) runs the daemon from source
(`deno run main.ts`); all mutable paths are **dev-user-owned**:

| Purpose                          | Path                                                                   |
| -------------------------------- | ---------------------------------------------------------------------- |
| Daemon checkout / install root   | `<TURBOPANEL_DEV_ROOT or $HOME>/daemon`                                |
| Orchestration assets             | `<checkout>/orchestration` (prod roles); overlay in `<dev checkout>/orchestration` |
| Vendored runtimes                | `/opt/turbopanel/vendor`                                               |
| Daemon env file                  | `/etc/turbopanel/daemon.env`                                           |
| Daemon state                     | `/var/lib/turbopanel`                                                  |
| Logs                             | `/var/log/turbopanel`                                                  |
| Config dir                       | `/etc/turbopanel`                                                      |
| Runtime (sockets, `daemon.lock`) | `/run/turbopanel`                                                      |

**Development identity:** co-located dev creates **no** dedicated `turbopanel`,
`turbopaneli`, or `turbopanelc` / `turbopanelh` service accounts. The
`turbopaneld`, instance, UI, and Caddy systemd units, plus Docker-backed
services (Postgres, Redis, RabbitMQ, Mailpit, ClickHouse —
`turbopanel-clickhouse`, Tabix — `turbopanel-tabix`), all run as the **current
dev user**. Production managed installs keep the dedicated service users
described in the production table above.

**Deno version pin:** `DENO_VERSION` (`src/orchestration/paths.ts`) =
**`2.9.3`**. Keep it in step with `deno_version` in
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
download cache is disposable scratch — installed roles/collections live under
FHS (`share/orchestration/roles`, `vendor/ansible/galaxy-collections`). Managed
`run.sh` + `daemon-install.yml` remove `/tmp/turbopanel-ansible` and any
accidental `/root/.ansible` after install. Runtime orchestration runs as
`turbopanel` (dev: the current dev user).

**Galaxy roles are not committed:** pins live in
`orchestration/requirements.yml` (`geerlingguy.docker`, collections). Bootstrap
(`ensureGalaxyRoles`) installs roles into `orchestration/roles/` and
collections under `vendor/ansible/galaxy-collections`. First-party roles
(e.g. `docker`, which wraps Galaxy via `include_role`) stay in git; Galaxy
install trees (`geerlingguy.docker/`, …) are gitignored. Do not vend them into
the repo — Sonar would scan third-party `mode: 0644`/`0755` as false
vulnerabilities, and release hosts already reinstall from Galaxy at bootstrap.

## Project metadata

GitHub repository:
[turbopanel/turbopaneld](https://github.com/turbopanel/turbopaneld). Deno
package name: `turbopaneld` (`deno.json`), aligned with the repo slug and the
compiled `/opt/turbopanel/bin/turbopaneld` binary.

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
- `src/orchestration/paths.test.ts` — production/dev default trees, env
  overrides, and the `DENO_VERSION` ↔ role pin
  (`deno test src/orchestration/paths.test.ts`).
- `scripts/verify-release-root.sh` / `tp_verify_release_root`
  (`scripts/lib/release-artifacts.sh`) — reject dev-only paths, TS sources,
  `share/ansible`, or a leaked daemon source tree in a packaged release root.
  Release packaging helpers (`release-artifacts.sh`, `package-daemon-release.sh`,
  `bundle-orchestration.sh`, `verify-release-root.sh`) are **bash** — `deno.json`
  must invoke them with `bash`, not `sh` (Debian `/bin/sh` is dash and silently
  skips prune/verify checks that use `[[`). `run.sh` stays POSIX and inlines a
  separate copy of the manifest helpers for `curl | sh`.

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
/ `rabbit mq` → **queue**; `uv` / `python` / `cpython` → **runtime**. Ansible
JSONL events (`logAnsibleEvent` / `InstallEventPresenter`) and orchestration
`logInfo` lines (`runRedisSetup`, `runRabbitmqSetup`, `runPostgresSetup`,
`runDockerSetup`, `runInstanceDevInstall`, `runDaemonConverge`, …) all funnel
through the same helpers when `setActiveInstallPresenter()` is set.

**Intentionally unchanged:** vendor directory names
(`/opt/turbopanel/vendor/redis/…`), Ansible role directory names (`roles/redis`,
`roles/rabbitmq`), playbook filenames (`redis-setup.yml`, `rabbitmq-setup.yml`),
handlers/templates, env vars, and internal identifiers (`redis_*`, `rabbitmq_*`,
`TURBOPANEL_REDIS_*`, …). User-facing Ansible task `name:` strings in the
cache/queue roles use neutral wording where practical so labels read cleanly
even outside the sanitizer.

**Logs:** when the presenter is **inactive** (normal daemon converge /
`daemon.log`), structured logs keep full vendor detail. When the presenter is
**active**, stdout/stderr show the scrubbed rolling view; `daemon.log` is not
duplicated on that path — operators rely on post-install logs for full detail.

Tests: `src/orchestration/presentation.test.ts`, `install-presenter.test.ts`,
`ansible-events.test.ts` ( `formatAnsibleEventLog` ), `ansible.test.ts`
(internal path vs presented status lines).

## Instance client (`src/instance/client.ts`)

`InstanceClient` maintains the daemon's authenticated WSS (or co-located Unix
socket) to `/ws/daemon/v1`. Enrollment + JWT session issuance happen over REST
first; the socket carries live traffic only (outbox delivery, command dispatch,
dev-sync, tunnel-token, etc.). Registration keys are one-shot: `enrollDaemon`
sends a persisted `server.id` (when present) so re-enroll of the same host
works; a consumed key cannot latch a second server (see instance Daemon Cell /
license notes).

**Co-located dev connectivity** (`src/orchestration/setup.ts`,
`src/instance/paths.ts`): after console opt-in (`TURBOPANEL_DEV_INSTANCE=1`),
Deno runtime dials the local Unix socket (no `TURBOPANEL_INSTANCE_URL`); Workers
runtime dials Caddy over HTTPS/WSS via `TURBOPANEL_INSTANCE_URL` + platform CA —
same transport as a remote daemon, but still the co-located host. Connection
stays deferred until opt-in on both runtimes.

### Idle presence (`src/instance/idle-presence.ts`)

`IdlePresence` runs per open socket:

- Sends `{ type: "hello", at, agent, hostname?, machineId?, os? }` once on
  attach. Host OS comes from `/etc/os-release` (+ `/etc/debian_version`,
  `/etc/rpi-issue`) via `src/host/os-release.ts` (`getHostHelloIdentity()`).
  Prefer dotted point-release (`DEBIAN_VERSION_FULL` / `debian_version`, e.g.
  `13.5`) over bare `VERSION_ID`. Raspberry Pi OS / Raspbian set
  `variant: "raspberry-pi-os"` (`ID=raspbian` or `/etc/rpi-issue` present —
  64-bit Pi OS still reports `ID=debian`). The instance persists `os` on
  `server.metadata.os` and exposes `osDisplay` / `osLogo` on
  `GET /api/client/v1/servers`.
- After **~60 s** of inbound silence (`IDLE_PRESENCE_MS`), sends the wire
  **`{"type":"ping"}`** cell ping (must match `DAEMON_CELL_PING` in
  `instance/src/daemon/cell/protocol.ts`). On Workers the DO answers via
  `setWebSocketAutoResponse` without waking the object; on self-hosted Redis the
  same ping updates cell `lastSeenAt`. When the min-presence interval equals the
  check interval (default), `IdlePresence` allows ~5s of `setInterval` skew so
  early ticks still send — otherwise early fires were skipped and Redis coalesce
  could false-demote a live socket.
- Sends app-level `{ type: "heartbeat", at }` **only when the build agent commit
  changed** since the last hello/heartbeat — not on every idle tick. Do **not**
  put OS on heartbeat. Offline self-heal (Postgres `connected: false` while the
  socket is still live) is handled by the instance **offline-sweep cron**
  re-projecting online via `onDaemonConnected` — not by a periodic daemon
  heartbeat.
- **Max-connection-age self-recycle:** once per idle tick,
  `#checkMaxConnectionAge` enforces `MAX_CONNECTION_AGE_MS` (2 h, mirrors the
  instance `MAX_WS_CONNECTION_AGE_MS`). When the socket exceeds that age it fires
  once via `onMaxAge` → `InstanceClient.#closeActiveSocket`, then full-jitter
  reconnect. Complements the existing half-open `#checkStaleConnection`
  (`staleConnectionMs`). This daemon-side cap is the **primary lifetime
  enforcer** now that the instance no longer wakes healthy DOs each minute
  (AE-driven offline sweep). Cost rules:
  **`../instance/AGENTS.md`** (Daemon Cell) — do not duplicate DO pricing here.

**Heartbeat vs metrics:** ping/`heartbeat` (above) = liveness only. Host metrics
are a separate completed measurement interval — see **Host metrics** below.
`MetricsScheduler` is independent of `IdlePresence` (neither suppresses the
other).

**Reconnect jitter:** `InstanceClient` reconnects with **full-jitter** backoff
in `[initialBackoffMs, currentBackoffMs]` (defaults 2 s → 30 s cap, doubling on
auth failures). A benign close after a stable session (`STABLE_SESSION_MS`, 5 s)
resets backoff to the initial floor so fleet-wide restarts do not align into a
thundering herd.

**Single-daemon guarantee:** only one live cell attachment per server. Runtime
backstop is the instance cell's **single-writer lease** on attach
(`attachDaemonSocket` / `detachDaemonSocket`). On managed hosts,
`share/orchestration/scripts/ensure-single-daemon.sh` (systemd `ExecStartPre`)
adds a **flock** on `/run/turbopanel/daemon.lock` so a second
`turbopaneld.service` cannot start. Manual `deno task start/dev` bypasses flock
(dev-only). Canonical cell semantics, DO/SQLite billing, and cost rules:
**`../instance/AGENTS.md`** (Daemon Cell) — do not duplicate DO pricing here.

### JWKS verification

The daemon fetches `GET /api/daemon/v1/jwks.json` via
`DaemonApiClient.getJwks()` and verifies its instance-issued JWT by `kid` in
`src/instance/jwks-client.ts` (`DaemonJwksClient`): in-memory cache with ~1h
refresh TTL, ≥60s min refresh interval, single-flight refresh, and
**refresh-on-unknown-kid** (one bounded retry); imports Ed25519 public JWKs and
verifies EdDSA signature + `iss`/`aud`/`typ`/`exp`.

`DaemonTokenManager` (`token-manager.ts`) verifies each freshly created session
token via `verifyToken` before caching: hard-fail on `invalid`; on `unavailable`
(JWKS unreachable) log a warning and fall back to the instance-issued token's
`exp`; require verified `sub` == serverId and `kid` == keyId.

**Trust authenticated claims over socket-pushed IDs:** identity is established
locally (enrollment + persisted `server.id`) and confirmed via the verified JWT
`sub`; no WebSocket message adopts `serverId` (see the guard comment in
`client.ts` `#handleMessage`).

Related files: `src/instance/jwks-client.ts`; `getJwks()` / `JwksDocument` on
`src/instance/api-client.ts`.

**Orchestration source tree:** the canonical Ansible playbooks and roles live in
**`orchestration/`** in the daemon git checkout. Co-located dev runs that tree
directly (plus the **dev repo** overlay at `<dev checkout>/orchestration` for
dev-user parameters — not shipped in release; resolved via
`TURBOPANEL_DEV_ORCHESTRATION_DIR` / `resolveDevOrchestrationDir`, layered with
daemon production roles through `ANSIBLE_ROLES_PATH`). Production installs extract
**`orchestration.tar.zst`**
from the channel manifest into `/opt/turbopanel/share/orchestration/`. Release
CDN artifacts are four split tarballs per build under versioned paths
(`channels/trunk/daemon/<buildId>/…`): host-arch
`turbopaneld-{amd64,arm64}.tar.zst`, shared `turbopaneld.js.tar.zst` (JS
fallback only), and shared `orchestration.tar.zst`. Manifest artifact URLs are
canonical — Bunny CDN ignores `?build=` query cache-bust, so each publish
uploads to a new `<buildId>/` prefix with `Cache-Control: immutable`.

**Managed install layout (FHS):** `run.sh` always downloads the host-arch native
binary and orchestration tree; it downloads `turbopaneld.js` **only** when the
native binary probe fails. Native hosts remove any leftover JS fallback files on
install/update. Config lives in `/etc/turbopanel` (`daemon.env`,
`instance-ca.pem`); persistent identity in `/var/lib/turbopanel` (license,
`server.id`, keys); runtime files in `/run/turbopanel`. The installer probes
`turbopaneld --version` and selects native `ExecStart` or the Deno JS-fallback
(`…/vendor/deno/bin/deno run --allow-all …/bin/turbopaneld.js`) with
`EnvironmentFile=/etc/turbopanel/daemon.env`. **Deno is installed only on the
JS-fallback path** — native hosts bootstrap orchestration via the compiled
binary and skip `deno-runtime` in `daemon-install.yml`. Co-located dev keeps
`deno run main.ts` from the home checkout via `daemon-systemd-setup.yml` and
logs to `/var/log/turbopanel`.

**Managed updates:** the running daemon reconciles in-place via `run.sh`
(downloaded from `https://trbp.nl/run.sh` or the instance host) when triggered
from the control-plane UI or manually with the same piped installer. There is no
separate update binary installed under `/opt/turbopanel/bin/`.

### Daemon TLS trust model (4 paths)

The daemon validates the instance server cert on **every HTTPS connect** — both
chain trust **and** hostname (SAN). There is **no** insecure/skip-verification
mode at runtime (`run.sh --insecure-tls` only affects bootstrap `curl -k`
downloads over HTTPS). Four valid configurations:

| Path                                 | CA trust                                                                                                                                                                                     | SAN requirement                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Plaintext HTTP dev control plane** | none — no CA is fetched, stored, or configured (`run.sh` skips the CA-fetch block and omits `turbopanel_instance_ca`; `createInstanceHttpClient` short-circuits before any CA/cert handling) | none — there is no TLS handshake; the daemon dials `ws://`/`http://` directly                                                                                                                                                                                                                                                                                                                                                 |
| **Self-signed (self-hosted)**        | Daemon trusts the downloaded platform CA (`TURBOPANEL_INSTANCE_CA`, fetched from `GET /api/daemon/v1/instance/ca`)                                                                           | The leaf cert **must** include the hostname the daemon dials. SANs are derived from the configured public URL(s) — `TURBOPANEL_PUBLIC_URL` / `TURBOPANEL_BASE_URL` / `TURBOPANEL_INSTANCE_URL` and `TURBOPANEL_TLS_EXTRA_SANS` (see `../instance/scripts/generate-self-signed-cert.mjs`). Never hardcode the hostname.                                                                                                        |
| **Let's Encrypt**                    | Publicly-valid → daemon uses the **system trust store** (ship **no** `TURBOPANEL_INSTANCE_CA`)                                                                                               | The real cert already covers the public hostname.                                                                                                                                                                                                                                                                                                                                                                             |
| **Cloudflare tunnel / proxy**        | Cloudflare's edge cert is publicly-valid → **system trust**                                                                                                                                  | Daemon dials the public Cloudflare hostname, which the edge cert already covers. **Caveat:** behind a tunnel the instance cannot auto-discover its own public hostname (cloudflared dials out), so the reachable URL(s) must be **declared by the operator** (admin surface / `TURBOPANEL_PUBLIC_URL`), not auto-detected. The self-signed origin leg (cloudflared → local Caddy) is separate from what the daemon validates. |

The plaintext HTTP path targets the dev-only `:8880` entrypoint in
`../instance/Caddyfile` (see **`../instance/AGENTS.md`** "Caddy (dev +
production)" — dev-only plaintext HTTP entrypoint). It requires
`TURBOPANEL_DEV_HTTP_CONTROL_PLANE=1` on co-located dev hosts and is never valid
on managed or production installs.

Note: `Deno.createHttpClient({ caCerts })` **adds** to the system roots (does
not replace them), so configuring the platform CA does not break validation of
publicly-trusted certs.

### Host metrics

Samples are sent via authenticated `POST /api/daemon/v1/metrics`
(`DaemonApiClient.sendHostMetrics`, `src/instance/api-client.ts`,
fire-and-forget). Protocol v1 request body:

```json
{ "type": "metrics", "version": 1, "at", "intervalSeconds", "sequence", "metrics", "dimensions" }
```

Contract mirrored (not build-coupled) in `src/metrics/contract.ts` ↔
`../instance/src/daemon/metrics/contract.ts` (`METRICS_SCHEMA_VERSION = 1`). The
20-metric ordered list (`HOST_METRIC_KEYS`: `cpuUsagePercent` … `uptimeSeconds`)
is an **external storage contract** — positional AE doubles and ClickHouse
columns depend on this order.

**Scheduling** (`src/metrics/scheduler.ts`): `MetricsScheduler` takes an injected
`MetricsSink` (`attach(send)`) rather than the raw `WebSocket` — the WS keeps
only commands/outbox + the cell ping. One sample ~every **60 s**
(`METRICS_INTERVAL_MS`) while connected; deterministic per-`serverId` phase
jitter ≤**5 s** (`METRICS_JITTER_MAX_MS`, FNV‑1a — does not change query
resolution). Monotonic process-local `sequence` resets on daemon restart (not
persisted). Fire-and-forget, disposable — no acks, retries, or outbox. Never
blocks startup, connect, liveness, command dispatch, shutdown, or reconnect.
Factory/collect/send failures are rate-limited (`METRICS_LOG_RATE_LIMIT_MS` = 5
min) and must not tear down the socket. Overlapping ticks are dropped; the
steady interval arms when the jittered first tick fires (not after first-collect
completion). Attach-scoped generation ignores stale in-flight emits across
detach/reconnect. Scheduler rebinding tracks `#metricsSchedulerServerId`
separately from `#tokenServerId` so jitter stays tied to the authenticated
server after identity recovery.

**Collector** (`src/metrics/collector/`): async reads only — **no subprocesses
per interval** (no `top`/`vmstat`/`iostat`/`free`/`df`/`ps`/`sar`). Sources:
`/proc/stat`, `/proc/loadavg`, `/proc/meminfo`, `/proc/uptime`,
`/proc/diskstats`, `/proc/net/dev`, `/proc/sys/kernel/osrelease`, process count
via `/proc`, root filesystem via `node:fs/promises` `statfs` on `/` (no `df`).
CPU % and per-second rates use two-snapshot deltas; first-sample rate metrics
are **`null`** (never coerced to `0`). **Disk filter** (`parse-diskstats.ts`):
exclude device prefixes `loop`, `ram`, `zram`, `fd`, `dm-`, `md`, `dcssblk`,
`sr`, `nbd`; drop partition rows (`^p?\d+$` suffix) when the parent whole-disk
row survives; sectors = 512 B. **Net filter** (`parse-net-dev.ts`): exclude
`lo`. Per-filesystem and per-interface series are deferred to future event
types. **Unsupported OS:** `UnsupportedMetricsCollector` returns
`{ supported: false, reason: "unsupported_os:<os>" }` and keeps the daemon
running.

**Env:** `TURBOPANEL_SERVER_METRICS_RETENTION_DAYS` default `90` (instance
ClickHouse raw TTL). Server metrics are always on — there is no instance-side
enable/disable gate; the daemon always collects and emits host metrics
fire-and-forget, and the instance always persists when a backend is configured.
ClickHouse connection vars and `CLICKHOUSE_VERSION` pin: see **ClickHouse**
below and **`../instance/AGENTS.md`** (Server metrics).

**Local validation:** fixture-driven tests under `src/metrics/` (no live `/proc`
required):

```bash
deno test src/metrics/
deno fmt && deno lint && deno check
deno task check:layout
```

Fixtures: `src/metrics/collector/testdata/`.

### ClickHouse (self-hosted analytics)

ClickHouse runs as a **Docker container** (official
`clickhouse/clickhouse-server:<version>` image) by the `clickhouse` Ansible role
— mirroring the Postgres/RabbitMQ Docker roles (named volume, `turbopanel`
bridge network, `Type=oneshot` unit). The `clickhouse` role has an explicit
`docker` meta-dependency:

| Path / resource                                                                          | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker image `clickhouse/clickhouse-server:{{ clickhouse_version }}`                     | ClickHouse server (no vendored binaries)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Container `turbopanel-analytics` / volume `turbopanel-analytics` on network `turbopanel` | Running server + persistent MergeTree data (in-container `/var/lib/clickhouse`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `/etc/turbopanel/clickhouse/`                                                            | `config.xml` (`config.d` overlay), `users.xml` (`users.d` overlay — bootstrap `default` admin only), `config.json` (host/port/database/user + password-file paths — no secret values), `.clickhouse_admin_pass` + `.clickhouse_app_pass` (mode `0600`), `wrapper-start.sh`. The two XML overlays are bind-mounted read-only into the image's `config.d`/`users.d` (base image config preserved). The overlays are owned by `clickhouse_container_uid`:`clickhouse_container_gid` (`9994:9994` in production, the dev uid:gid in co-located dev) — **not** `root`/`turbopanel` — so the `--user 9994:9994` container process can actually read them (mode `0640` keeps `users.xml`, which holds the admin password, non-world-readable); the secret/password files and `config.json` stay owned for root/dev + the `turbopanel` group as `instance-launch` needs. A pre-flight throwaway container (same `--user` + read-only mounts) verifies both overlays are readable before readiness/bootstrap |
| `/var/log/turbopanel/clickhouse/`                                                        | server logs (bind-mounted to the container's `/var/log/clickhouse-server`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `turbopanel-clickhouse.service`                                                          | Type=oneshot (`ExecStart`=wrapper-start.sh, `ExecStop`=`docker stop`); container runs `--user 9994:9994` on managed hosts, or the single dev uid:gid in co-located dev                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

The `config.d` overlay carries **idle-CPU tuning** for an otherwise-idle
single-server box: slow async-metrics cadence
(`asynchronous_metrics_update_period_s`/`asynchronous_heavy_metrics_update_period_s`
= 120); shrunken always-awake background pools
(`background_pool_size`/`background_schedule_pool_size`/`background_common_pool_size`
= 2, `background_merges_mutations_concurrency_ratio` = 1,
`merge_tree/merge_selecting_sleep_ms` = 30000); global thread-pool caps
(`max_thread_pool_size` = 64, `max_thread_pool_free_size` = 8,
`thread_pool_queue_size` = 64); shrunken eager-spawn schedule/move/fetch pools
unused by the metrics-only workload
(`background_message_broker_schedule_pool_size` /
`background_distributed_schedule_pool_size` /
`background_buffer_flush_schedule_pool_size` / `background_move_pool_size` /
`background_fetches_pool_size` = 1); and removal of the ClickHouse 26.x system
`*_log` MergeTree set — including `aggregated_zookeeper_log` alongside
`zookeeper_log` / `zookeeper_connection_log` (each log table adds flush + merge
scheduler threads). Shrinking the merge pool also requires lowering the
MergeTree free-entry gates (`number_of_free_entries_in_pool_to_execute_mutation`
/ `_to_lower_max_size_of_merge` / `_to_execute_optimize_entire_partition` = 1) —
ClickHouse 26.x refuses to start when any of those defaults (20 / 8 / 25) exceed
`background_pool_size * background_merges_mutations_concurrency_ratio` (keep
`background_pool_size` and the ratio at 2/1). Disabling a system log in config
stops new writes but does not drop an already-materialized table: the
`clickhouse` role runs an idempotent post-ready admin cleanup that
`DROP TABLE IF EXISTS` every `*_log` removed in `config.xml.j2` (including
`aggregated_zookeeper_log`). `ansible.test.ts` asserts the DROP list stays
aligned with the config remove list.

**Low-footprint resource caps** (role defaults — `ansible.test.ts` pin ceilings):
`mark_cache_size` **64 MiB**, `max_server_memory_usage` **512 MiB**, Docker
`--memory` / drift check both use `clickhouse_container_memory_bytes` (**768
MiB**) and `--cpus 1.0`. Drift checks recreate containers missing the
memory/CPU limits.

Primary write batching for ~1 sample/min traffic lives in the instance
`ClickHouseServerMetricsStore` (row count + max age). The `users.d` **default**
profile still enables secondary **async insert** coalescing (`async_insert=1`,
`wait_for_async_insert=0`, `async_insert_busy_timeout_ms=60000`,
`async_insert_max_data_size=1000000`) — not the main part-batching path.
`wait_for_async_insert=0` keeps the fire-and-forget write path non-blocking.

HTTP interface is published **loopback-only on `127.0.0.1:8123`** (native TCP
`9000` is **not** published — it stays internal to the container/network;
bootstrap SQL runs via `docker exec … clickhouse-client` on the container's
loopback). Default anonymous access is disabled. **Separate secrets:**
`.clickhouse_admin_pass` authenticates the `default` admin user in the `users.d`
overlay (bootstrap DDL / `access_management`); `.clickhouse_app_pass`
authenticates the least-privilege `turbopanel_app` user, which is created and
granted **only via SQL** (not declared in `users.xml`, default `HOST ANY`) and
scoped to database `turbopanel_metrics`.

**`turbopanel_app` grants (SQL bootstrap):** `SELECT`, `INSERT`, `CREATE TABLE`,
`CREATE VIEW`, `ALTER`, and `SHOW` on `turbopanel_metrics.*` — enough for
instance-owned `ensureSchema()` (`CREATE TABLE IF NOT EXISTS` plus
`MODIFY SETTING` / `MODIFY TTL`) and metrics reads/writes. No `DROP` or
`TRUNCATE`.

**Converge wiring:** co-located dev installs ClickHouse via the dev-repo
`<dev checkout>/orchestration/dev-converge-manifest.json` (role `clickhouse`, after
`postgres`/`redis`/`rabbitmq`, before `instance-user`) — same pattern as those
data services (not a discrete `setup.ts` step). Managed daemon-only hosts omit
it (`daemon-converge.yml`); use standalone `playbooks/clickhouse-setup.yml` /
`CLICKHOUSE_VERSION` (`26.5.5.8`) when a control-plane host needs the Deno
metrics store without the full dev overlay.

**instance-launch env:** when `.clickhouse_app_pass` exists, injects
`TURBOPANEL_CLICKHOUSE_URL` / `DATABASE` / `USER` into `runtime.env` and
`TURBOPANEL_CLICKHOUSE_PASSWORD` (app password only) into `runtime.dev-vars`.
The Deno/compiled `turbopanel-instance.service` loads `runtime.env` then
`runtime.dev-vars` via `EnvironmentFile=` so the process sees the full
ClickHouse + metrics config. Default:
`TURBOPANEL_SERVER_METRICS_RETENTION_DAYS=90` (metrics are always on — no
enable/disable env). Schema/query contract: **`../instance/AGENTS.md`** (Server
metrics — ClickHouse).

**Workers runtime dev vars:** `instance-workers.dev-vars.j2` injects
`TURBOPANEL_ANALYTICS_ENGINE_API_TOKEN` when
`/etc/turbopanel/instance/.analytics_engine_api_token` exists (mode `0600`,
operator-provided Cloudflare **Account Analytics Read** token). Writes use the
wrangler `SERVER_METRICS` binding; chart queries need this token for the AE SQL
API. `CLOUDFLARE_ACCOUNT_ID` is already in `wrangler.jsonc` vars.

**Tabix dev GUI (dev-only):** the `tabix` Ansible role runs a dev-only container
`turbopanel-dev-tablix` (unit `turbopanel-tabix.service`) — a static browser
client for the ClickHouse metrics DB, opened at **`http://127.0.0.1:8125`**. The
upstream `spoonest/clickhouse-tabix-web-client` image is **amd64-only** (crashes
with `exec format error` on arm64), so the role extracts its `/var/www/html`
assets via `docker create` + `docker cp` (no exec) into
`/var/lib/turbopanel/tabix/html`, injects ClickHouse connection defaults into
`index.html` (same `window.global_tabix_default_settings` contract as the
upstream `start.sh`), and serves them with multi-arch
**`nginxinc/nginx-unprivileged:alpine`** (`127.0.0.1:8125` → container `8080`).
Prefill uses `.clickhouse_app_pass` → **`turbopanel_app`** against
**`http://127.0.0.1:8123`** / DB **`turbopanel_metrics`**. It **must** use the
app user: the `default` admin is `<networks>`-restricted to `127.0.0.1`/`::1`
(docker-exec only). Cross-origin browser access is enabled via the **dev-gated
`http_options_response` CORS block** in the ClickHouse `config.d` overlay (only
rendered when `turbopanel_dev_user` is set, so managed/prod config is
byte-for-byte unchanged) plus a `CH_PARAMS` value of
`add_http_cors_header=1&database={{ clickhouse_database }}` carried on every
Tabix request. Loopback-only; **not** routed through Caddy; runs as the
**current dev `--user`**. Installed via the dev-repo `dev-converge-manifest.json` only (after
`clickhouse`, so the app password exists) — omitted from `daemon-converge.yml`,
so daemon-only hosts get no GUI.

### Tenant Docker Compose deploy + hosting ingress

`environment.deploy` (command router →
`src/instance/commands/deploy-environment.ts`):

1. Ensure Docker engine (`ensureDocker` → `runDockerSetup` when the binary is
   missing or the Engine API is unreachable). Docker CLI calls fall back to
   `sudo -n -u <self> -- docker …` when the socket is permission-denied so the
   first deploy after group membership still works without a daemon restart
   (`sg docker` fails for `/usr/sbin/nologin` service accounts with "This
   account is currently not available").
2. Bootstrap Traefik on Docker network `turbopanel-ingress` (internal bind
   `127.0.0.1:8080` only — **no** public `:80`/`:443` on Traefik; **no**
   ACME/LE).
3. Ensure vendored hosting Caddy (`ensureHostingCaddy` — Ansible `caddy-setup`
   then direct GitHub download) when
   `/opt/turbopanel/vendor/caddy/current/caddy` is missing. On-demand like
   Docker; daemon-converge does not install it. Required for hostname ingress.
4. Write runtime compose under
   `<stateDir>/deployments/<environmentId>/docker-compose.yml` with Traefik
   labels (`src/deploy/compose-labels.ts`).
5. `docker compose -p <projectName> up -d --remove-orphans`.
6. When the payload includes `tlsMaterial[]`, materialize org certs under
   `layout.tlsDir` (`/etc/turbopanel/tls/<tlsId>/fullchain.pem` +
   `privkey.pem`, modes `0640`/`0600`) via `materializeTlsCertificates`
   (`src/deploy/materialize-tls.ts`). Private keys arrive as
   `tpdaemon` envelopes — decrypt only through
   `POST /api/daemon/v1/secrets/decrypt` (daemon JWT); never log plaintext.
7. Refresh hosting-edge Caddy config under `/etc/turbopanel/hosting/`
   (`auto_https off` always). Per-hostname site blocks use
   `tls <fullchain> <privkey>` when a resolved `tlsId` was materialized;
   otherwise `tls internal`. Unit `turbopanel-hosting-caddy.service` when
   sudo allows. **Distinct** from control-plane Caddy (`:8443`).
8. Best-effort `docker compose ps --format json` — per-container identity/status
   (`containerId`, `containerName`, `composeServiceName`, `status`, optional
   `serviceId` from `payload.hostings`) is included in the command result when
   collection succeeds; a `ps`/parse failure never fails an otherwise-successful
   deploy.

`environment.stop` (command router →
`src/instance/commands/stop-environment.ts`):

1. `docker compose -p <projectName> -f <stateDir>/deployments/<environmentId>/docker-compose.yml down --remove-orphans --volumes` when the compose file exists (idempotent no-op when missing).
2. Remove `/etc/turbopanel/hosting/sites/<environmentId>.caddy` via `removeHostingCaddySite` and best-effort reload hosting Caddy.
3. Delete the deployment directory.
4. Return authoritative `containers: []` so the instance clears Postgres container pins.

Helpers: `src/deploy/ensure-docker.ts`, `src/deploy/ingress.ts`,
`src/deploy/materialize-tls.ts`, `src/deploy/ensure-hosting-caddy.ts`. Future
seams (not MVP): multi-server service placement, WireGuard mesh, swarm-style
replicas, ACME issuance on the daemon.
