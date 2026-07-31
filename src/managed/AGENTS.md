# Managed engines (daemon runtime) — AGENTS.md

Daemon-side runtime for environment-scoped managed database/cache engines
(Postgres first). Completely separate from tenant `environment.deploy` — no
hosting Caddy, no tenant Traefik network, no user compose merge.

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
| `ingress.ts` | Per-service managed Traefik (`turbopanel-managed-<id>-ingress`) + network + port-claim persistence |
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
├── ingress/             # per-service Traefik compose (daemon-owned; not chowned)
│   └── docker-compose.yml   # mode 0640
└── backups/             # 0750; artifacts written 0600 by the daemon user itself
    └── <backupId>.<ext> # <ext> from MANAGED_BACKUP_ARTIFACT_EXTENSIONS (dump | sql)

<stateDir>/managed/ingress/
└── <managedId>.json     # per-service ManagedIngressEntry[] claim files (mode 0640)
                         # conflict detection only — not Traefik compose
```

`.env` (`TURBOPANEL_MANAGED_ROOT_PASSWORD=…`, mode `0600`) exists **only** for
the duration of `docker compose --env-file … up` and is deleted in `finally`.

Compose project names:

- Engine: `turbopanel-managed-<managedId>`
- Ingress Traefik (per service): `turbopanel-managed-<managedId>-ingress` on
  Docker network `turbopanel-managed` (shared by engines + their Traefik —
  **never** joins the tenant `turbopanel-ingress` network)
- Ingress container name: instance-allocated `<engine service.id>-ingress`

## Managed Traefik ingress

Independent of tenant `src/deploy/ingress.ts`. Each exposed managed service
gets its **own** Traefik compose project (not a host-wide shared container).
Static config is **regenerated, not hot-reloaded** (Traefik cannot add
entrypoints at runtime):

1. One `--entrypoints.<tcp|udp><port>.address=:<port>[/udp]` static arg and one
   quoted `"<bind>:<port>:<port>/<tcp|udp>"` compose `ports:` line for **this**
   service only (`http` exposures use the TCP wire protocol). Bind defaults to
   `0.0.0.0`; instance-resolved `bindAddress` is validated with the same
   IPv4/IPv6 literal allowlist as tenant `assertValidBindAddress`; IPv6
   literals are bracketed and command/port lines are quoted so YAML stays
   valid. Apply reports the same bind fallback (`0.0.0.0` when exposed without
   `bindAddress`) — never loopback for an all-interfaces bind.
2. Port-claim files persist under
   `<stateDir>/managed/ingress/<managedId>.json`. `syncManagedIngressEntries`
   checks every *other* service's file and throws
   `ManagedPortConflictError` (`kind: managed_port_conflict`) on
   **wire-protocol**+published-port collision (`http` and `tcp` share TCP) —
   **no partial write**. Sync returns **this service's own entries** (not a
   host-wide merge); removal no longer restarts other services' Traefik.
3. Compose self-describes via `x-turbopanel: { kind: ingress, managedId,
   serviceId, containerName }` plus Docker labels
   `turbopanel.managed.id=<managedId>` / `turbopanel.role=ingress`. The Docker
   provider is constrained with
   `--providers.docker.constraints=Label(\`turbopanel.managed.id\`,\`<id>\`)`
   so this Traefik only routes its own engine (which carries the matching
   `turbopanel.managed.id` + `turbopanel.role=engine` labels).
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
6. **Legacy teardown:** `teardownLegacyManagedIngress` best-effort `down`s the
   old host-wide `turbopanel-managed-ingress` project and removes
   `<stateDir>/managed/ingress/traefik/` on apply **and** destroy
   (pre-release hosts). Destroy must call it — the old shared path used to
   reconfigure Traefik with an empty entry set instead of `compose down`,
   which left `turbopanel-managed-ingress-traefik-1` running after the last
   managed service was deleted.
7. **Trade-off:** N exposed services ⇒ N small Traefik containers, each with a
   read-only Docker socket mount — apply/lifecycle/destroy touch only that
   service's ingress.

Apply syncs this service's ingress **before** engine `compose up` so port
conflicts fail early and the managed network exists before the engine joins
it. Destroy downs (1) the engine project, (2) this service's Traefik via
`removeManagedIngress` + claim-file removal, then (3) any leftover legacy
shared Traefik via `teardownLegacyManagedIngress`.
`removeManagedIngress` downs the compose project **and deletes**
`<managedId>/ingress/` so a later `managed.lifecycle` start/restart cannot
treat a stale compose file as active. `exposure.enabled=false` uses the same
per-service remove path (without legacy teardown). `ManagedPortConflictError`
propagates as the command-outcome error string for the UI.

## Rules

1. **Container names from the instance.** The instance supplies engine
   `containerName` (`<service.id>-1`) and, when exposed,
   `ingress.{serviceId, composeServiceName, containerName}` where `serviceId`
   is the **engine's own** service id and `containerName` is
   `<engine service.id>-ingress` — there is **no** separate ingress `service`
   row; the row is a `role='ingress'`, ordinal-1 `container` row on the engine
   service. `normalizeManagedCompose` / `managedTraefikCompose` write them as
   `container_name`. `assertSafeManagedIdentifiers` guards both with the
   hyphen-permitting Docker-name regex (do not reuse `SAFE_VOLUME_NAME_RE`).
   Container resolution (`containers.ts`) still keys off `Service` / `State`,
   never `Name`.
2. **Native port, never remapped.** Normalized compose never emits `ports:`.
   The container listens on the engine native port; exposure is Traefik's job
   via `turbopanel-managed` + TCP router labels.
3. **Config is verbatim.** The daemon does **not** rebuild `postgresql.conf`
   (or peer engine files). The instance engine spec is the single source of
   truth for base + operator snippet + `ssl = on`. Re-apply **unlinks then
   recreates** each config file — after ownership normalization they are
   often `root:<engineGroup>` `0640`, which the daemon cannot open for
   write, but it owns the parent directory so unlink+create succeeds.
4. **Secrets.** Credential envelopes decrypt in memory → root password reaches
   compose only through the short-lived `0600` env-file → deleted after `up`.
   Plaintext never lands in `docker-compose.yml` on disk and never appears in
   logs (`redactSecrets` + `sanitizeForLog`). SQL/password input uses
   `runDocker(…, { input })` stdin — never argv.
5. **Ownership normalization.** Files written by the daemon user are unreadable
   by the container engine user. `normalizeManagedFileOwnership` runs one
   throwaway `docker run --user 0` of the engine image to `chown`/`chmod`
   **only** the bind-mounted trees (`config/`, `tls/`) — never
   `docker-compose.yml`, the short-lived `.env`, or `backups/` (those stay
   daemon-owned so re-apply can rewrite them). Owner/group names come from
   the engine runtime descriptor — never hardcoded in shared code. Modes:
   `0640` → `root:<engineGroup>`; `0600` → `<engineUser>:<engineGroup>`;
   directories keep the daemon UID as owner but take `<engineGroup>` + `0750` so
   the engine user can traverse mounts like `./config:/etc/postgresql`
   (file-only chown left dirs as `daemon:daemon` `0750` and caused Postgres
   "Permission denied" on `postgresql.conf`). Whole-tree chown previously
   made `docker-compose.yml` `root:<engineGroup>` `0640` and broke re-apply
   with `writefile` Permission denied.
6. **Engine extension.** One file under `engines/` implementing
   `ManagedEngineRuntime` (+ `supportsSni`) + one registry entry in
   `engines/index.ts`.
7. **Tenant isolation.** Never import or mutate tenant Traefik / hosting
   Caddy state from this package beyond shared helpers (`assertValidBindAddress`,
   `runDocker`).
8. **Backup/restore (`backup.ts`).** Optional per engine via
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
