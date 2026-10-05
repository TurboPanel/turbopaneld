# Managed engines (daemon runtime) — AGENTS.md

Daemon-side runtime for environment-scoped managed database/cache engines
(Postgres first). Completely separate from tenant `environment.deploy` — no
hosting Caddy, no tenant Traefik network, no user compose merge. Frontend
access for managed engines is **one shared ProxySQL** per server
(project = the `managed-ingress` `serviceId`), not per-service Traefik.

Root context: `../../AGENTS.md`. Instance engine specs:
`../../../turbopanel/src/features/managed/AGENTS.md`. Command contracts:
`../contracts/commands-contracts.ts`. Host prerequisites:
`../../orchestration/roles/proxysql/AGENTS.md`.
Certificate authorities: `../../../turbopanel/src/lib/tls/AGENTS.md`.

## Module map

| File | Role |
| --- | --- |
| `engine-paths.ts` | Managed state-dir layout + identifier / relative-path guards; `managedBackupsDir` / `managedBackupArtifactDir` (per-policy `policy-<id>/`) / `managedBackupArtifactPath`; ProxySQL layout helpers (`proxysqlConfigDir`, `proxysqlComposePath`, `proxysqlConfigPath`, `proxysqlTlsDir`, `proxysqlDataDir`, `proxysqlAdminCnfPath`, `proxysqlProject`) |
| `compose.ts` | Platform compose normalization (image, volumes, resources); always joins the organization's managed network (`payload.managedNetwork`); optional private-listener-only `ports:` (rejects all other publishes / Traefik labels). Top-level data volumes are **name-pinned** (`name: <volume.name>`) — an unnamed entry gets the compose project prefix while `bootstrapStandby` throwaway containers `docker run -v <bare name>`, and that mismatch made every standby seed/probe operate on an orphan volume the engine never mounted (replicas silently initdb'd standalone clusters) |
| `materialize.ts` | Write `config/` verbatim; optional engine self-signed TLS + `orgTlsMaterial` → `tls/server.*` + `tls/proxysql/`; ownership normalization via throwaway container (scoped to `config/`+`tls/`; backups live outside this tree entirely since v6); a second throwaway run then verifies config/TLS readability AS the engine user with subdir-shaped mounts, failing the apply loudly instead of letting the engine crash-loop on an untraversable dir. Standby replication passwords are **not** written under `auth/`. |
| `tls.ts` | Engine self-signed cert generation; org-CA materialization for engine leaf + ProxySQL; standby passfile materialization |
| `networks.ts` | Ensure the organization's managed Docker network by the name the command payload carries (`ensureManagedIngressNetwork(name, run)` — no daemon-side default) **and** attach ProxySQL to consumer `tpn_*` compose-bridge subnets |
| `firewall.ts` | Best-effort idempotent `iptables` scoping for a **public** private listener: `TP-MANAGED-PUB` off `DOCKER-USER`, per-cluster `TP-MGD-<id>` chain matching the pre-DNAT publish via `conntrack --ctorigdst/--ctorigdstport`, ACCEPT known peers then DROP; no-op without a public IPv4 listener or known peers; never blocks apply/destroy. **Slated to fold into the managed host firewall** (`src/firewall/`, `server.firewall.reconcile` — Road row `fw-fold-existing`): the same scoping becomes a `published` rule the panel derives, rendered by one renderer with IPv6 parity |
| `proxysql.ts` | Shared ProxySQL compose + durable `proxysql.cnf` generation, static-section diffing, inspect/start/stop/restart |
| `proxysql-admin.ts` | Runtime admin apply via `docker exec` + `admin.cnf` (`[client]` secrets never on argv/logs) |
| `containers.ts` | Shared `docker compose ps` collection + running-container resolution used by `apply.ts` and `backup.ts` |
| `apply.ts` / `lifecycle.ts` / `destroy.ts` / `promote.ts` | Engine command handlers (wired from `command-router.ts`); apply/destroy do **not** bring up per-service Traefik; `managed.promote` is the engine promote step after TurboPanel fencing. **`managed.destroy` always `compose -p <managedId> down`** — the compose project is the bare `managed` row UUID — even if the state dir is missing, then `docker ps -aq --filter label=com.docker.compose.project=…` and `docker rm -f` leftovers; compose down failure is **not** success while labeled containers remain. No `-f` (same interpolation rule as lifecycle). With `removeVolumes`, also `docker volume rm -f managed_<id>_data` best-effort by exact name — compose down -v only removes project-labeled volumes and misses pre-pin bare-name orphans. |
| `orchestrator.ts` / `orchestrator-api.ts` | Per-org Orchestrator compose (project = the `managed-ha` `serviceId`, written into the compose file's own `name:` key so the stack unit needs no `-p`) + local HTTP (`:33001`); `Recover: false`; Raft `:33002` on advertise address only |
| `../commands/managed-ha-reconcile.ts` / `managed-ha-failover.ts` | `managed.ha.reconcile` (whole-server HA stack) + `managed.ha.failover` (`drain` / `recover`). Designated Orchestrator recover-to; on HTTP/API failure **or** absent stack, falls back to `managed.promote` so fencing is not stranded. `Recover: false` stays — TurboPanel picks the candidate. `Future:` fail-closed HA lease when Raft is unreachable. |
| `../instance/ha-observe.ts` | Poll local Orchestrator `/api/problems` when `configDir/orchestrator/docker-compose.yml` exists; emit unsolicited `managed-ha-event` carrying the dead instance's `instanceHost`/`instancePort` (feature `managed-ha-instance-v1`; the control plane fences only if they match the current primary) |
| `pg-dead-primary.ts` / `../instance/pg-dead-primary-observe.ts` | Postgres dead-primary probe on the primary's **own** host (Orchestrator cannot see Postgres). See **Postgres dead-primary detection** below |
| `ha-intent.ts` / `ha-member.ts` / `ha-command-hooks.ts` | Probe inputs kept by `command-router.ts`: operator-intent markers around every engine-touching managed verb, and the per-host member record (`managed/<id>/ha-member.json`) |
| `backup.ts` | `managed.backup` (`create`/`delete`) + `managed.restore` — streamed dump/restore, checksum, prune; exports the shared core (`createManagedBackupArtifact`, `restoreManagedBackupArtifact`, `resolveBackupEngine`) for scheduled runs |
| `target-lock.ts` | Per-engine `flock` (`withManagedTargetLock`, `ManagedTargetBusyError`) shared by the backup/restore handlers and the scheduled `backup-run` process |
| `logs.ts` | Bounded `compose logs`; cell `managed-logs-request` / `managed-logs-result` (not a command) |
| `health.ts` | On-demand member health; cell `managed-health-request` / `managed-health-result` (feature `managed-health-v1`, not a command). Runs `collectManagedMemberHealth` with the request's **real** role — a `replica` is read as a `standby`; the primary query reports `pg_stat_replication` rows and would pass a promote gate for a replica that is not streaming. Never throws: any failure (bad ids, unsupported engine, engine down — `collectManagedMemberHealth` swallows errors and omits `member`) is `{ ok: false, error }` so the control plane is answered instead of waiting out its timeout. Nothing is persisted here; the control plane writes the observation |
| `standby-streaming.ts` / `../instance/pg-standby-sampler.ts` | Last `streaming` read per local Postgres standby. The sampler reads this host's replicas every 2 s (5 s deadline per read, never two reads of one container at once; off with `TURBOPANEL_MANAGED_PG_PROBE=off`) and records a streaming read only when the receiver heard from the primary within 5 s (`now() - last_msg_receipt_time`; a silently dropped link stays `streaming` until `wal_receiver_timeout`), stamped at that last receipt on the monotonic clock; `health.ts` adds it to a replica's answer as `replication.lastStreaming` (`ageMs`, plus that read's lag) next to `receivedLsn` / `replayLsn`. The control plane's automatic-failover fresh-standby gate needs it: once the primary is gone the WAL receiver exits and Postgres no longer knows when it last streamed. In memory only; after a restart there is no record and the control plane refuses |
| `engines/` | Per-engine runtime registry (`postgres`, `mysql`, `mariadb`); optional `dropUsers` / `backup` / `replication` (+ optional `configureStandby` for SQL-configured standbys) |
| `engines/postgres.ts` + `postgres-sql.ts` | Postgres runtime + pure SQL builders. `dropUsers` first releases the role in **every** connectable non-template database (`REASSIGN OWNED BY <role> TO <platform admin>` then `DROP OWNED BY <role>`, skipped when the role is already gone) and only then `DROP ROLE` — a role that holds any database privilege or owns objects otherwise cannot be dropped, and a failed drop left the cluster `failed` with a zombie login. Ownership is reassigned, never dropped, so the data survives |
| `engines/mysql.ts` + `mysql-sql.ts` | MySQL runtime + pure SQL builders (GTID, auth_socket platform admin keeps `backup.ts` credential-free). Root apply creates the password account on the managed Docker network only and re-asserts `root@localhost` `auth_socket`; it never `IDENTIFIED BY` on localhost. When socket auth is missing, waitReady/apply retry via a short-lived 0600 defaults-extra-file (never `-p` / `MYSQL_PWD`). A standby boots `super_read_only`, so its initdb `INSTALL PLUGIN auth_socket` fails (1290); `configureStandby` installs the plugin inside the writable seed window, **before** the dump imports the primary's `auth_socket` grant tables — otherwise the post-seed `FLUSH PRIVILEGES` locks every socket admin out ("Plugin 'auth_socket' is not loaded") and replication is never configured |
| `engines/mariadb.ts` + `mariadb-sql.ts` | MariaDB runtime + **own** dialect (not a MySQL alias; `MASTER_USE_GTID=slave_pos`, `mariadb-dump --gtid`). Root apply creates the password account on the managed Docker network only and re-asserts `root@localhost` `unix_socket`; it never `IDENTIFIED BY` on localhost. When socket auth is missing, waitReady/apply retry via a short-lived 0600 defaults-extra-file (never `-p` / `MYSQL_PWD`) |

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

# Backups are NOT under this tree since v6 — they live at
# <backupDir>/<managedId>/ (LayoutPaths.backupDir, /backup by default,
# TURBOPANEL_BACKUP_DIR to override) so an operator can mount separate storage
# for them without moving the engine's own state:
#
# /backup/<managedId>/          # 0750; artifacts written 0600 by the daemon user itself
# ├── <backupId>.<ext>          # manual backups; <ext> from MANAGED_BACKUP_ARTIFACT_EXTENSIONS (dump | sql)
# └── policy-<policyId>/        # one dir per scheduled policy (managedBackupArtifactDir)
#     └── <backupId>.<ext>      # pruned only within its own policy dir

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

ProxySQL's **client-facing** TLS is not `ssl_p2s_*` (that is only the
proxy-to-engine leg): ProxySQL always serves `<datadir>/proxysql-{cert,key,ca}.pem`
and silently generates a self-signed pair when they are missing, which breaks
`sslmode=verify-full` / `VERIFY_IDENTITY` against the Organization CA. The
compose `command` therefore symlinks those three names to `certs/{fullchain,privkey,ca}.pem`
(the `./tls` directory mount — never per-file mounts, which pin the old inode
across a rewrite) before `exec proxysql`, and every reconcile ends with
`PROXYSQL RELOAD TLS`, which applies a rotated leaf and fails the reconcile
instead of falling back when a file is missing.

`.env` (`TURBOPANEL_MANAGED_ROOT_PASSWORD=…`, mode `0600`) exists **only** for
the duration of engine `docker compose --env-file … up` and is deleted in
`finally`.

Compose project names:

- Engine: `<managedId>` (bare UUID) on the organization's managed
  Docker network — the bare UUID of the instance's `network(kind='managed')`
  row (**one row per organization**, no `tpn_`/`turbopanel-` prefix), carried
  as `payload.managedNetwork` on every command that touches the network
  (`managed.apply`, `managed.ingress.reconcile`, `managed.ha.reconcile`,
  `environment.deploy` when any compose service joins it). There is **no
  daemon-side default and no literal fallback** — a command without the field
  is a contract error, not a cue to invent a name. Hosts provisioned before the
  UUID rename may still have a leftover `turbopanel-managed` bridge; ingress
  reconcile force-recreates onto `payload.managedNetwork` (removing a
  same-named container that Docker Compose no longer owns, which otherwise
  fails with "already in use by container"), then `docker network connect`s a
  frontend that is still only on the leftover, then prunes that name. Engines
  join it **always**
  (not only when exposed) and **never** join the tenant hosting-ingress
  network
- Shared ProxySQL: the `managed-ingress` `serviceId` (system component
  `managed-ingress`, compose service `proxysql`) on that same managed
  network
- Engine container name: instance-allocated `<service.id>-1` (ordinal 2/3 for
  replicas)

Legacy on-disk artifacts from the former per-service managed Traefik path
(`managed/<id>/ingress/`, `<stateDir>/managed/ingress/*.json`) are obsolete —
do not recreate them. ProxySQL reconcile no longer sweeps those trees.

## ProxySQL ingress

Independent of tenant `src/deploy/ingress.ts` Traefik. **One** ProxySQL
container per managed host terminates the public (or scoped) MySQL/Postgres
listeners and routes to engine members on the organization's managed network.

| Piece | Detail |
| --- | --- |
| Image pin | `proxysql/proxysql:3.0.9` (`PROXYSQL_IMAGE`) — **do not loosen** without reviewing **CVE-2026-48773** (pre-auth first-packet heap overflow) and **CVE-2026-48772** (PROXY-protocol-v1 `client_addr` ACL bypass); both fixed in 3.0.9 |
| Listeners | Published pgsql + mysql client ports on the instance-resolved `bindAddress` — numbers come from `listenerPorts` on the command (default `15432` / `13306`), see **Configurable listener ports** below; admin on `127.0.0.1:6032` only |
| TLS | Frontend/backend TLS uses **Organization CA** material under `configDir/proxysql/tls/` (and per-engine copies under `tls/proxysql/` for materialize). `ca.pem` / `tls/ca.crt` are the concatenated active+retired trust bundle (`orgTlsMaterial.caCertPem`; ProxySQL `ssl_ca` and Postgres `ssl_ca_file` accept multi-PEM). The daemon's **Platform CA** (`/etc/turbopanel/instance-ca.pem`) is unrelated and never used for ProxySQL/engine leaves. Engines still use self-signed `tlsMaterial` for their own listener when requested. Whether a *client* may stay plaintext is per-cluster `requireTls` — see **Frontend TLS enforcement** below |
| Desired state | Whole-server command `managed.ingress.reconcile` carries `identity` `{ serviceId, composeServiceName, containerName }` (same persist pattern as `managed.ha.reconcile`) + `bindAddress` + `listenerPorts` + `clusters[]` (backends + users); **not** embedded on each `managed.apply`. Empty `clusters[]` tears the stack down (`compose down --remove-orphans`) without TLS materialization, **leaving yaml/cnf on disk**. The next non-empty reconcile must `compose up` when the container is absent even if those files are unchanged — a single remaining cluster is not a reason to skip ProxySQL. Remote daemon-only hosts often never receive `system.reconcile`, so ingress must persist the descriptor from the payload (or recover `container_name` / `serviceId` from an existing compose file) rather than requiring `<stateDir>/system/managed-ingress.json` up front. Compose recovery accepts the current `<serviceId>-in` name and retired `<serviceId>-sql` / bare `serviceId` names, and always persists `role: ingress` / `-in`. |
| Admin apply | `proxysql-admin.ts` loads `admin.cnf`, mounts it into a throwaway client or uses stdin; SQL LOAD/SAVE — credentials never argv/logs |
| Backend monitor | **Control-plane minted, per server** (`tp_monitor_<serverId prefix>`; sealed on the instance's dedicated `monitor` table, never on `server.options`): `managed.ingress.reconcile` ships this server's credential (`payload.monitor`, tpdaemon envelope) — the daemon sets the monitor globals from it and **rewrites `monitor.cnf`**; primary `managed.apply` ships `monitorUsers[]` (one per fronting server — members + bound consumers) and the engine creates each role (`GRANT pg_monitor` / MySQL PROCESS+REPLICATION CLIENT); standbys inherit them via WAL. Per-host random `monitor.cnf` seeds alone cannot work cross-host: ProxySQL's monitor cred is one global per instance and a single engine role holds one password. Legacy fallback (payload fields absent): host-seeded `monitor.cnf` + local role after the same lazy `runProxySqlSetup` as ingress. **Never** leave ProxySQL defaults (`monitor`/`monitor`) — they spam engine logs and never authenticate. MySQL/MariaDB account host scoping: `ctx.clientSourceHosts` (peer members + `ingressSourceAddresses` consumers) adds per-host monitor/client/root accounts + grants alongside the managed-docker-network pattern |
| Cold start | Full `proxysql.cnf` (static + dynamic tables) is rewritten so reboot/`compose up` restores routing without a live admin session. Dynamic `{...}` records are **libconfig lists** and must be comma-separated (`{ row },` then the last `{ row }`); a second cluster or replica row without commas is `Parse error at /etc/proxysql.cnf` and the container crash-loops (`restart: unless-stopped`). Empty `()` lists are valid. |
| Static vs dynamic | Static section = datadir, admin_variables, mysql_variables, pgsql_variables (interfaces + `have_ssl` + cert paths + monitor_*). Dynamic = `mysql_*` / `pgsql_*` servers, users, query_rules. Listener/static changes require container restart; user/backend changes prefer admin interface only |
| Inventory | System component `managed-ingress` / project = its own `serviceId` (emitted as the compose file's `name:` key); container name `<serviceId>-in`, `role: ingress`; self-heal via `system.reconcile` → `proxysql` (distinct from inspect-only `database`/`queue`/`analytics`) |
| Host prep | Ansible role `proxysql` + playbook `proxysql-setup.yml` (`runProxySqlSetup`; also on co-located `instance-dev-install`) — dirs, admin.cnf, **monitor.cnf**, initial static cnf when absent, wait-ready, `turbopanel-proxysql-stack.service` (which no longer templates a project name — the daemon-written compose file carries it). **Not** the managed Docker network — its name is per-organization and only the daemon knows it (`system.reconcile` self-heal recreates a pruned one from the on-disk compose file). Removes bind-mount **directory** scars at `admin.cnf`/`proxysql.cnf`/`monitor.cnf` before seed. **Never** daemon compose contents. **`managed.ingress.reconcile` and primary `managed.apply` lazy-run `runProxySqlSetup` when `admin.cnf`/`monitor.cnf` are missing** (same pattern as HA `hostPrepPresent` / `runOrchestratorSetup`) — remote daemon-only hosts never get ProxySQL from `daemon-converge.yml`. Reconcile still refuses compose up if admin/config paths are missing or not regular files after prep |
| Compose-bridge subnets | ProxySQL still joins the organization's managed network plus each consumer `tpn_*` as `external: true`. Attachments pin `ipv4_address` to the reserved last-usable host (`reservedManagedIngressAddress`) so remote bindings can `extra_hosts` that address |

### Configurable listener ports

Client listener ports are operator-configurable per organization on the instance
side, so the daemon must treat them as data:

- **Never derive protocol family from a port number.** Each cluster carries
  `family` (`'pgsql' | 'mysql'`) and the reconcile handler uses it directly; the
  port is only a bind target. A port-derived family silently mis-sorts clusters
  the moment an operator picks their own numbers.
- **Compose parse/render is port-agnostic.** `readPublishedBindAddressFromCompose`
  / `readPublishedListenerPortsFromCompose` match the generic
  `host:port:port` shape instead of looking for `15432` / `13306`, so a
  bind-address or port recovered from an existing stack survives a port change.
- **Self-heal round-trips the ports.** `system.reconcile` → `proxysql` reads the
  current ports off disk and re-renders with them; it must not fall back to the
  platform defaults, or a heal would silently move an operator's listeners.
- **Preflight the host before any compose write.**
  `assertManagedIngressPortsBindable` probes each *new* port with a real
  `Deno.listen` and fails the command with an actionable message. Ports already
  published by the running ProxySQL are skipped — otherwise every reconcile
  would report a conflict with itself. This runs *before* the compose write so a
  collision with an unrelated host service leaves the existing ingress
  untouched instead of taking it down mid-change.
- **Validation matches the instance exactly** (`isManagedIngressProtocolPort` in
  `contracts.ts`): `1024`–`65535`, not `6032` / `6132`, not `45000`–`45999`. A
  looser daemon check would accept a payload the control plane considers
  invalid, which is how a half-configured ingress happens. Canonical rules:
  `turbopanel/src/features/managed/AGENTS.md` → **Client listener ports**.

### Managed network self-heal

`system.reconcile` runs without a fresh `managed.ingress.reconcile` /
`managed.ha.reconcile` payload, so it has no `managedNetwork` field to read.
The name is recovered from the on-disk daemon-written compose file instead —
`readManagedNetworkFromCompose` (one in `proxysql.ts`, one in
`orchestrator.ts`) parses the external network reference back out of
`<configDir>/proxysql/docker-compose.yml` /
`<configDir>/orchestrator/docker-compose.yml`, exactly mirroring how listener
ports and bind addresses are round-tripped off disk (see **Configurable
listener ports**).

- **No compose file, or a file that will not parse → skip the heal.** Both
  paths log and return rather than calling `ensureManagedIngressNetwork`.
  Never guess a name: a wrong one silently creates a second, empty network and
  strands every engine on the real one.
- The recovered name is passed to `ensureManagedIngressNetwork`, which
  recreates a pruned network before the stack restarts.
- This is why the daemon-written compose file — not an Ansible template or a
  daemon constant — is the durable record of the network name on the host.

### Hostgroup placement and read routing

`backendPlacement` (`proxysql.ts`) decides where each backend row lands, and it
is deliberately **not** a writer/reader split on `readEligible`:

| Backend | Hostgroup | Status |
| --- | --- | --- |
| `role: 'primary'` | writer | `ONLINE` |
| replica, `readEligible: true` | reader | `ONLINE` |
| replica, `readEligible: false` | reader | **`OFFLINE_SOFT`** |

A non-read-eligible replica is a monitored standby, so it must never sit in the
writer hostgroup (that would send it client **writes** while the real primary is
alive). It stays in the reader hostgroup as `OFFLINE_SOFT` — ProxySQL keeps
monitoring it for promotion but routes no traffic to it.

Frontend `default_hostgroup` comes from each user's `connectionRole`
(`userDefaultHostgroup`): absent / `read-write` → writer, `read-only` → reader.
`^SELECT` query rules are emitted **only** when the cluster sets
`autoReadSplit: true` **and** has at least one read-eligible replica
(`clusterEmitsReadSplitRules`), and then only for `read-write` logins
(`sortedReadSplitUsernames`) — read-only logins already default to the reader
hostgroup. Do not reintroduce automatic read-split from `readEligible` alone; a
blanket regex breaks read-after-write and locking reads for applications that
never opted in. Canonical policy: `turbopanel/src/features/managed/AGENTS.md` →
**Client routing**.

Username frontend namespace is **server-wide** across every cluster hosted on that
org's servers: `ManagedFrontendUserConflictError` when the same login would map
to two managed ids. The instance enforces the same org-owner login uniqueness
before enqueue (see `turbopanel/src/features/managed/AGENTS.md` → Login namespace).

### Frontend TLS enforcement

Frontend/backend leaves use **Organization CA** material. The daemon's
**Platform CA** (`/etc/turbopanel/instance-ca.pem`) is unrelated and never used
for ProxySQL/engine leaves.

Cluster `requireTls` on `managed.ingress.reconcile` renders `use_ssl` on that
cluster's `mysql_users` / `pgsql_users` rows (`renderUserRows` /
`buildProxySqlAdminStatements`) — ProxySQL's per-user `REQUIRE SSL`: an encrypted
socket, no client certificate. Absent/false leaves TLS *available* (the listener
always has cert material) but optional.

**Backend TLS is unconditional and unrelated.** Server rows are always
`use_ssl=1` because engines only publish TLS-required rules (`hostssl` /
`REQUIRE SSL`). Never derive one from the other.

The daemon does **not** know about SSL modes. The instance resolves the
`ManagedSslMode` three-layer chain (service → org default → `require`) and sends
only the boolean; certificate *verification* (`verify-ca` / `verify-full`) is a
client-side behavior the instance renders into DSNs, and there is nothing for
ProxySQL to enforce. Canonical policy:
`turbopanel/src/features/managed/AGENTS.md` → **Client TLS (SSL mode)**.

## Rules

1. **Container names from the instance.** The instance supplies engine
   `containerName` (`<service.id>-N`). There is **no** per-managed Traefik /
   `-in` ingress row on the engine service for ProxySQL path. ProxySQL
   system-component identity is `<serviceId>-in`
   (`ingressContainerNameFromService` on the instance) — it **shares** that
   suffix and `role: ingress` with tenant Traefik, and is distinguished by
   compose project (the `managed-ingress` `serviceId`) plus the `managed-ingress`
   system-component label. Distinct from engine ordinal names. Allocation still
   uses the `managed-ingress` system component, not engine ordinal slots.
   Suffix contract: `turbopanel/AGENTS.md` → **Container name suffix contract**.
   `assertSafeManagedIdentifiers` guards Docker names with the
   hyphen-permitting regex (do not reuse `SAFE_VOLUME_NAME_RE`). Container
   resolution (`containers.ts`) still keys off `Service` / `State`, never
   `Name`.
2. **Native port, never remapped; published only via private listener.**
   Normalized engine compose never emits arbitrary `ports:`. Multi-member
   clusters may publish **one** engine port bound exclusively to the member's
   datacenter, fabric (`tp0` relay), **or public** address at the
   instance-allocated `private_port` — that private listener is the single
   cross-host path for both streaming replication and remote ProxySQL
   backends. Loopback and `0.0.0.0` binds are rejected. Single-member
   clusters still publish nothing; client traffic enters only via the shared
   ProxySQL client listeners.
   A **public** bind (`privateListener.transport === 'public'`) is mandatorily
   **Organization CA** TLS-only: `assertPublicPrivateListenerTls` (exported from
   `compose.ts`, run first in `apply.ts` and again during compose normalization)
   refuses the listener unless `orgTlsMaterial` is present, so `tls/server.crt` +
   `ca.crt` (Organization CA material) always land before the publish exists. `firewall.ts` then scopes that
   publish to the known peer address(es) — still never `0.0.0.0`, and never a
   broad fallback when no stable peer address is known.
3. **Always join the organization's managed network.** Every managed engine
   container joins `payload.managedNetwork` whether or not frontend exposure is
   enabled, so ProxySQL can reach it and so multi-member replication paths stay
   consistent. That is **not** exclusive: ProxySQL still joins the managed
   network **plus** each consumer `tpn_*` compose-bridge subnet (see ProxySQL table → Compose-bridge subnets).
   **Ensure the network before any `compose up`.** `apply.ts` calls
   `ensureManagedIngressNetwork(payload.managedNetwork, run)` *before*
   `materializeManagedState` / `composeUpManagedEngine` (and before any
   bootstrap `docker run --network …`); the compose file references the
   network as `external: true`, so a missing network fails the whole `up`
   rather than being created implicitly. `managed.ingress.reconcile`,
   `managed.ha.reconcile`, `environment.deploy`, and both `system.reconcile`
   self-heal paths ensure it the same way.
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
   `docker-compose.yml` or the short-lived `.env` (those stay
   daemon-owned so re-apply can rewrite them). **`tls/proxysql/` is pruned**
   from that chown (daemon rewrites those PEMs on every apply; root:engine
   ownership left them Permission denied). Owner/group names come from
   the engine runtime descriptor — never hardcoded in shared code. Modes:
   `0640` → `root:<engineGroup>`; `0600` → `<engineUser>:<engineGroup>`;
   directories keep the daemon UID as owner but take `<engineGroup>` + `0750`.
7. **Engine extension.** One file under `engines/` implementing
   `ManagedEngineRuntime` + one registry entry in `engines/index.ts`.
7a. **Engine image allowlist is a mirror, not a policy.**
   `MANAGED_ALLOWED_IMAGES_BY_ENGINE` in
   `../contracts/commands-contracts.ts` is the last stop before Docker runs a
   `managed.apply` image, so it must stay byte-identical to the instance release
   catalog (`../../turbopanel/src/features/managed/releases.ts`) — including its
   ordering (default series first, default variant first). Adding or retiring a
   series is a three-repo change (instance catalog, this mirror, UI
   `ui/src/lib/managed-releases.ts`); `command-types-parity.test.ts` pins this
   copy. Do not add a series here that the instance will not create, and never
   relax the check to a prefix/regex match — an EOL major (MySQL 8.0) must stay
   unrunnable even if a forged or replayed payload names it. Engines with no
   catalog entry (`redis` / `clickhouse`) are intentionally unrestricted.
   A cluster's series is immutable after create (instance
   `managed_series_immutable`), so the daemon never sees an in-place major swap;
   variant-only changes are ordinary re-applies.
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
   connects with is always a *different*, org-suffixed username
   (`postgres_<11 rand>` / `root_<11 rand>` via `resolveManagedAppliedUsername`
   in the instance repo — the bare engine admin name is never exposed) — it is
   applied as an ordinary `role: "root"` credential in `applyCredentials`
   (a separate SUPERUSER/grant, not a rename of the connection identity).
   Never assume the payload's root credential username equals
   `ctx.rootUsername`. Canonical contract:
   `../../turbopanel/src/features/managed/AGENTS.md` → "Login namespace".
10. **Backup/restore (`backup.ts`).** Optional per engine via
   `ManagedEngineRuntime.backup` (`ManagedBackupNotSupportedError` when absent).
   - **Stream, never buffer.** Dump stdout pipes to a `<backupId>.<ext>.part`
     file at `0600`; restore pipes the artifact into `docker exec -i`
     stdin. Result carries **only metadata**. Use `spawnDockerStreaming`, not
     `runDocker`, for dump/restore.
   - **Checksum before restore.** Verify size/checksum before touching the
     engine container.
   - **`.part` cleanup on failure.** Partial artifacts must never look complete.
   - **Prune by retention, one directory at a time.** After create, keep the
     newest `retentionKeep` artifacts **in the artifact's own directory**;
     omit retention → no prune. Manual backups prune `<backupDir>/<managedId>/`
     (files only, so never a `policy-*` subdirectory); a scheduled backup
     prunes only its `policy-<policyId>/` directory, so an hourly keep-24
     policy never deletes a daily or manual backup.
   - **One core, two entry points.** `createManagedBackupArtifact` /
     `restoreManagedBackupArtifact` hold the dump/verify/restore logic;
     `handleManagedBackup` / `handleManagedRestore` validate the command
     payload and call them. Scheduled runs call the same core with a
     `policyId`. The core re-checks every id it builds a path from.
   - **`managed.destroy` removes `<backupDir>/<managedId>/`** alongside the
     managed state dir. Backups moved out of the managed tree in v6, so
     removing the state dir no longer takes them with it — destroy removes both
     explicitly rather than leaving an orphan tree on the backup storage.
   - **One engine, one operation at a time.** `handleManagedBackup` (create)
     and `handleManagedRestore` hold `withManagedTargetLock`
     (`target-lock.ts`): a non-blocking `flock` on
     `<runDir>/managed-locks/<managedId>.lock`. The scheduled runner takes the
     same lock from its own process, so a scheduled run, a manual backup and a
     restore never overlap on one engine; the second one fails at once with
     `ManagedTargetBusyError` instead of queueing.
   - **Scheduled backups** run outside this process (a platform-owned
     systemd timer per policy, Road to 0.2.x `r2-backup-*`; see
     `src/backups/AGENTS.md`); this module only provides the shared core, the
     per-policy layout and the lock. No timers here.
   - Container resolution reuses `containers.ts` /
     `resolveSoleEngineContainer`.

## Replication

Physical / GTID streaming is **engine → engine**, never through ProxySQL.

| Path | Postgres | MySQL / MariaDB |
| --- | --- | --- |
| Co-resident | Peers by `containerName` on the organization's managed network | same |
| Cross-host | Private listener (`private_port` on the transport ladder: `local` co-resident container name → `fabric` relay address over `tp0` → `datacenter` private address → `public` address, **Organization CA** TLS mandatory + iptables-scoped) | same (`REQUIRE SSL` on the replication grant) |
| Config | Instance owns `postgresql.conf` + `pg_hba.conf`, mounted as a **directory** (`./config:/etc/postgresql/conf:ro`) — never single-file binds, which pin the inode at container create and make daemon rewrites (unlink+create in `materialize.ts`) invisible to the running engine. Apply calls `reloadConfig` after materialize (`pg_reload_conf()`, standbys too) and **verifies** via `pg_file_settings`/`pg_hba_file_rules` (the postmaster only logs reload failures) | Instance owns `my.cnf` + `initdb/00-turbopanel.sql` (socket-auth platform admin — keeps SQL/`backup.ts` credential-free); no live reload — `normalizeManagedCompose` stamps a `tp.managed.config-digest` label (fnv1a of configFiles) on mysql/mariadb services so config edits change the compose text and force a recreate (Postgres exempt: live reload) |
| Slots / disk hazard | Physical slots + orphan drop on `ensurePrimary` | **No slots** — bounded `binlog_expire_logs_seconds` in platform `my.cnf` |
| Bootstrap | `bootstrapStandby` **before** compose up seeds via `pg_basebackup -R` | Probe only before compose up (uninit → `seeded` deferred; marker → `already_standby`; datadir without marker → `needs_resync`). Actual seed in **`configureStandby`** after compose up (logical dump + `CHANGE REPLICATION SOURCE` / MariaDB `CHANGE MASTER` + GTID) |
| Bootstrap probes | All engines probe data-dir state via `sh -c 'test … && echo present \|\| echo absent'` and **require the probe container to succeed** — a docker-level failure throws (`standby data probe failed`) instead of being misread as an uninitialized volume and triggering a spurious re-seed | same |
| Data dir | PGDATA is **pinned** to `<volume>/data` by the compose spec (postgres:18 images changed their default to `<volume>/<major>/docker`); probes/seed target `<volume>/data`. Seed is atomic: uninitialized → clear `data`/`data.tmp` → `pg_basebackup -D data.tmp` → `mv data.tmp data`, so an interrupted seed never strands a half-copied PGDATA | MySQL/MariaDB datadir is the image default `/var/lib/mysql` (initdb by entrypoint; seed via `configureStandby` SQL, no file-level copy) |
| Credentials | Short-lived `0600` env-file for basebackup | Short-lived `0600` defaults file over exec stdin (never `-p` / never `MYSQL_PWD`) |
| Standby SQL | not used (config-file primary_conninfo) | Optional `configureStandby` hook — replication channel setup is not user-data mutation |
| Promote | Operator switchover, DR route, or TurboPanel-gated auto-failover after fence (Orchestrator designated recover-to, else `managed.promote` fallback) | same (`STOP REPLICA` / `STOP SLAVE` + clear read_only) |
| Health | `streaming` requires active WAL receiver | `streaming` requires both IO + SQL threads running |

## Postgres dead-primary detection

Orchestrator's image only has the MySQL driver, so it never sees Postgres and
`ha-observe.ts` only ever reports MySQL/MariaDB. For Postgres the daemon on the
**primary's own host** runs `PgDeadPrimaryObserver` and sends the same
`managed-ha-event`, plus `sourceMemberId`, `detector: 'postgres-probe'` and
bounded `evidence`. What the control plane then checks (same-org member
reporter, current primary, cooldown, lag gate, fence, promote) is listed in
`turbopanel/src/features/managed/AGENTS.md` → **Dead-primary detectors**;
there is no raft-leader check on that path.

- **Scope** (`DEAD_PRIMARY_DETECTION_SCOPE = 'engine-dead-host-alive'`): the
  engine container/process is dead while the host and daemon are alive, so the
  old primary can still be fenced. **Whole-host loss is not detected** — it
  stays manual with an alert. Widening it (Option A) is a control-plane policy
  switch (`turbopanel/src/features/managed/ha-policy.ts` →
  `AUTOMATIC_FAILOVER_DETECTORS`) plus a host-loss detector there, never a
  change to this probe.
- **Watched**: a Postgres member recorded `primary` in `ha-member.json` with at
  least one replica peer. The daemon cannot see `replicaClass`; the control
  plane still requires a healthy same-DC `failover` replica and otherwise
  records a `blocked` recovery. Global kill switch:
  `TURBOPANEL_MANAGED_PG_PROBE=off`. A cluster applied before this daemon has
  no record until its next `managed.apply`. `managed.promote` and a successful
  `managed.ha.failover` `recover` flip the local record to `primary` and count
  every other member (the old primary resyncs as a replica), so a 1+1
  cluster's new primary is watched at once; the flip is logged.
- **Probe** every 5 s, read-only, every `docker exec` as `-u postgres`:
  `docker inspect` (state, exit code, start, health), then
  `pg_isready -q -t 3` over the image's local socket (no credentials, no SQL),
  `pg_ctl status` only on "no response", `pg_controldata` only when Postgres
  rejects. Every Docker call is bounded; a timeout or socket error is
  *inconclusive*, and while a previous call for that container is still
  running the tick is inconclusive instead of spawning another CLI process.
- **Classification**: exited/dead/restarting/created/paused/absent → hard
  (Docker must answer every tick of the streak — any unreadable tick, e.g. a
  dockerd restart without live-restore, resets it); `pg_isready` 0 → alive
  (PQping reports OK for every server error except 57P03, so 53300 "too many
  connections" is alive); 1 (57P03) → soft for 10 min, 30 min while
  `pg_controldata` says `in crash recovery` **or cannot be read**;
  `in archive recovery` → this node is a standby, never fire; 2 → soft for
  60 s after a container (re)start, then hard only when `pg_ctl status`
  confirms the postmaster is gone, otherwise soft for 5 min (an overloaded
  primary is not dead; every soft state is logged on entry/exit and each
  minute so a hung primary is visible); 3 / Docker stderr / exec plumbing → inconclusive
  (resets the streak).
- **Fires** after 6 consecutive hard failures spanning ≥ 20 s on a
  **monotonic** clock (wall time only for marker expiry and Docker's
  `StartedAt`). Attach, detach and a tick gap over 3 intervals reset streaks.
  While the primary stays dead the event is re-sent at +5, +10, +20, +40 min
  (doubling, capped at 60 min, at most 5 events per incident), so a refusal
  inside the control plane's 15 min cooldown is retried after it; the
  control plane dedupes in-flight recoveries. A new incident no sooner than
  5 min after the last event; healthy resets. Only delivered events count.
- **Intent markers** (`ha-intent.ts`, written atomically; an unreadable marker
  file suppresses like an active one): `command-router.ts` begins one before
  every verb in `MANAGED_COMMAND_INTENT_KINDS` (apply = update/upgrade/resync,
  lifecycle start/stop/restart, destroy, promote, restore, ha.failover) and
  ends it when the handler returns:
  - while the command runs its marker is `running`: it suppresses for the
    whole duration (a major-upgrade apply or a restore that keeps the engine
    down for an hour stays suppressed) up to a 6 h ceiling, at which it stops
    suppressing with a WARN; when the command ends it becomes transient and
    suppresses 10 min + 30 s from THEN; only the command that owns the
    current marker refreshes it (concurrent commands: the last to finish
    never overwrites a newer marker);
  - a `stop` is **held** only after it succeeded; `destroy` is held from the
    start (a failed destroy never re-arms the probe);
  - a transient marker never replaces a held one; only a **successful**
    start/restart/apply/promote/failover releases it;
  - the probe releases a held marker, a `running` marker left on disk by an
    earlier daemon run (never one a command of this process owns), or an
    unreadable marker after the engine has been healthy for 10 min, and logs
    every release and every expiry;
  - an unreadable (torn) marker file suppresses like an active one, with a
    WARN when that starts and every 10 min; it is cleared after 10 healthy
    minutes or 6 h, whichever comes first;
  - at daemon start: a `running` stop left by a restart mid-stop is turned
    into a held stop when the engine is down; a stopped primary with **no**
    marker is logged as a WARN and probed as dead (the daemon keeps no command
    journal, so a lost held-stop write cannot be told from a crash).
  A container stopped *without* a marker still counts as dead. A new
  `managed.*` verb must be added to `MANAGED_COMMAND_INTENT_KINDS` or
  `MANAGED_COMMAND_INTENT_EXEMPT` (`ha-intent.test.ts` fails otherwise).
  Commands outside `managed.*` that can stop an engine container without
  naming a cluster record a **host-wide** marker (`HOST_WIDE_INTENT_ID`):
  `storage.restore` (stops every running container that mounts the restored
  copy) and `server.reboot`.
- **Never sends** after `detach()` (daemon SIGTERM, including a tick already in
  flight), unless `systemctl is-system-running` answers `running`/`degraded`
  within 2 s (fails closed), or to a control plane that does not advertise
  `managed-ha-probe-v1`. `turbopaneld.service` is ordered `After=docker.service`
  so at shutdown the daemon stops before Docker kills the engines.
