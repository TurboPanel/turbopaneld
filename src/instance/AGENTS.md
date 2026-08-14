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
license notes).

**Co-located dev connectivity** (`src/orchestration/setup.ts`,
`src/instance/paths.ts`): after console opt-in (`TURBOPANEL_DEV_INSTANCE=1`),
Deno runtime dials the local Unix socket (no `TURBOPANEL_INSTANCE_URL`); Workers
runtime dials Caddy over HTTPS/WSS via `TURBOPANEL_INSTANCE_URL` + platform CA —
same transport as a remote daemon, but still the co-located host. Connection
stays deferred until opt-in on both runtimes.

### Idle presence (`src/instance/idle-presence.ts`)

`IdlePresence` runs per open socket:

- Sends `{ type: "hello", at, daemonBuild, hostname?, machineKey?, os?,
  inventory?, timeSync?, addresses? }` once on attach. `machineKey` is a
  derived, non-reversible HMAC of `/etc/machine-id` (`src/host/machine-key.ts`)
  — warmed on the connect path before hello. Host OS comes from
  `/etc/os-release` (+ `/etc/debian_version`, `/etc/rpi-issue`) via
  `src/host/os-release.ts` (`getHostHelloIdentity()`). Prefer dotted
  point-release (`DEBIAN_VERSION_FULL` / `debian_version`, e.g. `13.5`) over
  bare `VERSION_ID`. Raspberry Pi OS / Raspbian set
  `variant: "raspberry-pi-os"` (`ID=raspbian` or `/etc/rpi-issue` present —
  64-bit Pi OS still reports `ID=debian`). **Host inventory** (static
  capacity: `cpuCores` (physical), `cpuThreads` (logical / for load
  bars), `memoryTotalBytes`, `swapTotalBytes`) comes from `/proc/stat` +
  `/proc/cpuinfo` + `/proc/meminfo` via `src/host/host-inventory.ts` — process-
  cached; sent on hello only (not heartbeat). Time sync facts come from
  `src/host/time-sync.ts` (`timedatectl` + `/etc/systemd/timesyncd.conf`);
  addresses from `collectServerAddresses()` (`src/server-addresses.ts`). The
  instance persists `os` on `server.metadata.os` and `inventory` on
  `server.metadata.inventory`, and exposes them on
  `GET /api/client/v1/servers`. All new hello fields stay optional for
  back-compat.
- After **~60 s** of inbound silence (`IDLE_PRESENCE_MS`), sends the wire
  **`{"type":"ping"}`** cell ping (must match `DAEMON_CELL_PING` in
  `turbopanel/src/daemon/cell/protocol.ts`). On Workers the DO answers via
  `setWebSocketAutoResponse` without waking the object; on self-hosted Redis the
  same ping updates cell `lastSeenAt`. When the min-presence interval equals the
  check interval (default), `IdlePresence` allows ~5s of `setInterval` skew so
  early ticks still send — otherwise early fires were skipped and Redis coalesce
  could false-demote a live socket.
- Sends app-level `{ type: "heartbeat", at, daemonBuild?, timeSync?, addresses? }`
  when the daemon build commit changed **or** when `timeSync` / `addresses`
  differ from the snapshot seeded on hello (change-detected, still cadence-bound
  to the ~60s idle tick). Do **not** put OS on heartbeat. Offline self-heal
  (Postgres `connected: false` while the socket is still live) is handled by the
  instance **offline-sweep cron** re-projecting online via `onDaemonConnected`
  — not by a periodic daemon heartbeat.
- Command handlers `server.timezone.set` / `server.ntp.set`
  (`src/instance/commands/timezone.ts`, `ntp.ts`) apply via
  `runTimeSyncApply` → `time-sync-apply.yml` and return observed host state
  from `readTimeSync()`. Wire contracts live in
  `src/instance/commands/contracts.ts` and must stay aligned with the instance
  canonical `server.timezone.set` / `server.ntp.set` shapes.
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
other).

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
`400 Server key mismatch` → recover + re-enroll), or `permanent`
(`401 Invalid license`, `400 License already consumed or invalid`,
`400 License is inactive`, `400 Server key is inactive`,
`403 Invalid signature`, `409 Fingerprint already exists`, and the local
`missing license credentials for enrollment` → **park**). On `permanent`,
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
`token-manager.ts` skips its 2 s session-refresh retry on a `permanent` first
error (no double challenge+session per cycle). Status → action table:
**`../turbopanel/AGENTS.md`** (Daemon key authentication — do-not-retry-soon
table).

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
install/update; Deno is installed only when the JS ExecStart is selected
(`daemon-install.yml` skips `deno-runtime` otherwise). Config lives in
`/etc/turbopanel` (`daemon.env`, `instance-ca.pem`); persistent identity in
`/var/lib/turbopanel` (license, `server.id`, keys); runtime files in
`/run/turbopanel`. Co-located dev keeps `deno run main.ts` from the home
checkout via `daemon-systemd-setup.yml` and logs to `/var/log/turbopanel`.

**Managed updates:** the running daemon reconciles in-place via `run.sh`
(downloaded from `turbopanel.sh`, or from `<instance>/run.sh` when dialing the
**dev overlay** plaintext HTTP control plane) when triggered
from the control-plane UI or manually with the same piped installer
(`curl -fsSL turbopanel.sh | TURBOPANEL_LICENSE=… sh`; optional
`TURBOPANEL_HOST` / `TURBOPANEL_INSECURE_TLS=1`). Flags (`--license`, `--host`,
…) remain supported for scripts and sudo re-exec. There is no separate update
binary installed under `/opt/turbopanel/bin/`.

### Daemon TLS trust model (4 paths)

The daemon validates the instance server cert on **every HTTPS connect** — both
chain trust **and** hostname (SAN). There is **no** insecure/skip-verification
mode at runtime (`run.sh --insecure-tls` only affects bootstrap `curl -k`
downloads over HTTPS). Four valid configurations:

| Path                                 | CA trust                                                                                                                                                                                     | SAN requirement                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Plaintext HTTP dev control plane** | none — no CA is fetched, stored, or configured (`run.sh` skips the CA-fetch block and omits `turbopanel_instance_ca`; `createInstanceHttpClient` short-circuits before any CA/cert handling) | none — there is no TLS handshake; the daemon dials `ws://`/`http://` directly                                                                                                                                                                                                                                                                                                                                                 |
| **Self-signed (self-hosted)**        | Daemon trusts the downloaded platform CA (`TURBOPANEL_INSTANCE_CA`, fetched from `GET /api/daemon/v1/instance/ca`)                                                                           | The leaf cert **must** include the hostname the daemon dials. SANs are derived from the configured public URL(s) — `TURBOPANEL_PUBLIC_URL` / `TURBOPANEL_BASE_URL` / `TURBOPANEL_INSTANCE_URL` and `TURBOPANEL_TLS_EXTRA_SANS` (see `../turbopanel/scripts/generate-self-signed-cert.mjs`). Never hardcode the hostname.                                                                                                        |
| **Let's Encrypt**                    | Publicly-valid → daemon uses the **system trust store** (ship **no** `TURBOPANEL_INSTANCE_CA`)                                                                                               | The real cert already covers the public hostname.                                                                                                                                                                                                                                                                                                                                                                             |
| **Cloudflare tunnel / proxy**        | Cloudflare's edge cert is publicly-valid → **system trust**                                                                                                                                  | Daemon dials the public Cloudflare hostname, which the edge cert already covers. **Caveat:** behind a tunnel the instance cannot auto-discover its own public hostname (cloudflared dials out), so the reachable URL(s) must be **declared by the operator** (admin surface / `TURBOPANEL_PUBLIC_URL`), not auto-detected. The self-signed origin leg (cloudflared → local Caddy) is separate from what the daemon validates. |

The plaintext HTTP path targets the **dev overlay** Caddyfile at
`../dev/orchestration/Caddyfile` (`:8880`, always on when that file is loaded —
see **`../dev/AGENTS.md`**). The production `../turbopanel/Caddyfile` has no
plaintext listener. The daemon refuses `TURBOPANEL_INSTANCE_URL=http://…`
unless `TURBOPANEL_DEV_HTTP_CONTROL_PLANE=1` is set (client-side gate for
dialing a development control plane — never valid on managed/production
installs that serve HTTPS only). Remote **Add Server** installs that pass
`--host http://…:8880` get the opt-in in `/etc/turbopanel/daemon.env`:
`daemon-config` `dotenv.j2` is the only writer (derives it from the URL).
`scripts/run.sh` validates the line after install and fails if missing —
it does not patch `daemon.env` outside Ansible. HTTPS `--host` installs never
write the flag.

Note: `Deno.createHttpClient({ caCerts })` **adds** to the system roots (does
not replace them), so configuring the platform CA does not break validation of
publicly-trusted certs.

