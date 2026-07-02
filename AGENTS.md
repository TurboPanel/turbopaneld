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
