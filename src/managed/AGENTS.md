# Managed engines (daemon runtime) — AGENTS.md

Daemon-side runtime for environment-scoped managed database/cache engines
(Postgres first). Completely separate from tenant `environment.deploy` — no
hosting Caddy, no tenant Traefik network, no user compose merge. Frontend
access for managed engines is **one shared ProxySQL** per server
(`turbopanel-proxysql`), not per-service Traefik.

Root context: `../../AGENTS.md`. Instance engine specs:
`../../../turbopanel/src/lib/managed/AGENTS.md`. Command contracts:
`../instance/commands/contracts.ts`. Host prerequisites:
`../../orchestration/AGENTS.md` → **ProxySQL (`proxysql`)**.

## Module map

| File | Role |
| --- | --- |
| `paths.ts` | Managed state-dir layout + identifier / relative-path guards; `managedBackupsDir` / `managedBackupArtifactPath`; ProxySQL layout helpers (`proxysqlConfigDir`, `proxysqlComposePath`, `proxysqlConfigPath`, `proxysqlTlsDir`, `proxysqlDataDir`, `proxysqlAdminCnfPath`, `PROXYSQL_PROJECT`) |
| `compose.ts` | Platform compose normalization (image, volumes, resources); always joins `turbopanel-managed`; optional private-listener-only `ports:` (rejects all other publishes / Traefik labels) |
| `materialize.ts` | Write `config/` verbatim; optional engine self-signed TLS + `orgTlsMaterial` → `tls/server.*` + `tls/proxysql/`; ownership normalization via throwaway container (skips `backups/`). Standby replication passwords are **not** written under `auth/`. |
| `tls.ts` | Engine self-signed cert generation; org-CA materialization for engine leaf + ProxySQL; standby passfile materialization |
| `networks.ts` | Ensure Docker network `turbopanel-managed` (engines + ProxySQL) **and** attach ProxySQL to consumer `tpn_*` spanning segments |
| `proxysql.ts` | Shared ProxySQL compose + durable `proxysql.cnf` generation, static-section diffing, inspect/start/stop/restart |
| `proxysql-admin.ts` | Runtime admin apply via `docker exec` + `admin.cnf` (`[client]` secrets never on argv/logs) |
| `containers.ts` | Shared `docker compose ps` collection + running-container resolution used by `apply.ts` and `backup.ts` |
| `apply.ts` / `lifecycle.ts` / `destroy.ts` / `promote.ts` | Engine command handlers (wired from `command-router.ts`); apply/destroy do **not** bring up per-service Traefik; promote is operator-only |
| `backup.ts` | `managed.backup` (`create`/`delete`) + `managed.restore` — streamed dump/restore, checksum, prune |
| `logs.ts` | Bounded `compose logs`; cell `managed-logs-request` / `managed-logs-result` (not a command) |
| `engines/` | Per-engine runtime registry (`postgres`, `mysql`, `mariadb`); optional `dropUsers` / `backup` / `replication` (+ optional `configureStandby` for SQL-configured standbys) |
| `engines/postgres.ts` + `postgres-sql.ts` | Postgres runtime + pure SQL builders |
| `engines/mysql.ts` + `mysql-sql.ts` | MySQL runtime + pure SQL builders (GTID, auth_socket platform admin keeps `backup.ts` credential-free) |
| `engines/mariadb.ts` + `mariadb-sql.ts` | MariaDB runtime + **own** dialect (not a MySQL alias; `MASTER_USE_GTID=slave_pos`, `mariadb-dump --gtid`) |

## State tree

```
<stateDir>/managed/<managedId>/
├── docker-compose.yml   # normalized runtime compose (mode 0640)
├── config/              # engine config files (verbatim from payload)
│   ├── postgresql.conf
│   └── pg_hba.conf      # platform-owned HBA (multi-member / ssl)
├── tls/                 # sibling of config/ — matches `./tls` mount
│   ├── server.crt       # 0640 (org-CA leaf when multi-member; else self-signed)
│   ├── server.key       # 0600
│   ├── ca.crt           # 0640 when org material present (verify-full root)
│   └── proxysql/        # org-CA leaf material for ProxySQL path
│       ├── fullchain.pem  # 0640
│       ├── privkey.pem    # 0600
│       └── ca.pem         # 0640
└── backups/             # 0750; artifacts written 0600 by the daemon user itself
    └── <backupId>.<ext> # <ext> from MANAGED_BACKUP_ARTIFACT_EXTENSIONS (dump | sql)

# Standby replication passwords must not live under managed/<id>/auth.
# Bootstrap uses a short-lived 0600 env-file; streaming password is seeded by
# pg_basebackup -R into the data volume (not managed state).

# Shared ProxySQL (one per server) — daemon-owned runtime files;
# Ansible provisions directories / admin.cnf / base static cnf / unit only.
<configDir>/proxysql/
├── docker-compose.yml   # daemon-written (mode 0640); absent until first reconcile
├── proxysql.cnf         # durable cold-start config (static + users/servers/rules)
├── admin.cnf            # [client] admin user/password, mode 0600 (Ansible once)
├── wait-ready.sh        # Ansible; admin-port readiness for the oneshot unit
└── tls/                 # leaf fullchain/privkey + CA PEMs written on reconcile
    ├── fullchain.pem
    ├── privkey.pem
    └── ca.pem

<stateDir>/proxysql/     # optional host-side data tree (uid pre-owned by Ansible);
                         # compose typically uses a named volume for /var/lib/proxysql
```

`.env` (`TURBOPANEL_MANAGED_ROOT_PASSWORD=…`, mode `0600`) exists **only** for
the duration of engine `docker compose --env-file … up` and is deleted in
`finally`.

Compose project names:

- Engine: `turbopanel-managed-<managedId>` on Docker network
  `turbopanel-managed` (**always** — not only when exposed; **never** joins
  tenant `turbopanel-ingress`)
- Shared ProxySQL: `turbopanel-proxysql` (system component
  `managed-ingress`, compose service `proxysql`) on the same
  `turbopanel-managed` network
- Engine container name: instance-allocated `<service.id>-1` (ordinal 2/3 for
  replicas)

Legacy on-disk artifacts from the former per-service managed Traefik path
(`managed/<id>/ingress/`, `<stateDir>/managed/ingress/*.json`) are obsolete —
do not recreate them. ProxySQL reconcile no longer sweeps those trees.

## ProxySQL ingress

Independent of tenant `src/deploy/ingress.ts` Traefik. **One** ProxySQL
container per managed host terminates the public (or scoped) MySQL/Postgres
listeners and routes to engine members on `turbopanel-managed`.

| Piece | Detail |
| --- | --- |
| Image pin | `proxysql/proxysql:3.0.2` (`PROXYSQL_IMAGE`) — **do not loosen** without reviewing **GHSA-58ww-865x-grpr** (pre-auth heap overflow on first-packet path, ProxySQL 3.0.x, May 2026) |
| Listeners | Published `5432` (pgsql) and `3306` (mysql) on the instance-resolved `bindAddress`; admin on `127.0.0.1:6032` only |
| TLS | Frontend/backend TLS uses org-CA material under `configDir/proxysql/tls/` (and per-engine copies under `tls/proxysql/` for materialize). Engines still use self-signed `tlsMaterial` for their own listener when requested |
| Desired state | Whole-server command `managed.ingress.reconcile` carries `bindAddress` + `clusters[]` (backends + users); **not** embedded on each `managed.apply` |
| Admin apply | `proxysql-admin.ts` loads `admin.cnf`, mounts it into a throwaway client or uses stdin; SQL LOAD/SAVE — credentials never argv/logs |
| Backend monitor | Host-wide principal in `configDir/proxysql/monitor.cnf` (`tp_monitor` + random password). Written into `mysql_variables`/`pgsql_variables` and SET on reconcile. Each **primary** `managed.apply` creates the role (`GRANT pg_monitor` / MySQL PROCESS+REPLICATION CLIENT). **Never** leave ProxySQL defaults (`monitor`/`monitor`) — they spam engine logs and never authenticate |
| Cold start | Full `proxysql.cnf` (static + dynamic tables) is rewritten so reboot/`compose up` restores routing without a live admin session |
| Static vs dynamic | Static section = datadir, admin_variables, mysql_variables, pgsql_variables (interfaces + `have_ssl` + cert paths + monitor_*). Dynamic = `mysql_*` / `pgsql_*` servers, users, query_rules. Listener/static changes require container restart; user/backend changes prefer admin interface only |
| Inventory | System component `managed-ingress` / project `turbopanel-proxysql`; container name `<serviceId>-sql`; self-heal via `system.reconcile` → `proxysql` (distinct from inspect-only `database`/`queue`/`analytics`) |
| Host prep | Ansible role `proxysql` + playbook `proxysql-setup.yml` (`runProxySqlSetup`; also on co-located `instance-dev-install`) — dirs, admin.cnf, **monitor.cnf**, initial static cnf when absent, wait-ready, `turbopanel-proxysql-stack.service`, network. Removes bind-mount **directory** scars at `admin.cnf`/`proxysql.cnf`/`monitor.cnf` before seed. **Never** daemon compose contents. Reconcile refuses compose up if admin/config paths are missing or not regular files |
| Spanning segments | ProxySQL still joins `turbopanel-managed` plus each consumer `tpn_*` as `external: true`. Segment attachments pin `ipv4_address` to the reserved last-usable host (`reservedManagedIngressAddress`) so remote bindings can `extra_hosts` that address |

Username frontend namespace is **server-wide** across every cluster hosted on that
org's servers: `ManagedFrontendUserConflictError` when the same login would map
to two managed ids. The instance enforces the same org-owner login uniqueness
before enqueue (see `turbopanel/src/lib/managed/AGENTS.md` → Login namespace).

## Rules

1. **Container names from the instance.** The instance supplies engine
   `containerName` (`<service.id>-N`). There is **no** per-managed Traefik /
   `-in` ingress row on the engine service for ProxySQL path. ProxySQL
   system-component identity is `<serviceId>-sql`
   (`managedIngressContainerNameFromService` on the instance) — distinct from
   engine ordinal names and from tenant Traefik `-in`. Allocation still uses
   the `managed-ingress` system component, not engine ordinal slots.
   `assertSafeManagedIdentifiers` guards Docker names with the
   hyphen-permitting regex (do not reuse `SAFE_VOLUME_NAME_RE`). Container
   resolution (`containers.ts`) still keys off `Service` / `State`, never
   `Name`.
2. **Native port, never remapped; published only via private listener.**
   Normalized engine compose never emits arbitrary `ports:`. Multi-member
   clusters may publish **one** engine port bound exclusively to the member's
   datacenter or fabric (`tp0` relay) address at the instance-allocated
   `private_port` — that private listener is the single
   cross-host path for both streaming replication and remote ProxySQL
   backends. Loopback and `0.0.0.0` binds are rejected. Single-member
   clusters still publish nothing; client traffic enters only via shared
   ProxySQL (`5432` / `3306`).
3. **Always join `turbopanel-managed`.** Every managed engine container joins
   that network whether or not frontend exposure is enabled, so ProxySQL can
   reach it and so multi-member replication paths stay consistent. That is
   **not** exclusive: ProxySQL still joins `turbopanel-managed` **plus** each
   consumer `tpn_*` spanning segment (see ProxySQL table → Spanning segments).
4. **Config is verbatim.** The daemon does **not** rebuild `postgresql.conf`
   (or peer engine files). The instance engine spec is the single source of
   truth for base + operator snippet + `ssl = on`. Re-apply **unlinks then
   recreates** each config file — after ownership normalization they are
   often `root:<engineGroup>` `0640`, which the daemon cannot open for
   write, but it owns the parent directory so unlink+create succeeds.
5. **Secrets.** Credential envelopes decrypt in memory → root password reaches
   compose only through the short-lived `0600` env-file → deleted after `up`.
   Plaintext never lands in `docker-compose.yml` on disk and never appears in
   logs (`redactSecrets` + `sanitizeForLog`). SQL/password input uses
   `runDocker(…, { input })` stdin — never argv. ProxySQL admin password
   lives only in `admin.cnf` (mode `0600`).
6. **Ownership normalization.** Files written by the daemon user are unreadable
   by the container engine user. `normalizeManagedFileOwnership` runs one
   throwaway `docker run --user 0` of the engine image to `chown`/`chmod`
   **only** the bind-mounted trees (`config/`, `tls/`) — never
   `docker-compose.yml`, the short-lived `.env`, or `backups/` (those stay
   daemon-owned so re-apply can rewrite them). **`tls/proxysql/` is pruned**
   from that chown (daemon rewrites those PEMs on every apply; root:engine
   ownership left them Permission denied). Owner/group names come from
   the engine runtime descriptor — never hardcoded in shared code. Modes:
   `0640` → `root:<engineGroup>`; `0600` → `<engineUser>:<engineGroup>`;
   directories keep the daemon UID as owner but take `<engineGroup>` + `0750`.
7. **Engine extension.** One file under `engines/` implementing
   `ManagedEngineRuntime` + one registry entry in `engines/index.ts`.
8. **Tenant isolation.** Never import or mutate tenant Traefik / hosting
   Caddy state from this package beyond shared helpers (`assertValidBindAddress`,
   `runDocker`). Tenant raw TCP/UDP Traefik remains `src/deploy/ingress.ts`.
9. **Username conflict guard.** Do not insert frontend users that would
   collide across clusters on the same host org namespace
   (`ManagedFrontendUserConflictError`).
9a. **Platform admin vs. frontend root login.** `ManagedEngineContext.rootUsername`
   (built from the static `engine.rootUsername` in `apply.ts` / `backup.ts` /
   `promote.ts` / `containers.ts` — **never** from a payload credential) is
   always the stable platform admin the daemon uses for every internal admin
   path (`waitReady`, `psql`/`mysql` exec, `pg_dump`/`pg_restore`,
   promote/replication health). The user-facing "root" principal an operator
   connects with may be a *different*, possibly org-suffixed username
   (`resolveAvailableManagedRootUsername` in the instance repo) — it is
   applied as an ordinary `role: "root"` credential in `applyCredentials`
   (a separate SUPERUSER/grant, not a rename of the connection identity).
   Never assume the payload's root credential username equals
   `ctx.rootUsername`. Canonical contract:
   `../../turbopanel/src/lib/managed/AGENTS.md` → "Managed root username".
10. **Backup/restore (`backup.ts`).** Optional per engine via
   `ManagedEngineRuntime.backup` (`ManagedBackupNotSupportedError` when absent).
   - **Stream, never buffer.** Dump stdout pipes to a `<backupId>.<ext>.part`
     file at `0600`; restore pipes the artifact into `docker exec -i`
     stdin. Result carries **only metadata**. Use `spawnDockerStreaming`, not
     `runDocker`, for dump/restore.
   - **Checksum before restore.** Verify size/checksum before touching the
     engine container.
   - **`.part` cleanup on failure.** Partial artifacts must never look complete.
   - **Prune by payload retention.** After create, keep newest
     `payload.retentionKeep` artifacts; omit retention → no prune.
   - **`managed.destroy` removes `backups/`** with the managed dir.
   - **Scheduled backups** remain an explicit future seam (no timers here).
   - Container resolution reuses `containers.ts` /
     `resolveSoleEngineContainer`.

## Replication

Physical / GTID streaming is **engine → engine**, never through ProxySQL.

| Path | Postgres | MySQL / MariaDB |
| --- | --- | --- |
| Co-resident | Peers by `containerName` on `turbopanel-managed` | same |
| Cross-host | Private listener (`private_port` on the transport ladder: `local` co-resident container name → `fabric` relay address over `tp0` → `datacenter` private address) | same |
| Config | Instance owns `postgresql.conf` + `pg_hba.conf` | Instance owns `my.cnf` + `initdb/00-turbopanel.sql` (socket-auth platform admin — keeps SQL/`backup.ts` credential-free) |
| Slots / disk hazard | Physical slots + orphan drop on `ensurePrimary` | **No slots** — bounded `binlog_expire_logs_seconds` in platform `my.cnf` |
| Bootstrap | `bootstrapStandby` **before** compose up seeds via `pg_basebackup -R` | Probe only before compose up (uninit → `seeded` deferred; marker → `already_standby`; datadir without marker → `needs_resync`). Actual seed in **`configureStandby`** after compose up (logical dump + `CHANGE REPLICATION SOURCE` / MariaDB `CHANGE MASTER` + GTID) |
| Credentials | Short-lived `0600` env-file for basebackup | Short-lived `0600` defaults file over exec stdin (never `-p` / never `MYSQL_PWD`) |
| Standby SQL | not used (config-file primary_conninfo) | Optional `configureStandby` hook — replication channel setup is not user-data mutation |
| Promote | Operator only — no auto-failover | same (`STOP REPLICA` / `STOP SLAVE` + clear read_only) |
| Health | `streaming` requires active WAL receiver | `streaming` requires both IO + SQL threads running |