# Managed engines (daemon runtime) — AGENTS.md

Daemon-side runtime for environment-scoped managed database/cache engines
(Postgres first). Completely separate from tenant `environment.deploy` — no
hosting-edge Caddy, no tenant Traefik network, no user compose merge.

Root context: `../../AGENTS.md`. Instance engine specs:
`../../../instance/src/lib/managed/AGENTS.md`. Command contracts:
`../instance/commands/contracts.ts`.

## Module map

| File | Role |
| --- | --- |
| `paths.ts` | State-dir layout + identifier / relative-path guards; `managedBackupsDir` / `managedBackupArtifactPath` |
| `compose.ts` | Platform compose normalization (image, volumes, resources, exposure labels) |
| `materialize.ts` | Write `config/` verbatim; ownership normalization via throwaway container (skips `backups/`) |
| `tls.ts` | Self-signed cert generation (`openssl`) under `tls/` |
| `ingress.ts` | Managed Traefik (`turbopanel-managed-ingress`) + network + entry persistence |
| `containers.ts` | Shared `docker compose ps` collection + running-container resolution used by `apply.ts` and `backup.ts` |
| `apply.ts` / `lifecycle.ts` / `destroy.ts` | Command handlers (wired from `command-router.ts`) |
| `backup.ts` | `managed.backup` (`create`/`delete`) + `managed.restore` command handlers — streamed dump/restore, checksum, prune |
| `logs.ts` | Bounded `compose logs`; transported via cell `managed-logs-request` / `managed-logs-result` (not a command) |
| `engines/` | Per-engine runtime registry (`postgres` first); optional `dropUsers` for `managed.apply` `dropUsers[]`; optional `backup` for `managed.backup`/`managed.restore` |

## State tree

```
<stateDir>/managed/<managedId>/
├── docker-compose.yml   # normalized runtime compose (mode 0640)
├── config/              # engine config files (verbatim from payload)
│   └── postgresql.conf
├── tls/                 # sibling of config/ — matches `./tls` mount
│   ├── server.crt       # 0640
│   └── server.key       # 0600
└── backups/             # 0750; artifacts written 0600 by the daemon user itself
    └── <backupId>.<ext> # <ext> from MANAGED_BACKUP_ARTIFACT_EXTENSIONS (dump | sql)

<stateDir>/managed/ingress/
├── <managedId>.json     # per-service ManagedIngressEntry[] (mode 0640)
└── traefik/
    └── docker-compose.yml   # managed Traefik static config (mode 0640)
```

`.env` (`TURBOPANEL_MANAGED_ROOT_PASSWORD=…`, mode `0600`) exists **only** for
the duration of `docker compose --env-file … up` and is deleted in `finally`.

Compose project names:

- Engine: `turbopanel-managed-<managedId>`
- Ingress Traefik: `turbopanel-managed-ingress` on Docker network
  `turbopanel-managed` (created via the same `ensureIngressNetwork` pattern as
  tenant `turbopanel-ingress` — **never** joins the tenant network)

## Managed Traefik ingress

Independent of tenant `src/deploy/ingress.ts`. Static config is **regenerated,
not hot-reloaded** (Traefik cannot add entrypoints at runtime):

1. One `--entrypoints.<tcp|udp><port>.address=:<port>[/udp]` static arg and one
   quoted `"<bind>:<port>:<port>/<tcp|udp>"` compose `ports:` line per exposed
   service (`http` exposures use the TCP wire protocol). Bind defaults to
   `0.0.0.0`; instance-resolved `bindAddress` (public pinned IP / datacenter IP /
   `127.0.0.1`) is validated with the same IPv4/IPv6 literal allowlist as
   tenant `assertValidBindAddress` before interpolation; IPv6 literals are
   bracketed and the whole mapping is quoted so YAML does not treat `[…]` as a
   flow sequence. Apply reports the same bind fallback (`0.0.0.0` when
   exposed without `bindAddress`) — never loopback for an all-interfaces bind.
2. Per-service entries persist under
   `<stateDir>/managed/ingress/<managedId>.json`. `syncManagedIngressEntries`
   merges every *other* service's file and throws
   `ManagedPortConflictError` (`kind: managed_port_conflict`) on
   **wire-protocol**+published-port collision (`http` and `tcp` share TCP) —
   **no partial write**. Entries are deduped and sorted so Traefik only
   restarts when the entrypoint set really changes.
3. `removeManagedIngressEntries` returns `null` when the service had none
   (apply/destroy short-circuit a pointless Traefik restart) — same idiom as
   tenant `removeTcpUdpIngressEntries`.
4. Engine containers join `turbopanel-managed` and carry Traefik Docker labels
   (`compose.ts`): TCP router + `loadbalancer.server.port` = native container
   port. **No** TLS termination, ACME, or `auto_https` on managed Traefik —
   Postgres negotiates TLS end to end.
5. **SNI seam (structure only):** `ManagedIngressEntry.sni?.hostnames` plus
   `ManagedEngineRuntime.supportsSni`. `managedTcpRouterRule` emits explicit
   `HostSNI(\`h1\`,\`h2\`)` only when `supportsSni` is true; Postgres sets
   `supportsSni: false` and always takes catch-all `HostSNI(\`*\`)`. Do not
   build hostname/TLS material handling here — the branch exists for a future
   HTTP-ish engine (e.g. ClickHouse).

Apply syncs ingress **before** engine `compose up` so port conflicts fail
early and the managed network exists before the engine joins it. Destroy
removes entries and re-syncs Traefik only when the service actually had any.
`ManagedPortConflictError` propagates as the command-outcome error string for
the UI.

## Rules

1. **Native port, never remapped.** Normalized compose never emits `ports:`.
   The container listens on the engine native port; exposure is Traefik's job
   via `turbopanel-managed` + TCP router labels.
2. **Config is verbatim.** The daemon does **not** rebuild `postgresql.conf`
   (or peer engine files). The instance engine spec is the single source of
   truth for base + operator snippet + `ssl = on`.
3. **Secrets.** Credential envelopes decrypt in memory → root password reaches
   compose only through the short-lived `0600` env-file → deleted after `up`.
   Plaintext never lands in `docker-compose.yml` on disk and never appears in
   logs (`redactSecrets` + `sanitizeForLog`). SQL/password input uses
   `runDocker(…, { input })` stdin — never argv.
4. **Ownership normalization.** Files written by the daemon user are unreadable
   by the container engine user. `normalizeManagedFileOwnership` runs one
   throwaway `docker run --user 0` of the engine image to `chown`/`chmod`
   bind-mounted files. Owner/group names come from the engine runtime
   descriptor — never hardcoded in shared code. **`backups/` is pruned from
   every `find` in that script** — backup artifacts are written `0600` by the
   *daemon* user (not the container engine user) so the daemon can read them
   back for checksum/restore; chowning them to the container user would break
   that.
5. **Engine extension.** One file under `engines/` implementing
   `ManagedEngineRuntime` (+ `supportsSni`) + one registry entry in
   `engines/index.ts`.
6. **Tenant isolation.** Never import or mutate tenant Traefik / hosting-edge
   Caddy state from this package beyond shared helpers (`assertValidBindAddress`,
   `runDocker`).
7. **Backup/restore (`backup.ts`).** Optional per engine via
   `ManagedEngineRuntime.backup` (`ManagedBackupNotSupportedError` when absent).
   - **Stream, never buffer.** Dump stdout pipes directly to a `<backupId>.<ext>.part`
     file opened at `0600`; restore pipes the artifact file straight into
     `docker exec -i <cid> <restoreArgv>` stdin. The command result carries
     **only metadata** (`path`, `sizeBytes`, `checksum`, timestamps) — dump
     bytes never appear on the wire. `runDocker` (buffers stdout as text) is
     never used for dump/restore; use `spawnDockerStreaming`
     (`src/deploy/docker-cli.ts`) instead.
   - **Checksum before restore.** `handleManagedRestore` verifies the
     artifact's size (when the payload supplies one) and SHA-256 against
     `payload.checksum` **before** touching the running engine container. A
     mismatch throws without ever invoking `docker exec`.
   - **`.part` cleanup on failure.** Any non-zero dump exit or thrown error
     removes the `.part` file — a partial artifact must never look like a
     complete one.
   - **Prune by payload retention.** After a successful create, list the
     backups dir, keep the newest `payload.retentionKeep` artifacts by mtime
     (plus the one just written), unlink the rest, and report their ids as
     `result.pruned[]`. When `retentionKeep` is omitted, nothing is pruned —
     the instance is expected to always resolve a retention value from
     `ManagedSettings.backups.retentionKeep` or the engine's
     `defaultRetentionKeep` before enqueueing.
   - **`managed.destroy` removes `backups/` too** — it is inside `managedDir`,
     so the existing `Deno.remove(root, { recursive: true })` already covers
     it; no separate cleanup path exists or should be added.
   - **Scheduled backups are an explicit future seam** — there is no timer or
     scheduler anywhere in this module; every backup is operator/API-triggered.
   - Container resolution reuses `containers.ts` — backup/restore only know
     `managedId` (not the user compose document), so they resolve the *sole*
     container in the compose project (`resolveSoleEngineContainer`) rather
     than matching a specific `composeServiceName`.
