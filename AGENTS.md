# AGENTS.md

TurboPanel **daemon** — Ansible-driven node agent; connects to the instance over HTTPS/WSS (or Unix socket when co-located).

## Documentation discipline

**Keep this file current.** When you learn something durable about daemon ↔ instance contracts — WS presence, reconnect behavior, command handlers, orchestration — add or update a note here in the same PR/session as the code change. Cross-repo cell/cost rules live in `../instance/AGENTS.md` (Daemon Cell section); link there instead of duplicating DO hibernation detail.

## Instance client (`src/instance/client.ts`)

`InstanceClient` maintains the daemon's authenticated WSS (or co-located Unix socket) to `/ws/daemon/v1`. Enrollment + JWT session issuance happen over REST first; the socket carries live traffic only (outbox delivery, command dispatch, dev-sync, tunnel-token, etc.).

### Idle presence (`src/instance/idle-presence.ts`)

`IdlePresence` runs per open socket:

- Sends `{ type: "hello", at, agent }` once on attach.
- After **~60 s** of inbound silence (`IDLE_PRESENCE_MS`), sends the wire **`{"type":"ping"}`** cell ping (must match `DAEMON_CELL_PING` in `instance/src/daemon/cell/protocol.ts`). On Workers the DO answers via `setWebSocketAutoResponse` without waking the object; on self-hosted Redis the same ping updates cell `lastSeenAt`.
- Sends app-level `{ type: "heartbeat", at }` **only when the build agent commit changed** since the last hello/heartbeat — not on every idle tick.

**Reconnect jitter:** `InstanceClient` reconnects with **full-jitter** backoff in `[initialBackoffMs, currentBackoffMs]` (defaults 2 s → 30 s cap, doubling on auth failures). A benign close after a stable session (`STABLE_SESSION_MS`, 5 s) resets backoff to the initial floor so fleet-wide restarts do not align into a thundering herd.

**Single-daemon guarantee:** only one live cell attachment per server. Runtime backstop is the instance cell's **single-writer lease** on attach (`attachDaemonSocket` / `detachDaemonSocket`). On managed hosts, `scripts/ensure-single-daemon.sh` (systemd `ExecStartPre`) adds a **flock** on `/run/turbopanel/daemon.lock` so a second `turbopanel-daemon.service` cannot start. Manual `deno task start/dev` bypasses flock (dev-only). Canonical cell semantics and cost rules: **`../instance/AGENTS.md`** (Daemon Cell).

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
