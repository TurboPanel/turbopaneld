# AGENTS.md

TurboPanel **daemon** — Ansible-driven node agent; connects to the instance over HTTPS/WSS (or Unix socket when co-located).

## Documentation discipline

**Keep this file current.** When you learn something durable about daemon ↔ instance contracts — WS presence, reconnect behavior, command handlers, orchestration — add or update a note here in the same PR/session as the code change. Cross-repo cell/cost rules live in `../instance/AGENTS.md` (Daemon Cell section); link there instead of duplicating DO hibernation detail.

## Filesystem layout & path model (dev vs prod)

`src/paths/layout.ts` is the **single source of truth** for every managed install location. `resolveLayout(env, opts)` returns mode-aware defaults; `detectInstallMode()` picks `development` vs `production` (a resolvable daemon checkout — `orchestration/ansible.cfg` or `main.ts`, and not a `deno-compile-*` extraction dir — means development, otherwise production). Every path is env-overridable (`TURBOPANEL_HOME`, `TURBOPANEL_BIN_DIR`, `TURBOPANEL_LIB_DIR`, `TURBOPANEL_RUNTIME_DIR`, `TURBOPANEL_SHARE_DIR`, `TURBOPANEL_UI_DIR`, `TURBOPANEL_ORCHESTRATION_DIR`, `TURBOPANEL_CONFIG_DIR`, `TURBOPANEL_STATE_DIR`, `TURBOPANEL_DAEMON_STATE_DIR`, `TURBOPANEL_LOG_DIR`, `TURBOPANEL_RUN_DIR`, `TURBOPANEL_RUNTIMES_DIR`, `TURBOPANEL_DAEMON_ROOT`). `src/orchestration/paths.ts` and `src/instance/paths.ts` derive their constants from `resolveLayout` — do **not** hardcode absolute paths in runtime code; add/extend a layout field instead. The development default checkout root is `<devRoot>/daemon` (from `TURBOPANEL_DEV_ROOT` / `$HOME`); production runtime code must never name the retired `/opt/turbopanel/platform` token — the layout module and CI guard are the only places allowed to reference it.

**Production (managed / FHS)** — compiled release, no source checkout:

| Purpose | Path |
|---|---|
| Native daemon binary | `/opt/turbopanel/bin/turbopaneld` |
| JS fallback (`deno run`) | `/opt/turbopanel/bin/turbopaneld.js` |
| Managed update helper | `/opt/turbopanel/bin/turbopanel-update` |
| Orchestration assets (Ansible) | `/opt/turbopanel/share/orchestration` |
| Static UI export | `/opt/turbopanel/share/ui` |
| Vendored runtimes (node/deno/caddy/uv/python/ansible/cloudflared) | `/opt/turbopanel/lib/runtime` |
| Daemon install root (`daemonRootDefault`) | `/opt/turbopanel/lib/daemon` |
| Config (`daemon.env`, `instance-ca.pem`) | `/etc/turbopanel` |
| Persistent identity (license, `server.id`, keys, tunnels) | `/var/lib/turbopanel` |
| Logs | `/var/log/turbopanel` |
| Runtime (sockets, `daemon.lock`) | `/run/turbopanel` |

**Development (co-located checkout)** — `./console` from `turbopanel-dev` runs the daemon from source (`deno run main.ts`); all mutable paths are **dev-user-owned**:

| Purpose | Path |
|---|---|
| Daemon checkout / install root | `<TURBOPANEL_DEV_ROOT|$HOME>/daemon` |
| Orchestration assets | `<checkout>/orchestration` (prod roles) + `dev/orchestration/` overlay |
| Vendored runtimes | `/opt/turbopanel/lib/runtime` |
| Daemon env file | `/etc/turbopanel/daemon.env` |
| Daemon state | `/var/lib/turbopanel` |
| Logs | `/var/log/turbopanel` |
| Config dir | `/etc/turbopanel` |
| Runtime (sockets, `daemon.lock`) | `/run/turbopanel` |

**Development identity:** co-located dev creates **no** dedicated `turbopanel`, `turbopaneli`, or `turbopanelc` service accounts. The `turbopaneld`, instance, UI, and Caddy systemd units, plus Docker-backed services (Postgres, Redis, RabbitMQ, Mailpit), all run as the **current dev user**. Production managed installs keep the dedicated service users described in the production table above.

**Deno version pin:** `DENO_VERSION` (`src/orchestration/paths.ts`) = **`2.9.0`**. Keep it in step with `deno_version` in `orchestration/roles/deno-runtime/defaults/main.yml`, `TP_DENO_VERSION` in `scripts/run.sh`, and `DENO_VERSION` in `turbopanel-dev`'s `src/lib/paths.ts` (dev console bootstrap fallback + status label). `src/orchestration/paths.test.ts` pins the const to the role default.

**Vendored Node/Deno layout:** Ansible roles install pinned runtimes under `/opt/turbopanel/lib/runtime/<tool>/<version>/` with a `current` symlink (see `node-runtime`, `deno-runtime`, `caddy`). Consumers resolve `turbopanel_node` (`…/node/current/bin/node`), `turbopanel_deno` (`…/deno/current/deno`), and `turbopanel_runtime_path` (colon-separated PATH prefix for systemd/Ansible tasks). Node **24.17.0** is pinned in `node-runtime/defaults/main.yml` — keep in step with `NODE_VERSION` in turbopanel-dev `scripts/lib/paths.sh`.

**Guards / tests:**
- `deno task check:layout` (`scripts/check-production-layout.ts`) — asserts the production FHS tree resolves to the canonical absolute paths and that no production source (`src/**`, excluding `*.test.ts` and `src/paths/layout.ts`) references `/opt/turbopanel/platform` or the retired `share/ansible`. Wired into `publish-daemon-trunk.yml`.
- `src/orchestration/paths.test.ts` — production/dev default trees, env overrides, and the `DENO_VERSION` ↔ role pin (`deno test src/orchestration/paths.test.ts`).
- `scripts/verify-release-root.sh` / `tp_verify_release_root` (`scripts/lib/release-artifacts.sh`) — reject dev-only paths, TS sources, `share/ansible`, or a leaked daemon source tree in a packaged release root.

## Instance client (`src/instance/client.ts`)

`InstanceClient` maintains the daemon's authenticated WSS (or co-located Unix socket) to `/ws/daemon/v1`. Enrollment + JWT session issuance happen over REST first; the socket carries live traffic only (outbox delivery, command dispatch, dev-sync, tunnel-token, etc.).

**Co-located dev connectivity** (`src/orchestration/setup.ts`, `src/instance/paths.ts`): after console opt-in (`TURBOPANEL_DEV_INSTANCE=1`), Deno runtime dials the local Unix socket (no `TURBOPANEL_INSTANCE_URL`); Workers runtime dials Caddy over HTTPS/WSS via `TURBOPANEL_INSTANCE_URL` + platform CA — same transport as a remote daemon, but still the co-located host. Connection stays deferred until opt-in on both runtimes.

### Idle presence (`src/instance/idle-presence.ts`)

`IdlePresence` runs per open socket:

- Sends `{ type: "hello", at, agent }` once on attach.
- After **~60 s** of inbound silence (`IDLE_PRESENCE_MS`), sends the wire **`{"type":"ping"}`** cell ping (must match `DAEMON_CELL_PING` in `instance/src/daemon/cell/protocol.ts`). On Workers the DO answers via `setWebSocketAutoResponse` without waking the object; on self-hosted Redis the same ping updates cell `lastSeenAt`.
- Sends app-level `{ type: "heartbeat", at }` **only when the build agent commit changed** since the last hello/heartbeat — not on every idle tick.

**Reconnect jitter:** `InstanceClient` reconnects with **full-jitter** backoff in `[initialBackoffMs, currentBackoffMs]` (defaults 2 s → 30 s cap, doubling on auth failures). A benign close after a stable session (`STABLE_SESSION_MS`, 5 s) resets backoff to the initial floor so fleet-wide restarts do not align into a thundering herd.

**Single-daemon guarantee:** only one live cell attachment per server. Runtime backstop is the instance cell's **single-writer lease** on attach (`attachDaemonSocket` / `detachDaemonSocket`). On managed hosts, `share/orchestration/scripts/ensure-single-daemon.sh` (systemd `ExecStartPre`) adds a **flock** on `/run/turbopanel/daemon.lock` so a second `turbopaneld.service` cannot start. Manual `deno task start/dev` bypasses flock (dev-only). Canonical cell semantics and cost rules: **`../instance/AGENTS.md`** (Daemon Cell).

**Managed install layout (FHS):** `run.sh` installs the clean release package into `/opt/turbopanel/bin/{turbopaneld,turbopaneld.js,turbopanel-update}` and `/opt/turbopanel/share/orchestration/`. Config lives in `/etc/turbopanel` (`daemon.env`, `instance-ca.pem`); persistent identity in `/var/lib/turbopanel` (license, `server.id`, keys); runtime files in `/run/turbopanel`. The installer probes `turbopaneld --version` and selects native `ExecStart` or the Deno JS-fallback (`…/lib/runtime/deno/bin/deno run --allow-all …/bin/turbopaneld.js`) with `EnvironmentFile=/etc/turbopanel/daemon.env`. Co-located dev keeps `deno run main.ts` from the home checkout via `daemon-systemd-setup.yml` and logs to `/var/log/turbopanel`.

**Managed update helper:** `scripts/update.sh` is packaged into the release tarball and installed as `/opt/turbopanel/bin/turbopanel-update` (release staging via `tp_stage_release_update_helper`; `tp_verify_release_root` full mode requires it). It is the checkout-free manual refresh path (`sudo sh /opt/turbopanel/bin/turbopanel-update`): it reads the license/channel from `/var/lib/turbopanel` + `/etc/turbopanel` and pipes `https://trbp.nl/run.sh` — it does **not** depend on a source checkout.

### Daemon TLS trust model (4 paths)

The daemon validates the instance server cert on **every HTTPS connect** — both chain trust **and** hostname (SAN). There is **no** insecure/skip-verification mode at runtime (`run.sh --insecure-tls` only affects bootstrap `curl -k` downloads over HTTPS). Four valid configurations:

| Path | CA trust | SAN requirement |
|---|---|---|
| **Plaintext HTTP dev control plane** | none — no CA is fetched, stored, or configured (`run.sh` skips the CA-fetch block and omits `turbopanel_instance_ca`; `createInstanceHttpClient` short-circuits before any CA/cert handling) | none — there is no TLS handshake; the daemon dials `ws://`/`http://` directly |
| **Self-signed (self-hosted)** | Daemon trusts the downloaded platform CA (`TURBOPANEL_INSTANCE_CA`, fetched from `GET /api/daemon/v1/instance/ca`) | The leaf cert **must** include the hostname the daemon dials. SANs are derived from the configured public URL(s) — `TURBOPANEL_PUBLIC_URL` / `TURBOPANEL_BASE_URL` / `TURBOPANEL_INSTANCE_URL` and `TURBOPANEL_TLS_EXTRA_SANS` (see `../instance/scripts/generate-self-signed-cert.mjs`). Never hardcode the hostname. |
| **Let's Encrypt** | Publicly-valid → daemon uses the **system trust store** (ship **no** `TURBOPANEL_INSTANCE_CA`) | The real cert already covers the public hostname. |
| **Cloudflare tunnel / proxy** | Cloudflare's edge cert is publicly-valid → **system trust** | Daemon dials the public Cloudflare hostname, which the edge cert already covers. **Caveat:** behind a tunnel the instance cannot auto-discover its own public hostname (cloudflared dials out), so the reachable URL(s) must be **declared by the operator** (admin surface / `TURBOPANEL_PUBLIC_URL`), not auto-detected. The self-signed origin leg (cloudflared → local Caddy) is separate from what the daemon validates. |

The plaintext HTTP path targets the dev-only `:8880` entrypoint in `../instance/Caddyfile` (see **`../instance/AGENTS.md`** "Caddy (dev + production)" — dev-only plaintext HTTP entrypoint). It requires `TURBOPANEL_DEV_HTTP_CONTROL_PLANE=1` on co-located dev hosts and is never valid on managed or production installs.

Note: `Deno.createHttpClient({ caCerts })` **adds** to the system roots (does not replace them), so configuring the platform CA does not break validation of publicly-trusted certs.
