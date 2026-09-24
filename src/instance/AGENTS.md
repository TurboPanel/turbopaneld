# Instance client — AGENTS.md

The daemon's authenticated link to the control plane (`src/instance/client.ts`): WSS or co-located Unix socket to `/ws/daemon/v1`, idle presence + heartbeats, reconnect / parked backoff, JWKS-based JWT verification, and the daemon-side TLS trust model.

Root context: `../../AGENTS.md` (Filesystem layout & path model). Host metrics scheduler: `../metrics/AGENTS.md`. Cross-repo `../<repo>/AGENTS.md` links are relative to the repo root (sibling repos under `$HOME`).

## Instance client (`src/instance/client.ts`)

`InstanceClient` maintains the daemon's authenticated WSS (or co-located Unix
socket) to `/ws/daemon/v1`. Enrollment + JWT session issuance happen over REST
first; the socket carries live traffic only (outbox delivery, command dispatch,
dev-sync, tunnel-token, etc.). Registration keys are one-shot: `enrollDaemon`
sends a persisted `server.id` (when present) so re-enroll of the same host
works; a consumed key cannot latch a second server (see instance Daemon Cell /
license notes). `start()` snapshots the identity directory
(`TURBOPANEL_DAEMON_STATE_DIR`) so license and key reads stay on that path
for the process lifetime.

**Capability plan.** Hosted control planes push `capability-plan-update` to
persist `<daemonStateDir>/metrics/capability-plan.json`. Self-hosted control
planes send `capability-plan-clear` on attach so a remote daemon that
previously stored a hosted plan deletes the file and emits an untruncated
sample. Do not use `TURBOPANEL_INSTANCE_RUNTIME` for that on remote daemons —
the authenticated cell message is the signal.

**Co-located dev connectivity** (`src/orchestration/setup.ts`,
`src/instance/sockets.ts`): after console opt-in (`TURBOPANEL_DEV_INSTANCE=1`),
Deno runtime dials the local Unix socket (no `TURBOPANEL_INSTANCE_URL`); Workers
runtime dials Caddy over HTTPS/WSS via `TURBOPANEL_INSTANCE_URL` + platform CA —
same transport as a remote daemon, but still the co-located host. Connection
stays deferred until opt-in on both runtimes **only in a source checkout**
(`detectInstallMode() === "development"`). The managed co-located daemon
(compiled / JS fallback, provisioned by `instance-install.yml`, socket mode)
connects and attaches Docker on start with no opt-in — socket mode alone is not
the dev signal. `setupTestHooks.detectInstallMode` is the test seam.

**Awaiting license** (`connect-failure.ts` `awaiting-license`,
`AWAITING_LICENSE_POLL_MS`): missing `license.id` / `license.token` is not a
permanent park. The daemon logs once at info and re-reads the state directory
every 5 s; the self-hosted wizard writes the co-located license (+ the
pre-provisioned `server.id`) there and the daemon enrols on the next check.
`enrollDaemon` never rewrites an unchanged `server.id` and replaces a changed
one by rename (the wizard's file is instance-owned 0640 in a setgid dir).

### Instance Let's Encrypt renewal (`src/instance/instance-acme-renew.ts`)

`InstanceAcmeRenewalScheduler` renews the control plane's own Let's Encrypt
leaves. It starts from `InstanceClient.start()` and keeps running across
socket reconnects; events queued while the socket is down flush on the next
attach. It does not probe public `:443` — that port is tenant hosting. The
hostname list is `instance-hostnames.json` (`readInstanceLetsEncryptHostnames`).
Each leaf is `letsencrypt-<host>.crt` in the instance certs directory. A name
is due when that file is missing, not a certificate, or inside the issuer
window (`INSTANCE_ACME_RENEWAL_WINDOW_RATIO`, the same `renewal_window_ratio`
`0.33` written into the issuer config). The check runs at daemon start, then
every six hours, or sooner when a failure backoff or a pending Caddy reload
expires. It does not poll.

A due name runs the HTTP-01 window, preflight, and issue path from
`applyPublicUrls`. `withInstanceAcmeWindowLock` allows one window at a time.
Issue copies `letsencrypt-<host>.{crt,key}`. The scheduler then runs
`systemctl reload turbopanel-caddy`. That unit's `ExecReload` passes
`--force`, so Caddy re-reads the certificate files without a Caddyfile
render. Account email, terms, and directory URL come from
`instance-acme-settings.json`, written on each issue.

Each attempt sends `instance-acme-issuance-event`: `ok` with `notAfter` from
the installed file, or `ok: false` with the issuer's error text. A failure
waits at least one hour before that hostname is tried again, then doubles up
to 24 hours. The wait is stored in `<stateDir>/instance-acme/renewal-state.json`
so a restart cannot spend Let's Encrypt's five failed authorizations per
identifier per hour (one refill every 12 minutes). The tenant
`AcmeIssuanceObserver` is unchanged and still probes organization names.

### Idle presence (`src/instance/idle-presence.ts`)

`IdlePresence` runs per open socket:

- Sends `{ type: "hello", at, daemonBuild, hostname?, machineKey?, os?,
  resources?, timeSync?, docker? }` once on attach. `machineKey` is a
  derived, non-reversible HMAC of `/etc/machine-id` (`src/host/machine-key.ts`)
  — warmed on the connect path before hello. Host OS comes from
  `/etc/os-release` (+ `/etc/debian_version`, `/etc/rpi-issue`) via
  `src/host/os-release.ts` (`getHostHelloIdentity()`). Prefer dotted
  point-release (`DEBIAN_VERSION_FULL` / `debian_version`, e.g. `13.5`) over
  bare `VERSION_ID`. Raspberry Pi OS / Raspbian set
  `variant: "raspberry-pi-os"` (`ID=raspbian` or `/etc/rpi-issue` present —
  64-bit Pi OS still reports `ID=debian`).   **Host resources** (static
  capacity under `resources.cpus[]` / `gpus[]` / `memory` / `swap`: per-socket
  `vendorId` / `name` / `cores` / `threads` / `cache` / `speedMhz` / `turboMhz`,
  GPU identity + memory, `totalBytes`, plus `resources.ips`) come from `/proc/stat` + `/proc/cpuinfo` + `/proc/meminfo`
  + `/sys` (cpufreq, cache, DRM) via `src/host/host-inventory.ts` (process-cached; cpus/gpus/mem/swap on hello only)
  and `collectServerIps()` (`src/host/server-addresses.ts`) as
  `{ address, version, scope, cidr?, interface? }[]` (public + private; `interface`
  is the NIC name). Time sync facts come from
  `src/host/time-sync.ts` (`timedatectl` + `/etc/systemd/timesyncd.conf` +
  optional `lastSyncedAt` from `/run/systemd/timesync/synchronized`).
  **Docker**
  (`src/host/docker.ts`) is omitted unless `/usr/bin/docker` is installed:
  `{ version, composeVersion? }` from `docker --version` and
  `docker compose version` (plugin). When Docker is later installed on an
  already-connected host, the next change-detected heartbeat carries it.
  The instance persists OS / timezone / NTP on dedicated `server` columns and
  `resources` / `docker` on `server.metadata`, and exposes them on
  `GET /api/client/v1/servers`. All new hello fields stay optional for
  back-compat. The instance maps current `resources.ips`/`resources` and the pre-rename
  top-level `ips` / `addresses` object / `inventory` block so remotes that have not rebuilt yet
  still persist private IPs and capacity.
- After **~60 s** of inbound silence (`IDLE_PRESENCE_MS`), sends the wire
  **`{"type":"ping"}`** cell ping (must match `DAEMON_CELL_PING` in
  `turbopanel/src/daemon/cell/protocol.ts`). On Workers the DO answers via
  `setWebSocketAutoResponse` without waking the object; on self-hosted Redis the
  same ping updates cell `lastSeenAt`. When the min-presence interval equals the
  check interval (default), `IdlePresence` allows ~5s of `setInterval` skew so
  early ticks still send — otherwise early fires were skipped and Redis coalesce
  could false-demote a live socket.
- Sends app-level `{ type: "heartbeat", at, daemonBuild?, timeSync?, resources?, docker? }`
  when the daemon build commit changed **or** when `timeSync` / `resources.ips` /
  `docker` differ from the snapshot seeded on hello (change-detected, still
  cadence-bound to the ~60s idle tick). Do **not** put OS or cpus/gpus/mem/swap on heartbeat. Offline
  self-heal
  (Postgres `connected: false` while the socket is still live) is handled by the
  instance **offline-sweep cron** re-projecting online via `onDaemonConnected`
  — not by a periodic daemon heartbeat.

Command handlers (`server.timezone.set`, `server.ntp.set`,
`server.firewall.reconcile`, deploy/managed/fabric, …) live in
`src/commands/` and are injected at the `src/entry/run.ts` composition root
— see `src/commands/AGENTS.md`. This client never imports that directory.

- **Max-connection-age self-recycle:** once per idle tick,
  `#checkMaxConnectionAge` enforces `MAX_CONNECTION_AGE_MS` (2 h, mirrors the
  instance `MAX_WS_CONNECTION_AGE_MS`). When the socket exceeds that age it
  fires once via `onMaxAge` → `InstanceClient.#closeActiveSocket`, then
  full-jitter reconnect. Complements the existing half-open
  `#checkStaleConnection` (`staleConnectionMs`). This daemon-side cap is the
  **primary lifetime enforcer** now that the instance no longer wakes healthy
  DOs each minute (AE-driven offline sweep). Cost rules:
  **`../turbopanel/AGENTS.md`** (Daemon Cell) — do not duplicate DO pricing here.

**Heartbeat vs metrics:** ping/`heartbeat` (above) = liveness only. Host metrics
are a separate completed measurement interval — see `../metrics/AGENTS.md`.
`MetricsScheduler` is independent of `IdlePresence` (neither suppresses the
other). The first metrics POST fires as soon as the socket opens (including
the co-located self-hosted daemon) so overview stats are not gated on the 60 s
cadence. Hardware-profile picker discovery is a third, on-demand path:
`metrics-capabilities-request` / `metrics-capabilities-result` (empty request,
result carries `MetricsCapabilities`) — not sampled on the tick, not served
from topology. The control plane's `GET /servers/:id/metrics/capabilities`
waits on that correlated round trip.

**Reconnect jitter:** `InstanceClient` reconnects with **full-jitter** backoff
in `[initialBackoffMs, currentBackoffMs]` (defaults 2 s → 30 s cap, doubling on
auth failures). A benign close after a stable session (`STABLE_SESSION_MS`, 5 s)
resets backoff to the initial floor so fleet-wide restarts do not align into a
thundering herd.

**Parked state:** `classifyConnectFailure` (`src/instance/connect-failure.ts`)
maps enroll/session failures to `transient` (network, `>=500`, `429`,
`400 Invalid or expired challenge` → normal full-jitter reconnect),
`temporary-auth` (reserved — close-code / stale-JWT refresh path, e.g. `4401` →
refresh, no identity clear), `stale-identity` (`404 Server key not found`,
`400 Server key mismatch` → recover + re-enroll), `tls-trust`
(Deno/rustls chain/SAN/expiry: `invalid peer certificate`, `UnknownIssuer`,
`NotValidForName`, `CertExpired` — **park**, not a silent 30 s loop), or
`permanent`
(`401 Invalid license`, `400 License already consumed or invalid`,
`400 License is inactive`, `400 License tier below required`,
`400 License tier not assigned`, `400 Server key is inactive`,
`403 Invalid signature`, `409 Fingerprint already exists`, and the local
`missing license credentials for enrollment` → **park**). On `permanent` or
`tls-trust`,
`InstanceClient` enters `#enterParkedState` instead of `#increaseBackoff` —
full-jitter backoff in `[PARKED_BACKOFF_MIN_MS, PARKED_BACKOFF_MAX_MS]`
(**5 min → 1 h**, vs the transient `DEFAULT_MAX_BACKOFF_MS` 30 s ceiling) with
**no** enroll/challenge/session network traffic while parked. This parked
state — not the instance rate limiter — is the primary storm protection.
`#recoverFromStaleIdentity` calls `clearDaemonKeyState` (removes only
`server-key.json` + `server-key-id`, **keeps** `server.id`) so `enrollDaemon`
can re-present the persisted `serverId` for an already-latched license; a
permanent enroll failure on that path then parks rather than re-clearing every
cycle. Unpark triggers while the process stays up: license-file change
(SHA-256 stamp of `license.id` + `license.token` differs) or
`TURBOPANEL_FORCE_ENROLL` truthy — both reset backoff and force re-enroll on
the next cycle. Daemon restart clears the in-memory parked backoff and retries
the normal identity path; forced re-enroll after restart still requires
`TURBOPANEL_FORCE_ENROLL` or missing/cleared key files. Greppable park
log: `daemon control-plane permanently rejected enrollment (<reason>); parked —
install a fresh registration key (Add Server) or point TURBOPANEL_INSTANCE_URL
at the correct control plane, then the daemon auto-recovers`.
`tls-trust` parks with a distinct greppable log naming the dialed host, the
resolved CA path, the local CA fingerprint, and recovery (`run.sh` with
`--instance-ca` / `--insecure-tls`). Unpark for `tls-trust` uses the parked
backoff only (re-read CA on the next attempt — does **not** force re-enroll).
`token-manager.ts` skips its 2 s session-refresh retry on a `permanent` first
error (no double challenge+session per cycle). Status → action table:
**`../turbopanel/AGENTS.md`** (Daemon key authentication — do-not-retry-soon
table).

**Instance version floor** (`src/instance/version-wire.ts`):
`MIN_SUPPORTED_INSTANCE_VERSION` is the mirror of the control plane's
`MIN_SUPPORTED_DAEMON_VERSION`. Bump them together and say why in both
Versions-on-the-wires notes (root `AGENTS.md` and
`../turbopanel/AGENTS.md`). The daemon learns the peer from
`x-turbopanel-version` on every `DaemonApiClient` response (including non-OK
and the 401 before a refresh) and from `instanceVersion` on the cell attach
`{ type: "version" }` frame, including a socket-only session. A missing
header or a frame that omits `instanceVersion` clears the previous
observation to `unknown`. `InstanceClient.connectionState` reports
`supported` / `unsupported` / `unknown`. `unknown` is silent. `unsupported`
logs once:

`instance-version: control plane version <version> is below the supported minimum <floor>; flagged — the daemon keeps reconnecting (update the control plane)`

That is a flag, not `#enterParkedState`: the socket stays up and reconnect
continues. Capability gates (`resolveDaemonCapabilities` /
`resolveInstanceCapabilities`, map `DAEMON_FEATURE_MIN_VERSIONS`) are separate
and default **closed** when the peer version is unknown. The first key is
`instance-cert-sources-per-hostname` (daemon `0.1.1`, the control-plane
Caddyfile per-hostname certificate-source release,
`orchestration/roles/instance-launch/templates/Caddyfile.j2`). A panel feature gated on a daemon
artifact adds its entry to that map; the UI calls the helper.

**Single-daemon guarantee:** only one live cell attachment per server. Runtime
backstop is the instance cell's **single-writer lease** on attach
(`attachDaemonSocket` / `detachDaemonSocket`). On managed hosts,
`share/orchestration/scripts/ensure-single-daemon.sh` (systemd `ExecStartPre`)
adds a **flock** on `/run/turbopanel/daemon.lock` so a second
`turbopaneld.service` cannot start. Manual `deno task start/dev` bypasses flock
(dev-only). Canonical cell semantics, DO/SQLite billing, and cost rules:
**`../turbopanel/AGENTS.md`** (Daemon Cell) — do not duplicate DO pricing here.

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

**Deployment secret rehydrate:** `/run` is tmpfs, so Compose secret files vanish
across reboot. After a JWT session is available, `InstanceClient` fire-and-forgets
`rehydrateLocalDeployments` (`src/deploy/rehydrate-deployments.ts`):
`POST /api/daemon/v1/deployments/secrets/rehydrate` (plan + `tpdaemon` envelopes)
then existing `/secrets/decrypt`, write `/run` files, then `docker compose up -d`.
First connect always runs compose up; reconnect only if planned files are missing.
Not on heartbeats. Command `environment.lifecycle` start/restart uses the same
helper when files are absent.

Related files: `src/instance/jwks-client.ts`; `getJwks()` / `JwksDocument` on
`src/instance/api-client.ts`.

**Orchestration source tree:** the canonical Ansible playbooks and roles live in
**`orchestration/`** in the daemon git checkout. Co-located dev runs that tree
directly (plus the **dev repo** overlay at `<dev checkout>/orchestration` for
dev-user parameters — not shipped in release; resolved via
`TURBOPANEL_DEV_ORCHESTRATION_DIR` / `resolveDevOrchestrationDir`, layered with
daemon production roles through `ANSIBLE_ROLES_PATH`). Production installs
extract **`orchestration.tar.zst`** from the channel manifest into
`/opt/turbopanel/share/orchestration/`. Release CDN artifacts are four split
tarballs per build under versioned paths (`channels/trunk/daemon/<buildId>/…`):
host-arch `turbopaneld-{amd64,arm64}.tar.zst`, shared `turbopaneld.js.tar.zst`
(Deno JS runtime for hosts that cannot execute the native binary), and shared
`orchestration.tar.zst`. Manifest artifact URLs are canonical — Bunny CDN
ignores `?build=` query cache-bust, so each publish uploads to a new
`<buildId>/` prefix with `Cache-Control: immutable`.

**Two managed ExecStart modes (native vs Deno JS):** `run.sh` always downloads
the host-arch native binary and orchestration tree, then probes
`turbopaneld --version`. On typical amd64/arm64 servers that works and the unit
runs the native binary (no Deno install). Some arm64 boards — notably Raspberry
Pi hosts with a **16 KiB** page-size kernel — cannot load that `deno compile`
binary (built for the usual **4 KiB** page size). There the probe fails and the
installer downloads `turbopaneld.js`, installs vendored Deno, and uses
`deno run …/bin/turbopaneld.js` as **the** supported ExecStart for that
hardware. Do not treat the JS path as a temporary shim or something to delete
“once native works everywhere”; it is the production runtime for those kernels.
Wire/manifest names still say `jsFallbackArtifact` for compatibility with
published channel.json — the product meaning is “alternate runtime,” not
“deprecated fallback.” Native hosts remove leftover `turbopaneld.js` on
install/update, but Deno is still vendored on every host — `daemon-install.yml`
and `daemon-converge.yml` run `deno-runtime` unconditionally, because co-located
instance/mailer units resolve their ExecStart through `vendor/deno/current` even
when the daemon itself runs the native binary. Config lives in
`/etc/turbopanel` (`daemon.env`, `instance-ca.pem`); persistent identity in
`/var/lib/turbopanel` (license, `server.id`, keys); runtime files in
`/run/turbopanel`. Co-located dev keeps `deno run main.ts` from the home
checkout via `daemon-systemd-setup.yml` and logs to `/var/log/turbopanel`.

**Managed updates:** the running daemon reconciles in-place via `run.sh`
when triggered from the control-plane UI or manually with the same piped
installer (`curl -fsSL turbopanel.sh | TURBOPANEL_LICENSE=… sh`; optional
`TURBOPANEL_HOST` / `TURBOPANEL_INSECURE_TLS=1`). On a **managed host** the
daemon does not download or pipe the script itself: it resolves the trust
regime (`resolveAutomaticUpdateTrust` — public TLS or the
configured Platform CA; never `curl -k`) and then runs
`sudo -n tp-orchestrate update --license … [--host …] [--dl-base …]
[--instance-ca …] [--channel …] [--manifest-url …] --no-start`. The helper
fetches `run.sh` from `turbopanel.sh` (or `<instance>/run.sh` for an HTTPS
overlay host) and re-validates every flag against the root-pinned
`/opt/turbopanel/lib/update-origin` that `run.sh` wrote at install, so a
daemon cannot point root at another origin or control plane. Co-located dev
still pipes the downloaded script through `sudo sh -s`. Flags (`--license`,
`--host`, …) remain supported for scripts and sudo re-exec. There is no
separate update binary installed under `/opt/turbopanel/bin/`.

`run.sh --daemon-only` on a host that already has the control-plane binary
and a socket-mode `daemon.env` (no `TURBOPANEL_INSTANCE_URL`) runs
`daemon-colocated-refresh.yml`. That play refreshes the daemon unit, keeps
`After=turbopanel-instance.service`, and does not recurse-chown state or
config. It does not run `daemon-install.yml`. A remote node, or a `daemon.env`
that already dials a URL, still uses the remote installer.

The control plane is a **separate verb**, `tp-orchestrate update-instance
--channel NAME [--manifest-url URL] [--ui-manifest-url URL] --no-start`. It does not take `--license`,
`--host`, `--dl-base`, or `--instance-ca` (`run.sh --instance` refuses those).
The helper still reads the update-origin pin to fetch `run.sh`, then runs
`run.sh --instance --channel … [--instance-manifest-url …] [--ui-manifest-url …] --no-start`.
`--manifest-url` on the verb maps to `--instance-manifest-url` so the daemon
pin (`TURBOPANEL_MANIFEST_URL`) stays independent of
`TURBOPANEL_INSTANCE_MANIFEST_URL`. `--ui-manifest-url` accepts only the UI
GitHub release rail and maps to `run.sh --ui-manifest-url`
(`TURBOPANEL_UI_MANIFEST_URL`). A host env pin wins over the URL on the
cell message, so a panel click does not drop a hold. A development checkout refuses the
reconcile (`control-plane update is not supported on a development host; the
co-located control plane is source-run — use the dev console converge path`).
Before the helper runs, the daemon refuses a target below
`MIN_SUPPORTED_INSTANCE_VERSION`. A missing target version is not a refusal.
After a successful install the daemon runs the new binary's `migrate` verb.
`tp-orchestrate migrate` takes no arguments and reads
`Environment=TURBOPANEL_DATABASE_URL` from `turbopanel-instance.service` (the
URL the unit already uses). Managed `instance-deno.env` does not contain that
URL. Then the daemon restarts `turbopanel-instance` and
reloads `turbopanel-caddy` (`ExecReload`) so `:8443` keeps serving the
updating page. Caddy is restarted only when its binary changed. A failed
migration keeps the dump and rolls back through `instance-rollback.yml`.
The daemon does not restart itself. The result cell message goes out after
the health check (and is retried on the next attach if the restart closed
the socket). Daemon self-update does not consult the instance floor.

**Control-plane update (`executeInstanceUpdateReconcile`):** this path is
separate from the daemon self-update guard above. `tp-orchestrate
update-instance` always appends `--skip-daemon-package` and
`--progress-markers` (not caller-controlled), so `run.sh --instance` swaps
`bin/turbopanel`, `lib/libduckdb.so`, and `share/ui` and does not replace the
running daemon package or run `instance-install.yml`. One previous generation
is kept by rename (`bin/turbopanel.prev`, `lib/libduckdb.so.prev`,
`share/ui.prev`); the UI is extracted to `share/ui.new` and renamed into
place. The update path writes `<stateDir>/instance-swap.json` when it starts
moving those files and removes it only after the new tree is verified or
`.prev` has been restored. A nonzero install or a thrown installer/migrate
error rolls back when that marker is set (migrate failures always roll back,
because the new files are already live). A download that fails before the
marker does not. Before that swap the daemon checks free space on the install root and
`layout.backupDir` (`MIN_INSTANCE_UPDATE_FREE_INSTALL_BYTES` /
`MIN_INSTANCE_UPDATE_FREE_BACKUP_BYTES`), verifies the instance manifest and
any UI pin (`preflight_manifest`), and requires `turbopanel-database` to be
running (`preflight_backup` via `docker inspect`). An overlapping
`instance-update` is `preflight_in_progress`. `instance-backup.yml` then
writes `<backupDir>/control-plane/<upgradeId>/` (`pg_dump -Fc` inside the
database container, an `/etc/turbopanel` tarball, and `meta.json` with the
migration-history fingerprint) and keeps the newest three. When the rendered
Caddyfile does not yet serve `updating.html`, `instance-launch-only.yml`
re-templates it first. After restart, `waitForInstanceHealth` polls
`GET /api/health` on the instance socket until `version` and
`revision.commit` match the manifest, within
`INSTANCE_UPDATE_HEALTH_TIMEOUT_MS`. A timeout or mismatch runs
`instance-rollback.yml` (restore `.prev`, and `pg_restore` only when the
migration fingerprint changed) and checks health again. Success of that
check reports `rolled-back` with the original `errorCode` (`health_timeout`,
`health_mismatch`, or `restart_failed`) on `update-progress` (when
`update-progress-v1` is advertised) and on `instance-update-result`. A failed
rollback reports `failed` / `recovery_required` and includes the backup path,
`sudo -n tp-orchestrate playbook … instance-rollback.yml -e
turbopanel_upgrade_id=…`, and a pinned `update-instance` reinstall command.
Stages are `preparing → downloading → installing → restarting → verifying →
done`. The managed Caddyfile `handle_errors` block answers socket
502/503/504 with JSON `control_plane_updating` on `/api` and `/ws`, a bare
503 on `/webhook`, and `updating.html` (refresh 5s) for HTML. Dev hosts still
refuse the reconcile (`DEV_CONTROL_PLANE_UPDATE_REFUSAL`); the dev overlay
Caddyfile is unchanged.

**Pre-flight (`#applyUpdate`):** before `executeRunReconcile`, the daemon runs
disk space (`assertUpdateDiskPreflight` / `statfs` on install root, state dir,
and tmp), manifest resolve+verify (`clientTestHooks.resolveUpdate` — same path
as reconcile), and automatic-update trust (`resolveAutomaticUpdateTrust`). Failures
map to stable `update-result.error` prefixes consumed by the control plane:
`preflight_in_progress`, `preflight_disk`, `preflight_manifest`,
`preflight_trust`. Manifest signature, schema, overlay, and missing-channel
errors are `preflight_manifest`. `update-result` also carries optional
`errorCode` / `upgradeId` (legacy `error` text remains). An in-progress
reconcile still wins first. Cell `manifestUrl` / `targetCommit` / `upgradeId`
are honoured when present: env `TURBOPANEL_MANIFEST_URL` (and other pins) still
beat a message `manifestUrl`; `#applyUpdate` retains the verified
`resolveUpdate` result (commit + `manifestUrl`) so reconcile does not follow a
moving channel pointer. `targetCommit` must match that signed commit (host pin
still wins the fetch); it also short-circuits reconcile when it already matches
`getBuildInfo().commit`. A failed `statfs` is `preflight_disk`, not "enough
space". Reconcile/restart failures emit `failed` progress; restart success is
required before `update-result(ok: true)`; an already-on-target no-op emits
`done`.

**Progress (`update-progress-v1`):** when the attach `version` frame lists
`update-progress-v1`, `UpdateProgressReporter` sends fire-and-forget
`update-progress` messages (stages: `preparing`, `downloading`, `installing`,
`restarting`, `verifying`, `done`, `failed`, `rolled-back`). Events queue under
`<stateDir>/update/progress-queue.jsonl` and flush on reconnect. `run.sh` with
`--progress-markers` (always passed by `tp-orchestrate update`) prints
`::turbopanel-stage::<stage>` lines; `executeRunReconcile` streams stdout and
forwards markers. The old process reports `restarting` just before the
post-`update-result` handoff delay and systemd restart; the **new** process
reports `verifying` then `done` on first attach after a successful self-update.

**Self-healing guard:** daemon self-update arms `<runDir>/update-guard.json`
(target commit + deadline) and starts `turbopaneld-update-guard.timer` (~10
minutes, one-shot per attempt). `turbopaneld.service` uses `OnFailure=` that
unit plus a start limit so a crash-looping build can trigger
`orchestration/scripts/tp-update-guard` (root, no sudoers entry). The guard
restores `bin/turbopaneld.prev`, `bin/turbopaneld.js.prev` on JS-mode hosts,
and `share/orchestration.prev`, writes `<stateDir>/update-rollback.json`, and
restarts the daemon. A successful new build disarms via
`<stateDir>/update-guard-disarm.json` on attach (the armed file stays
root-owned `0640` with the daemon group so the process can read it). A restored
previous build reports `rolled-back` from `<stateDir>/update-rollback.json`
(also root-owned, daemon-readable; `toCommit` is parsed from
`turbopaneld v<semver> <commit> (…)` or the armed `previousCommit`).
`--no-start` / `run-installer` arms the guard and timer before returning to
`InstanceClient`; a failed `systemctl start` of the timer fails the update.
Overlapping `update` requests send `preflight_in_progress` on the rejected id
without rewriting the active reporter. Terminal failed/no-op attempts clear
`active-upgrade.json`. Progress queue append/rewrite/flush is one ordered chain.

### Daemon TLS trust model (4 paths)

The daemon validates the instance server cert on **every HTTPS connect** — both
chain trust **and** hostname (SAN). There is **no** insecure/skip-verification
mode at runtime (`run.sh --insecure-tls` only affects bootstrap `curl -k`
downloads over HTTPS, including the first fetch of a private uploaded issuer).
The control plane is HTTPS on `:8443`. Four valid
configurations:

| Path                                 | CA trust                                                                                                                                                                                     | SAN requirement                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Self-signed (self-hosted)**        | Daemon trusts the downloaded **platform CA bundle** (`TURBOPANEL_INSTANCE_CA` → `/etc/turbopanel/instance-ca.pem`, fetched from `GET /api/daemon/v1/instance/ca`). The instance stores the current root plus retired overlap PEMs under `/var/lib/turbopanel/tls/` (`ca.crt`, `ca.key`, `ca-bundle.pem`) — not the replaceable checkout. Distinct from the org TLS library. | The leaf cert **must** include the hostname the daemon dials. SANs are derived from the configured public URL(s) — `TURBOPANEL_PUBLIC_URL` / `TURBOPANEL_BASE_URL` / `TURBOPANEL_INSTANCE_URL` and `TURBOPANEL_TLS_EXTRA_SANS` (see `../turbopanel/scripts/generate-self-signed-cert.mjs`). Never hardcode the hostname.                                                                                                        |
| **Let's Encrypt**                    | Publicly-valid → daemon uses the **system trust store** (ship **no** `TURBOPANEL_INSTANCE_CA`)                                                                                               | The real cert already covers the public hostname.                                                                                                                                                                                                                                                                                                                                                                             |
| **Private uploaded certificate**     | Hostname-specific issuer at `TURBOPANEL_INSTANCE_UPLOADED_TRUST` → `/etc/turbopanel/instance-uploaded-trust.pem`, from `GET /api/daemon/v1/instance/uploaded-trust`. The installer stores it only after an issuer in that PEM signs the presented leaf and the leaf's SAN is the dialed name. It is not copied onto `instance-ca.pem`. A publicly trusted upload does not use this file. An insecure reinstall rechecks an existing file against the leaf `HOST_URL` presents; a non-404 fetch that keeps the previous issuer does not anchor bootstrap unless that issuer still verifies the active leaf. | Runtime still verifies the chain and the hostname. Bootstrap `curl -k` is not stored. A private upload whose PEM has no covering issuer is refused before an install command is emitted. |
| **Cloudflare tunnel / proxy**        | Cloudflare's edge cert is publicly-valid → **system trust**                                                                                                                                  | Daemon dials the public Cloudflare hostname, which the edge cert already covers. **Caveat:** behind a tunnel the instance cannot auto-discover its own public hostname (cloudflared dials out), so the reachable URL(s) must be **declared by the operator** (admin surface / `TURBOPANEL_PUBLIC_URL`), not auto-detected. The self-signed origin leg (cloudflared → local Caddy) is separate from what the daemon validates. |

`TURBOPANEL_INSTANCE_URL` must be `https://`. `daemon-config` `dotenv.j2`
writes that URL and the Platform CA path. Remote **Add Server** installs
pass `--host https://<host>:8443`. LAN and `*.lan` names use bootstrap
`curl -k` / `TURBOPANEL_INSECURE_TLS=1` only; automatic updates never skip
verification.

Note: `Deno.createHttpClient({ caCerts })` **adds** to the system roots (does
not replace them), so configuring the platform CA does not break validation of
publicly-trusted certs. `createHttpClientFromCaPaths` passes every
`BEGIN CERTIFICATE` block from `instance-ca.pem` and from
`instance-uploaded-trust.pem` as `caCerts`. Each reconnect re-reads those
files (mtime+size cache);
`server.tls.trust.reconcile` writes the bundle atomically to the same path
`resolveInstanceCaPath` uses (`TURBOPANEL_INSTANCE_CA` when that file exists,
else the canonical layout `instance-ca.pem`) then invalidates
that cache so the next connect (or an immediate reconnect) uses the overlap
window **before** the old root is retired. Public-URL apply / CA rotate fans
the command out over the existing WSS session.

`server.principals.reconcile` is the third `server.*` reconcile and follows the
same shape: server-scoped, carries the full desired state, no reply channel. It
exists because a deploy is the wrong trigger for a **revocation** — removing a
key must not wait for an unrelated environment to ship — and because a deploy
payload can never carry the complete set that safe removal requires. It
subsumes shell and entitlement changes too, so granting a principal PHP 8.4 no
longer means deploying one of its environments. See `../deploy/ssh/` for the
host side. `run.sh` still pins
`--cacert` first; on HTTP `000` with an existing CA it retries **once**
unpinned, then installs only if the fetched PEM parses as a CA **and**
validates the live leaf. `TURBOPANEL_INSTANCE_CA_FINGERPRINT` in `daemon.env`
is the expected first-cert fingerprint for startup mismatch logs.

