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
| `firewall.ts` | Best-effort idempotent `iptables` scoping for a **public** private listener: `TP-MANAGED-PUB` off `DOCKER-USER`, per-cluster `TP-MGD-<id>` chain matching the pre-DNAT publish via `conntrack --ctorigdst/--ctorigdstport`, ACCEPT known peers then DROP. Apply **removes** that chain (idempotent if absent) when the listener is cleared or not public — a single-member cluster only publishes while a remote app is bound, so leaving a DROP would block a later cluster that reuses the address/port. Destroy still tears the chain down. No new rules without a public IPv4 listener or known peers; never blocks apply/destroy. **Slated to fold into the managed host firewall** (`src/firewall/`, `server.firewall.reconcile` — Road row `fw-fold-existing`): the same scoping becomes a `published` rule the panel derives, rendered by one renderer with IPv6 parity |
| `proxysql.ts` | Shared ProxySQL compose + durable `proxysql.cnf` generation, static-section diffing, inspect/start/stop/restart |
| `proxysql-ipv6.ts` | ProxySQL's own IPv6-only network (ULA /64 per server) and IPv6 listener addresses, so IPv6 clients keep their real address — see **Real client addresses (IPv6 network)** |
| `proxysql-server-version.ts` | Which engine version each client listener reports (`mysql-server_version` / `pgsql-server_version`) — see **Server version reported to clients** |
| `proxysql-root-guard.ts` | Source guard for each cluster's **root** login on the shared ProxySQL. A root `users[]` entry carrying `allowedSources` (present, even empty) gets query rules (`username` + `client_addr`, `apply=1`) rendered ahead of the read-split rules: one pass rule per allowed source, then a catch-all `error_msg` rule, so a query from anywhere else is refused (the login still authenticates; the block lands on the first query). `client_addr` matches an exact address or a trailing `%` prefix only (CIDR silently never matches), so subnets become `%` prefixes on octet / 16-bit group boundaries. Allowed sources = the control plane's list (other servers' and this server's own public addresses) **plus** host-local sources the daemon reads on every reconcile: loopback and every subnet of every Docker network the ProxySQL container is attached to (`docker-proxy` shows loopback and hairpin callers as the network gateway; a container dialing by name shows its own address). Anything arriving as the gateway is therefore allowed. `allowedSources` absent (older control plane) = no rules, as before. Never set `fast_forward` on a root row: it skips query rules entirely. Guard rules are admin-SQL only (not in `proxysql.cnf`). **App logins use the same guard** (feature `managed-login-limits-v1`): a `users[]` entry with `allowedSources` (exact addresses or trailing `%` prefixes, present even when empty) gets pass rules + catch-all (`LOGIN_GUARD_ERROR_MESSAGE`); `allowLocalSources: true` adds the host-local sources (root always has them); read-only and `tool` logins get no reader rule. Rules are rendered in one id sequence ahead of read-split rules and rebuilt (hand rules wiped) on every apply. `maxConnections` becomes the user row's `max_connections` |
| `proxysql-admin.ts` | Runtime admin apply via `docker exec` + `admin.cnf` (`[client]` secrets never on argv/logs) |
| `containers.ts` | Shared `docker compose ps` collection + running-container resolution used by `apply.ts` and `backup.ts` |
| `apply.ts` / `lifecycle.ts` / `destroy.ts` / `promote.ts` / `follow-primary.ts` | Engine command handlers (wired from `command-router.ts`); `applyManagedEngineState` order on a primary is: database **creates**, credentials (grants reference those databases), `dropUsers`, ProxySQL monitor roles, database **drops** last (after users are gone, so a deleted owner is released first) — an apply that fails early therefore never leaves a referenced database uncreated and the next retry heals; apply/destroy do **not** bring up per-service Traefik; `managed.promote` is the engine promote step after TurboPanel fencing. **`managed.destroy` always `compose -p <managedId> down`** — the compose project is the bare `managed` row UUID — even if the state dir is missing, then `docker ps -aq --filter label=com.docker.compose.project=…` and `docker rm -f` leftovers; compose down failure is **not** success while labeled containers remain. No `-f` (same interpolation rule as lifecycle). With `removeVolumes`, also `docker volume rm -f managed_<id>_data` best-effort by exact name — compose down -v only removes project-labeled volumes and misses pre-pin bare-name orphans. **Destroy vs apply:** destroy writes `<stateDir>/managed-intent/<id>.destroyed.json` (`destroyed-marker.ts`, names the member, 24 h life) BEFORE removing anything, then takes the per-id `withManagedLifecycleLock` (`<runDir>/managed-locks/<id>.lifecycle.lock`, blocking, shared with apply); apply takes the same lock and refuses (`ManagedDestroyedError`) a member whose marker is live. Destroy re-checks for re-created containers/state dir before reporting success; `listManagedHaMembers` skips destroyed members. |
| `orchestrator.ts` / `orchestrator-api.ts` | Per-org Orchestrator compose (project = the `managed-ha` `serviceId`, written into the compose file's own `name:` key so the stack unit needs no `-p`) + HTTP `:33001` on loopback **and** the Raft advertise address (followers proxy to `HTTPAdvertise`) + Raft `:33002` on advertise only; `restart: always`; topology TLS uses `MySQLTopologyUseMutualTLS` plus Organization CA (`SSL_CERT_FILE` for trust roots); members are registered by private-listener host (not the Docker name), with `extra_hosts` mapping the name onto that address; `Recover: false` |
| `../commands/managed-ha-reconcile.ts` / `managed-ha-failover.ts` | `managed.ha.reconcile` (whole-server HA stack) + `managed.ha.failover` (`drain` / `recover` / `repoint`). Designated Orchestrator recover-to; on HTTP/API failure **or** absent stack, falls back to `managed.promote` so fencing is not stranded. Orchestrator can answer OK ("Recovery executed") without promoting anyone, so after its recover the target is checked on the engine (`promotion-check.ts`: not a replica, and every read-only flag off — MySQL `read_only` + `super_read_only`, MariaDB `read_only`); when it is not a writable primary the same `managed.promote` runs (reason `not-promoted`, GTID proof forwarded), the check runs again, and the phase fails if the target still is not writable. `Recover: false` stays — TurboPanel picks the candidate. `recover` translates a member on this host from its Docker name to its published private listener (`resolveOrchestratorRecoverEndpoint`), because Orchestrator knows members by `<private IP>:<port>`. A cluster that fails to register no longer aborts the others on the host; a mixed result succeeds as `partial` and reports each failed cluster id plus its bounded error, while zero registrations fail the command. After promotion, `repoint` first runs on the **new primary** with `ensureSlots` (Postgres creates missing `tp_member_*` physical slots; MySQL/MariaDB no-op) then on every other healthy replica so `primary_conninfo` / source host follow (`follow-primary.ts`). Follow refuses a non-standby and polls `readHealth` until `streaming`. `Future:` fail-closed HA lease when Raft is unreachable. Before registering it polls `/api/raft-status` (up to 45 s) until this node is the Raft leader or a follower whose `LeaderURI` is on the current leader's host: a follower that knows no leader answers every write `HTTP 500 Unauthorized`, and one restarted with an older group's `LeaderURI` proxies to that host (`waitForOrchestratorRaftLeader`). A cluster that fails to register no longer aborts the others on the host; a mixed result succeeds as `partial` and reports each failed cluster id plus its bounded error, while zero registrations fail the command. After promotion, `repoint` first runs on the **new primary** with `ensureSlots` (Postgres creates missing `tp_member_*` physical slots; MySQL/MariaDB no-op) then on every other healthy replica so `primary_conninfo` / source host follow (`follow-primary.ts`). Follow refuses a non-standby and polls `readHealth` until `streaming`. `Future:` fail-closed HA lease when Raft is unreachable. |
| `../instance/ha-observe.ts` | Poll local Orchestrator `/api/problems` and `/api/replication-analysis` (a dead-primary analysis on the master row — Percona 3.2.x does not put those names on `/api/problems`; the one list is `isDeadPrimaryProblem` in `orchestrator-api.ts`: `DeadMaster`, `DeadMasterAndReplicas` (what a `docker kill` gives when Orchestrator cannot check the replica either), `DeadMasterAndSomeReplicas`, `DeadMasterWithoutReplicas`, `UnreachableMaster` and the `*Primary` spellings; never co-master, intermediate-master or `UnreachableMasterWithLaggingReplicas`) when `configDir/orchestrator/docker-compose.yml` exists; resolve `managedId` from the cluster alias when it is the managed UUID, else from the local primary's published private listener (`ha-orchestrator-managed-id.ts`); before that poll, revive a stopped container only after two consecutive stopped observations and never while an in-process stop/restart/apply marks the stack busy; completed checks are cooled down for 60 s; emit unsolicited `managed-ha-event` carrying the dead instance's `instanceHost`/`instancePort` (feature `managed-ha-instance-v1`; the control plane fences only if they match the current primary). The event always carries the local primary's full listener, never a partial key: a partial or empty Orchestrator key needs a UUID alias and every given field must equal that primary's listener. The listener is read from live ports **or** the configured port bindings (`resolveOrchestratorMemberDial`), because Docker empties `.NetworkSettings.Ports` once a container is killed. The two sources are read independently (one failing never hides the other; each read times out after 10 s); rows for one incident in one poll send one event; the 15 min re-send hold starts only when `send` returns true (an event dropped for lack of a connection is retried next poll) and is lifted only by the newest poll that read every source and saw the cluster healthy. A daemon restart mid-incident sends the event once more (the control plane matches it to the current primary). The event carries `evidence.spanMs`: how long ago Docker stopped the local primary's engine container (`.State.FinishedAt`, read beside the listener). The control plane's fresh-standby gate anchors the failure start on it; without it that gate never runs and a MySQL/MariaDB cold kill is always `blocked` ("no same-datacenter failover replica is healthy enough"). The anchor is Docker's stop time, not the poll that first saw the row, because Orchestrator plus the 15 s poll add ~20 s and a later anchor makes a replica that streamed until the kill look stale. A running container, Docker's zero time or an unreadable inspect sends no evidence (gate stays closed). Like the Postgres probe, nothing is sent while an intent marker is active: a primary killed within 10 min 30 s of a finished `managed.apply` is reported only once that window ends |
| `pg-dead-primary.ts` / `../instance/pg-dead-primary-observe.ts` | Postgres dead-primary probe on the primary's **own** host (Orchestrator cannot see Postgres). See **Postgres dead-primary detection** below |
| `host-boot.ts` / `boot-hold.ts` / `../instance/boot-hold-reporter.ts` | Boot hold after a power cut: see **Boot hold after an unclean host restart** below |
| `ha-intent.ts` / `ha-member.ts` / `ha-command-hooks.ts` | Probe inputs kept by `command-router.ts`: operator-intent markers around every engine-touching managed verb, and the per-host member record (`managed/<id>/ha-member.json`) |
| `demoted-marker.ts` / `demoted-fence-volume.ts` / `fenced-member-enforce.ts` / `demoted-guard.ts` | After a fence `managed.lifecycle` stop with `demoted: true`: durable `<stateDir>/managed/<id>/demoted.json` (0600, written first) plus an on-disk fence (Postgres `standby.signal` on the data volume; MySQL / MariaDB a read-only block in the mounted `config/my.cnf`) that survives reboot / hand `docker start`. `managed.lifecycle` start/restart refuses while the marker is present; the 5 s guard stops a writable engine (`compose -p <id> stop`, intent marker first, kill + `unsafe` flag if it stays writable). Cleared only through `clearManagedDemotionArtifacts` (fence first, marker last) on replica `managed.apply`, `managed.promote`, switchover abort and `managed.destroy`. See **Demoted member fence**. |
| `engine-exit-guard.ts` / `replica-start-guard.ts` | Every 60 s, `compose start` for a local `ha-member.json` whose engine containers are all stopped/exited, when there is no held stop/destroy intent, demoted marker, lifecycle lock contention, or replica `needs_resync` data (same standby probe as `managed.lifecycle` start). It also leaves alone any engine under an active command or host-wide marker (restore, reboot), an unfinished boot hold, and everything while the boot hold has not been applied. The wait between starts doubles from one minute to 15 minutes; after 6 starts without the engine ever being seen running it stops trying (one warning) until the engine runs again. A stop marker of any age blocks it until a start, restart, apply, promote or failover replaces the marker (a stop that failed half way leaves only a timed one). The markers are read again right before `compose start`, because stop, restore and failover commands do not take the lifecycle lock. Known limit: a primary whose engine exits while the control plane cannot reach this host, and which has no demoted marker or boot hold yet, is restarted; the daemon keeps no epoch or fence record to tell it apart, so the control plane's fence on reconnect (demoted marker + 5 s demoted guard) is what stops it again. Started from `runDaemon` beside the demoted guard. |
| `backup.ts` | `managed.backup` (`create`/`delete`) + `managed.restore` — streamed dump/restore, checksum, prune; exports the shared core (`createManagedBackupArtifact`, `restoreManagedBackupArtifact`, `resolveBackupEngine`) for scheduled runs |
| `target-lock.ts` | Per-engine `flock` (`withManagedTargetLock`, `ManagedTargetBusyError`) shared by the backup/restore handlers and the scheduled `backup-run` process |
| `logs.ts` | Bounded `compose logs`; cell `managed-logs-request` / `managed-logs-result` (not a command) |
| `health.ts` | On-demand member health; cell `managed-health-request` / `managed-health-result` (feature `managed-health-v1`, not a command). Runs `collectManagedMemberHealth` with the request's **real** role — a `replica` is read as a `standby`; the primary query reports `pg_stat_replication` rows and would pass a promote gate for a replica that is not streaming. Never throws: any failure (bad ids, unsupported engine, engine down — `collectManagedMemberHealth` swallows errors and omits `member`) is `{ ok: false, error }` so the control plane is answered instead of waiting out its timeout. Nothing is persisted here; the control plane writes the observation |
| `permissions-read.ts` + `engines/postgres-permissions.ts` / `engines/mysql-permissions.ts` | Read-only "what may these logins do" report; cell `managed-permissions-request` / `managed-permissions-result` (feature `managed-permissions-read-v1`, not a command). `resolveLocalEngine` (`local-engine-context.ts`) finds the engine container without Docker setup and refuses when its `tp.managed.engine` label is missing or names another engine; the engine's optional `readPermissions` runs only `SELECT` / `SHOW` as the engine root over the socket (Postgres inside `BEGIN READ ONLY`, one JSON document per query). Postgres: attributes, every membership reached through inheriting grants (`via` = the role it is held through; `inherit_option` on 16+, the member's `rolinherit` on 15), tablespace and parameter ACLs, then per requested database every explicit ACL entry (database, schema, table, sequence, column, routine, type, language, foreign, large object, default privileges) whose grantee is the login, a role it inherits (`via`) or PUBLIC; a NULL ACL reports nothing. A database dropped or closed to connections since it was listed is skipped; any other failure, or one not read within the 8 s budget (`PERMISSIONS_READ_BUDGET_MS`; the control plane gives up at 15 s), goes in `databasesFailed` and every login is `truncated`. The budget is hard: a query starts only while more than the 3 s per-statement limit is left (`PERMISSIONS_QUERY_LIMIT_MS`, also Postgres `statement_timeout`, MySQL `max_execution_time`, MariaDB `max_statement_time`), and `budgetedExec` races every exec against the time left and kills the `docker exec` child through its `signal` (`resolveLocalEngine` runs execs with `runDockerStreamed`; other callers are unchanged). Only the database's own name in psql's "does not exist" / "not currently accepting connections" words counts as gone. Only Postgres reads `databases`: past 100 the list is cut (logins `truncated`), never refused; MySQL / MariaDB ignore it. MySQL / MariaDB: account rows (lock from `account_locked` / MariaDB `global_priv`), `SHOW GRANTS FOR` per row (escaped batch output, never `-r`, so a name holding a newline cannot pose as a GRANT line; the escapes are undone per line) parsed up to ` TO ` (MariaDB's `IDENTIFIED BY PASSWORD` hash and every trailer never leave the daemon), granted roles read the same way (`via`, at most 50 roles, depth 4); `ALL PRIVILEGES` / `USAGE` are kept as written and `WITH GRANT OPTION` adds `GRANT OPTION`; a database-level name keeps escaped `\_` / `\%` as literal characters and sets `pattern: true` when it holds a bare `_` / `%` wildcard. `REVOKE` lines (partial revokes), an account host that cannot be quoted, the role limits and the time budget mark the login `truncated` rather than modelling or failing. Caps of `ManagedPermissionsObserved` per list, and the frame cut under 100 KB (`truncated: true`), never failed. Never throws: `{ ok: false, error }`, `engine not running` when no container runs |
| `standby-streaming.ts` / `../instance/pg-standby-sampler.ts` | Last `streaming` read per local Postgres standby. The sampler reads this host's replicas every 2 s (5 s deadline per read, never two reads of one container at once; off with `TURBOPANEL_MANAGED_PG_PROBE=off`) and records a streaming read only when the receiver heard from the primary within 5 s (`now() - last_msg_receipt_time`; a silently dropped link stays `streaming` until `wal_receiver_timeout`), stamped at that last receipt on the monotonic clock; `health.ts` adds it to a replica's answer as `replication.lastStreaming` (`ageMs`, plus that read's lag) next to `receivedLsn` / `replayLsn`. The control plane's automatic-failover fresh-standby gate needs it: once the primary is gone the WAL receiver exits and Postgres no longer knows when it last streamed. In memory only; after a restart there is no record and the control plane refuses |
| `engines/` | Per-engine runtime registry (`postgres`, `mysql`, `mariadb`); optional `dropUsers` / `backup` / `replication` (+ optional `configureStandby` for SQL-configured standbys) |
| `engines/sql-stdin.ts` | Shared stdin SQL exec: retry once when docker exec closes stdin (`Writable stream is closed` / EPIPE) with no SQL output, only for batches marked `idempotent` (reads, `CREATE IF NOT EXISTS`, slot ensure); never retry promote or other non-idempotent SQL; never retry a SQL `ERROR` |
| `engines/postgres.ts` + `postgres-sql.ts` | Postgres runtime + pure SQL builders. `runPsql` pipes SQL on stdin and uses `execSqlWithStdinRetry` so a one-shot closed-stream spawn does not mark a healthy replica `failed`. `dropUsers` first releases the role in **every** connectable non-template database (`REASSIGN OWNED BY <role> TO <platform admin>` then `DROP OWNED BY <role>`, skipped when the role is already gone) and only then `DROP ROLE` — a role that holds any database privilege or owns objects otherwise cannot be dropped, and a failed drop left the cluster `failed` with a zombie login. Ownership is reassigned, never dropped, so the data survives. `applyCredentials` then reconciles database access on every apply (older clusters are corrected at their next apply): `CONNECT` is revoked from PUBLIC on every connectable database (`pg_monitor` gets `CONNECT` on `postgres`, so every ProxySQL monitor login keeps its health checks whether or not an apply names it); each SQL user loses databases it is not listed for and gets its strongest level on the listed ones (`owner`: owns; `read-write`: CONNECT/TEMPORARY, exactly SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES on tables (REFERENCES so a migration can add a foreign key to another login's table) and USAGE/SELECT/UPDATE on sequences (never `ALL`: it carries TRIGGER, which would let a read-write login run code as whoever writes the table; no privilege is revoked by name, so it is the same on Postgres 15 to 18), USAGE on schemas, CREATE only in its own schema (schema CREATE elsewhere, `public` included, is the owner login only); `read-only`: CONNECT, SELECT on tables and sequences, USAGE on schemas, and `default_transaction_read_only` per database); inside each listed database existing objects are granted and default privileges are set for what the platform admin, the exposed root login and every owner/read-write login create later. Postgres only lets an object's owner alter or drop it, so read-write reads and writes everyone's tables but alters or drops only its own (a table a read-write login made can be altered by the platform admin or after `REASSIGN OWNED`, not by the owner login). Read-only means no change to any table, sequence or schema; it is not "no writes of any kind" (a read-only login can still make its own large objects, take advisory locks and override its own session default), because the privileges are the wall, not the session default. Database, schema, table and sequence ACL writes are guarded by a comparison with what the login already holds, so a repeated apply does not rewrite them (default-privilege statements and the per-login read-only session setting are still written each apply). `postgres-grants.real-pg.test.ts` runs the real `applyCredentials` against throwaway Postgres containers (16 and 18 by default; runs when Docker answers and `CI` or `TURBOPANEL_REAL_POSTGRES=1` is set, `TURBOPANEL_REQUIRE_REAL_POSTGRES=1` makes a missing container a failure) |
| `engines/mysql.ts` + `mysql-sql.ts` | MySQL runtime + pure SQL builders (GTID, auth_socket platform admin keeps `backup.ts` credential-free). Binlog retention is time-based (`BINLOG_EXPIRE_LOGS_SECONDS`, 7 days); total binlog size is not capped. Root apply creates the password account on the managed Docker network only and re-asserts `root@localhost` `auth_socket`; it never `IDENTIFIED BY` on localhost. When socket auth is missing, waitReady/apply retry via a short-lived 0600 defaults-extra-file (never `-p` / `MYSQL_PWD`). A standby boots `super_read_only`, so its initdb `INSTALL PLUGIN auth_socket` fails (1290); `configureStandby` installs the plugin inside the writable seed window, **before** the dump imports the primary's `auth_socket` grant tables — otherwise the post-seed `FLUSH PRIVILEGES` locks every socket admin out ("Plugin 'auth_socket' is not loaded") and replication is never configured. **Errant GTIDs:** the image entrypoint binary-logs init SQL under the standby's own server UUID; `mysqldump --set-gtid-purged=ON` *adds* the primary set and leaves those replica transactions in `gtid_executed`. `configureStandby` issues `RESET BINARY LOGS AND GTIDS` immediately before the dump import (MySQL 8.4+; `RESET MASTER` is gone) and wraps replica-local `INSTALL PLUGIN` / post-seed `FLUSH PRIVILEGES` in `SET SESSION sql_log_bin=0` so failover/rejoin does not see a replica-only GTID. `CHANGE REPLICATION SOURCE` sets `SOURCE_CONNECT_RETRY = 10` and `SOURCE_RETRY_COUNT = (7*86400)/10` (60480 — seven days of 10 s attempts) so the IO thread keeps retrying across a long primary outage instead of giving up after the engine default (`Source_Retry_Count` is 10 on MySQL 8.4/9.7, ~10 minutes at 60 s) |
| `engines/mariadb.ts` + `mariadb-sql.ts` | MariaDB runtime + **own** dialect (not a MySQL alias; `MASTER_USE_GTID=slave_pos`, `mariadb-dump --gtid`). Root apply creates the password account on the managed Docker network only and re-asserts `root@localhost` `unix_socket`; it never `IDENTIFIED BY` on localhost. When socket auth is missing, waitReady/apply retry via a short-lived 0600 defaults-extra-file (never `-p` / `MYSQL_PWD`). **Replica write guard:** MariaDB has no `super_read_only` (MDEV-18441). `GRANT ALL` includes `READ_ONLY ADMIN` (10.11+; that privilege, not `SUPER`, writes through `@@read_only=ON`). Network / ProxySQL-reachable root is `GRANT ALL` then `REVOKE READ_ONLY ADMIN` so a replica `INSERT` is ERROR 1290; unix_socket `root`/`mysql`@localhost keep `ALL` so seed/promote can `SET GLOBAL read_only`. App and monitor grants are not global `ALL`. `configureStandby` re-asserts socket `ALL` and revokes `READ_ONLY ADMIN` from non-localhost accounts after the dump (an older primary's `GRANT ALL`). Promote re-asserts socket `ALL` and does not give network logins `READ_ONLY ADMIN`. `SUPER` stays on network root (some `SET GLOBAL`); it does not bypass `read_only` on 11.8. `mariadb-read-only.real.test.ts` checks this against `mariadb:11.8` when Docker answers. **Errant GTIDs:** same entrypoint-init hazard; the seed script already `RESET MASTER` with `sql_log_bin=0` around the import. Post-seed `FLUSH PRIVILEGES` and the privilege-guard batch (`ensureSocketAdmin` + revokes) are wrapped in `SET SESSION sql_log_bin=0` — without that wrap they mint replica-domain GTIDs after an otherwise clean seed. `CHANGE MASTER` sets `MASTER_CONNECT_RETRY = 10`. MariaDB 11 has no `MASTER_RETRY_COUNT` on `CHANGE MASTER` (it is a syntax error); the IO thread retries indefinitely at that interval |
| `engines/replica-io-restart.ts` | Pure restart decision for a MySQL/MariaDB replica after connection loss: `readHealth` issues `START REPLICA` / `START SLAVE` when IO or SQL stopped with a connection-class error (including SQL errno 2013/2003/2006/2002 while IO is still running or `Connecting` and IO fields are clean), never through applier/GTID errors (duplicate key, purged binlog, etc.), and a TCP ping shows the primary is reachable. Logs heal attempts at info. Existing replicas seeded before the retry-count CHANGE still heal on the next health poll |

`waitReady` for the SQL engines that seed after compose up must prove the **real** server, not the image entrypoint's temporary init server (unix socket only, networking off). Socket ping succeeding is not enough: require a TCP ping to `127.0.0.1:3306` inside the container, then a second socket ping so a stop/start between probes is caught. `configureStandby` waits for that same proof and retries the seed once when the first attempt produced no output or errors 1133/2002/2006/2013. The seed script records dump vs import stderr and exit codes separately so a failure names the side that died.

Orchestrator topology TLS: engines that require encrypted transport reject a plaintext client (`Error 3159`). The working image key is `MySQLTopologyUseMutualTLS` (`MySQLTopologyUseSSL` is ignored). `MySQLTopologySSLCAFile` is still set when a CA is present, but verification uses the process trust store — compose sets `SSL_CERT_FILE` to `/etc/orchestrator/tls/ca.pem` (the `./tls` bind). `MySQLTopologySSLSkipVerify` is true only when that CA path is absent. Orchestrator (Go) reads `SSL_CERT_FILE` and its conf **once at start**, and `compose up -d` only notices a changed compose file, not changed bind-mounted files: `ensureOrchestratorStack` therefore stamps `tp.managed.config-digest` (`orchestratorFilesDigest`, truncated SHA-256 of the conf plus `tls/ca.pem`) on the service, so a new bundle or conf changes the compose file and compose recreates the container. An identical bundle written again recreates nothing, and because compose compares the label with the running container, a reconcile that failed after writing the files still recreates on the next `compose up` (reconcile, `system.reconcile` or the stack unit). TLS files are written to a sibling temp file and renamed in, so a starting container never sees a missing `ca.pem`. Raft followers forward `/api/discover` to the **leader**, so it is the leader's trust that verifies member leaves: every Orchestrator host in the organization must get the current bundle (the control plane reconciles them all, `turbopanel/src/features/managed/ha-desired.ts`).

Orchestrator topology **login** is one derived account per organization (`tp_topology_<org prefix>`, HKDF off the instance root secret on the control plane — see `../turbopanel/src/features/managed/topology-credential.ts`), not a cluster replication user: Orchestrator holds a single `MySQLTopologyUser`, one Orchestrator runs per organization, and a server with two HA clusters has two replication users, so whichever one the payload named was refused by every member of the other cluster (`Error 1045`) and nothing registered. Primary `managed.apply` ships `topologyUser` and the MySQL/MariaDB engine runs `ensureOrchestratorTopologyAccountSql` (`orchestrator-topology-sql.ts`: the monitor account's host list **plus the private ranges `10.0.0.0/8` and `192.168.0.0/16`** — discovery and recovery run on the organization's Raft leader, which can be an Orchestrator server outside the cluster and dials from its own address on the route to the member, so a members-only host list left the leader refused with `Error 1045 … @'<leader address>'` and nothing registered; MySQL `SUPER`/`PROCESS`/`REPLICATION CLIENT`/`RELOAD` on `*.*`, MariaDB adds `REPLICA MONITOR` for `SHOW REPLICA STATUS`, plus `SELECT` on the `meta` schema, `REQUIRE SSL`, no `IDENTIFIED WITH` so MySQL 8.4/9.x mint `caching_sha2_password`; `orchestrator-topology-sql.docker.test.ts` applies the generated SQL to `mysql:8.4`/`9.7` and `mariadb:11.8`/`12.3` when Docker is available). **Binlogging stays on for it** — a standby boots `read_only=ON, super_read_only=ON` and cannot mint the account itself (1290), so the primary's statements have to replicate, exactly as the monitor roles do; a `SET SESSION sql_log_bin=0` wrapper would strand the account on the primary and leave Orchestrator denied on every replica, and the errant-GTID hazard it guards against cannot arise because `applyManagedEngineState` returns early for a standby. The engine-specific replication-table grant (`mysql.slave_master_info` / MariaDB `mysql.gtid_slave_pos`) is a separate advisory statement: a table-level grant fails outright on a release that does not ship that table and Orchestrator only warns without it. `managed.ha.reconcile` sets `MySQLTopologyUser` / `MySQLTopologyPassword` from the same payload field; Postgres clusters in the reconcile list are dropped before anything is resolved or registered (Orchestrator speaks MySQL only). **Orchestrator HTTP basic auth and Raft** use the same derivation machinery (`orchestrator-api-credential.ts` on the control plane): `orchestratorApiUser` + `orchestratorRaftToken` on the reconcile payload, materialized to `api.cnf` / `raft.cnf` on every org Orchestrator host (Ansible no longer mints per-host RNG). Raft voters are only servers hosting a MySQL/MariaDB primary or same-DC `failover` replica.

Orchestrator self-heal: `restart: always` does not bring back a container that was killed by hand, so the stack stays down until the next apply/`managed.ha.reconcile`. While the compose file exists, `ManagedHaObserver` (`../instance/ha-observe.ts`) polls every 15 s and, before the API poll, calls `reviveStoppedOrchestratorContainer`: `compose start` only after two consecutive polls still list an exited/dead/created container. Stop, restart, and apply set an in-process busy-until marker around their compose mutation (cleared in `finally`), and a busy or live/absent observation resets the stopped streak. Completed checks are cooled down for 60 s. This closes the mid-`compose down` / recreate window without losing self-heal for a container killed by hand.

**Routing by login kind** (`managed.ingress.reconcile` user `connectionRole` and optional `tool`): a `read-only` login defaults to the reader hostgroup only when the cluster has a read-eligible replica; on a single server it defaults to the writer (the primary), because its grants, not its route, keep it read-only. A `tool` login (used by a database tool) always defaults to the primary and never gets a read/write split rule. Absent `tool` means false.

**Straight-through logins (`fast_forward`)**: the optional user field `straightThrough` (boolean, decided per login by the control plane; migration-level logins default to true there) puts `fast_forward=1` on the login's `pgsql_users` row (cold-start cnf in `renderUserRows`, admin SQL as the `fast_forward` column in `renderAdminUserInsert`; both go through `userUsesFastForward`). Why: ProxySQL 3.0.9 to 3.0.11 does not implement the PostgreSQL Flush message (0x48, log `Not implemented yet. Message type 0x48`), which the Node `postgres` driver and drizzle's migrator send after Parse/Describe on every parameterized query, so those clients get SQLSTATE 0A000. Straight-through mode passes the bytes untouched. Cost: one backend connection per client session, no connection reuse, no query rules (so no read split). Rendered only for the pgsql family, `role: "user"` and `allowedSources` absent: a source limit and the root guard are enforced by query rules, which fast_forward bypasses, so for a limited or root login the flag is ignored even when true and a warning is logged once per login. System and replication logins are never sent to the front door. The MySQL family does not use the flag. Users are rewritten wholesale on every apply (`DELETE` then `INSERT`), so a change in the flag or in the limit is applied by the next reconcile; there is no per-column diff to extend. Absent or false (older control plane) = today's behaviour.

**Per-login grant mode** (`grantMode` on a `managed.apply` credential, optional): absent, `preset` and `recipe` behave exactly as before (the daemon sets permissions from `privileges` on every apply; recipes are not built yet). `self` means the site owner manages permissions by hand. The login, password, host rows, `NOSUPERUSER`, connection limit and, on Postgres, `CONNECT` on its listed databases stay the panel's, and the cluster-wide PUBLIC connect revoke still runs. Postgres skips `revokeUnlistedDatabasesSql`, the `grantDatabaseSql` REVOKE/GRANT pair, `exactObjectAclSql`, the per-login schema and read-only session default, and leaves the login out of the `defaultPrivilegeSql` creators list; MySQL/MariaDB skip `grantDatabasePrivileges`. `grant-mode.test.ts` pins preset output to hashes captured from trunk and asserts none of the skipped statements appear for a `self` login. Dropping the login still works as before.

**MySQL / MariaDB database names in grants** (`engines/grant-pattern.ts`): a database-level `GRANT` reads `_` and `%` in the name as wildcards, so `GRANT ... ON \`wp_site\`.*` also reached `wpXsite`. `grantDatabaseSql` now writes the name escaped (`wp\_site`). Versions before that left the plain grant on the account; every apply grants on the escaped name first and then, for a database whose name holds `_` or `%`, removes the plain row for that account and host (`revokePlainDatabaseGrantSql`: two `REVOKE`s (`ALL PRIVILEGES`, then `GRANT OPTION`; the combined form does not parse with an `ON` clause), each run only while `mysql.db` still has that exact row, so nothing errors when it is absent). It runs only on databases the panel grants on (never a `self` login, except the Database admin login) and only after every grant on that database succeeded, so a login keeps access throughout. Anything added by hand on the plain row itself goes with it (the escaped row holds exactly the current preset). Hand-made grants on other names, and the account and its data, are untouched. Proven on MySQL 9.7; MariaDB uses the same statements.

**MySQL / MariaDB levels are three jobs, data only below the migration login** (`engines/grant-pattern.ts`, feature `managed-data-only-readwrite-v1`): `read-only` = SELECT, SHOW VIEW (no EXECUTE: a routine runs with its definer's rights, so a login allowed to call one could change data); `read-write` = SELECT, INSERT, UPDATE, DELETE, EXECUTE, LOCK TABLES, CREATE TEMPORARY TABLES, SHOW VIEW and nothing that creates, alters or drops a table, index, view, routine, trigger or event; `owner` (the migration login) = ALL PRIVILEGES on its database, no GRANT OPTION; `admin` (the Database admin login) = ALL PRIVILEGES WITH GRANT OPTION. A `GRANT` only adds, so each level grants its set and then revokes the rest of the database-level privileges (and `GRANT OPTION`) the row holds (a prepared `REVOKE` built from `mysql.db`, because MySQL refuses a `REVOKE` naming a privilege the row lacks, error 1141): a login made under the older wide recipe is tightened by its next apply, and a repeat apply changes nothing. A login that lists several levels gets the strongest only (`grantDatabasePrivileges`), because a weaker level would revoke what a stronger one granted. Objects the migration login makes need no extra grant: grants are database-wide. `self` logins are never touched (the Database admin login is still granted in `self` mode). `TRIGGER` and `EVENT` are left on a login that still defines a trigger or a scheduled event in the database (they run with the definer's rights: a trigger fails with error 1142 on every write once the definer loses `TRIGGER`, an event stops firing); they go when those are recreated by the migration login. Known limit: a database whose name holds `_` and still carries the pre-escape plain grant row loses its trigger right when `revokePlainDatabaseGrantSql` removes that row. MariaDB images are 11.4 and newer, which have `Show_create_routine_priv` (older servers would fail the apply). Data changes only also means no `TRUNCATE TABLE` (it needs `DROP`). Rights reached through a hand-made role are not seen (no `mysql.db` row).


**Postgres owner role per database and the Database admin login** (`databases[].ownerRole` on a `managed.apply` create/drop op, and the `admin` entry in a credential's `privileges`; both optional, absent = today's behaviour). A database made with `ownerRole` gets three roles that cannot log in, `tp_<db>_owner`, `_rw` and `_ro` (`postgres-owner-role-sql.ts`; the `tp_` prefix is reserved for logins by the control plane; database names are at most 54 characters), and `CREATE DATABASE ... OWNER tp_<db>_owner`. A database that already exists with another owner is left exactly as it is: moving a database that holds data onto an owner role only happens on request: `databases[].convertExisting` (`managed-database-convert-v1`, with `ownerRole`) runs `convertDatabaseToOwnerRole`: `reassignDatabaseObjectsSql` in the database, then the database itself moves. The object step is one transaction (`SET LOCAL lock_timeout = '5s'`, so a busy table fails the run cleanly and a repeat is safe); the database move is a separate statement after it, so a failure between them leaves the old database owner and a repeat finishes the job. It hands over schemas, tables and partitions, views, materialized views, sequences, foreign tables, routines, types and domains, operators, collations, extended statistics, text search configurations and dictionaries, conversions and foreign servers the owner role may use, whoever owns them now. Left alone on purpose: extension members; large objects, event triggers, publications, subscriptions, languages and foreign data wrappers (superuser-only or not part of the data); default privileges (`pg_default_acl` entries of the former owners stay, no grant is changed). It never uses `REASSIGN OWNED` (role-wide, cannot touch the platform admin). It runs even when the database already belongs to its owner role or chosen login, so objects other roles made since are picked up; it logs how many objects were handed over. An empty first database is moved without it, see below. `applyCredentials` takes an optional `{ ownerRoleDatabases }` (the flagged names) and checks the catalog that each really belongs to its owner role; with none flagged nothing extra runs and the SQL is byte-identical to before (`grant-mode.test.ts` hashes). On an owner-role database the per-login machinery is replaced: a login with `owner` becomes a member of the owner role with `INHERIT FALSE, SET TRUE` (Postgres 16+; on 15 a plain grant plus role-wide `NOINHERIT`) and gets `ALTER ROLE ... IN DATABASE ... SET role = owner role`, so tables it creates from any tool belong to the owner role; `read-write` / `read-only` become inheriting members of `_rw` / `_ro`; default privileges for objects created by the owner role, the platform admin and the exposed root login grant the groups data access, and objects that already exist are healed. A login no longer on the database loses the memberships and gets `RESET role` (otherwise it could not connect). The Database admin login (`admin`) is a member of the owner role with `INHERIT TRUE, SET TRUE`, the same session default, and `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`; on a database without an owner role it gets the read-write rights (see Chosen database owner below). Its rights are the panel's whatever `grantMode` says. On MySQL/MariaDB `admin` grants `ALL PRIVILEGES ON <db>.* ... WITH GRANT OPTION` on the login's listed databases (`owner` is the same without the grant option), never anything global (no `CREATE USER`, `SET_ANY_DEFINER`, `SET USER`, `*.*`). Dropping a flagged database drops its three roles (best effort). **Chosen database owner (`managed-database-owner-v1`).** `databases[].ownerLogin` (Postgres create with `ownerRole`, the applied username of a login) makes that login the database's owner. The roles are still made first and `CREATE DATABASE` still names `tp_<db>_owner`, because the login may not exist yet; `applyCredentials` (given `{ ownerRoleDatabases, ownerLogins }`) then runs `adoptChosenOwners` before the catalog check: the database moves onto the login (`ALTER DATABASE ... OWNER TO`) only when it is still owned by `tp_<db>_owner` or is the platform admin's and empty (`databaseIsEmptySql`: nothing a person made), the login is a preset-mode, non-read-only login listed on it, and otherwise is left exactly as it is. The catalog check then accepts the recorded login as the owner as well as `tp_<db>_owner`. The login works through the owner role like a Database admin (`INHERIT TRUE, SET TRUE`, `role` session default), so what it creates belongs to `tp_<db>_owner` and the rw/ro groups see it; default privileges also cover objects it creates under its own name. Never the platform admin or root login. The first database of a new cluster is made by the engine's first start for the platform admin: `createOwnerRoleDatabase` moves it onto its owner role while it is empty, and leaves it alone once anything is in it. `dropUsers` first hands every owner-role database the dropped login owns back to its `tp_<db>_owner` (`ownerLoginReturnSql`), so deleting a login never gives a database to the platform admin. A Database admin login on a database that has no owner role gets the read-write rights there (CONNECT and TEMPORARY, data access to what exists and what is created later, no ownership, no grant option, no membership in a platform role) instead of CONNECT only; the control plane says so in plain words. Changing an existing database's owner is not an apply step.

**Postgres read-write is data only, like MySQL and MariaDB.** `read-write` (the plain login or the `_rw` group) holds SELECT, INSERT, UPDATE and DELETE on tables and USAGE, SELECT and UPDATE on sequences. TRUNCATE and REFERENCES belong to the `owner` (migration) level only, on both the owner-role path (`postgres-owner-role-sql.ts`) and the older per-login path (`postgres-sql.ts`). Every apply also takes both away from a read-write login or group that an earlier release gave them, on existing tables and in the default privileges for later ones, and writes nothing when they are already gone (`postgres-grants.real-pg.test.ts` runs both paths on real Postgres 16 and 18, including a repeated apply that rewrites no ACL).

Backup restore skips per-login schemas on an owner-role database; a restored table is handed to the owner role in the same transaction.

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
# <backupDir>/managed/<managedId>/ (LayoutPaths.backupDir, /backup by default,
# TURBOPANEL_BACKUP_DIR to override) so an operator can mount separate storage
# for them without moving the engine's own state:
#
# /backup/managed/<managedId>/  # 0750; artifacts written 0600 by the daemon user itself
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
├── admin.cnf            # [client] admin user/password, mode 0640 root:<daemon group> (Ansible once; the unprivileged daemon reads it, the proxy container mounts it read-only)
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

The engine root password reaches the engine as a file, not an env value:
normalization rewrites `POSTGRES_PASSWORD` / `MYSQL_ROOT_PASSWORD` /
`MARIADB_ROOT_PASSWORD: ${TURBOPANEL_MANAGED_ROOT_PASSWORD}` to `<KEY>_FILE`
pointing at `/run/secrets/tp_root_password`, a read-only bind of
`<stateDir>/managed/<id>/secrets/root-password` (created `0600` by the daemon, then handed to the engine's own user by a
throwaway root container: `engineUser:engineGroup` `0400`, never world-readable;
the daemon never rewrites it afterwards), so `docker inspect` shows only a path. The file persists
(restart policies re-bind it). An engine created before this keeps the old
env form (persisted compose still contains the placeholder): an apply that
leaves its compose byte-identical keeps it (no restart); any apply that
recreates the container anyway moves it to the file form. Only then does the
legacy `.env` (`0600`, deleted in `finally`) apply to `compose --env-file … up`.

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
- Shared ProxySQL needs a **4 KiB-page kernel**: the published image bundles a memory allocator compiled for 4 KiB pages and aborts on 16/64 KiB-page kernels (exit 133, "Unsupported system page size"; Raspberry Pi 5 default kernel, Apple Silicon, some 64 KiB ARM servers). `ensureProxySqlIngress` reads the host page size (Linux only) and fails with a plain-words error before touching compose (`proxySqlPageSizeError`). That error names the absolute `tp-orchestrate` path (`/opt/turbopanel/share/orchestration/scripts/tp-orchestrate`); it is not on PATH. Consumer hosts need the proxy too: apps reach managed databases through `localhost:13306` and `localhost:15432` even when no database runs on that server. Raspberry Pi OS on Debian 13 is switched with `orchestration/scripts/tp-kernel-features` (typed mirror: `src/host/kernel-features.ts`); the installer runs it as its last step unless `TURBOPANEL_SKIP_KERNEL_SWITCH=1`, and reboots only on a first install (it records whether `server.id` existed and when the run began, and needs fresh enrolment files). `undo` only removes a line this tool added (marker in `/var/lib/turbopanel-kernel`). A newer image tag does not help (3.0.11 still fails); preloading a system allocator does not help either (the bundled one wins).
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
| Admin apply | `proxysql-admin.ts` loads `admin.cnf`, mounts it into a throwaway client or uses stdin; SQL LOAD/SAVE — credentials never argv/logs **Runtime readback:** after the apply, `managed.ingress.reconcile` reads `runtime_mysql_servers` / `runtime_pgsql_servers` (families in use only, same admin path, `readProxySqlRuntimeServers`) and compares them with the desired placement (`findIngressRuntimeMismatch` in `proxysql.ts`): every desired hostgroup/host/port row must be present and a cluster's writer hostgroup must hold nothing else, so a stale old primary fails the command (`ProxySQL on this server did not repoint: writer for <cluster> is still <host:port>, expected <host:port>`). `status` is not compared (ProxySQL's monitor may shun a backend). Skipped on teardown (no clusters) |
| Backend monitor | **Control-plane minted, per server** (`tp_monitor_<serverId prefix>`; sealed on the instance's dedicated `monitor` table, never on `server.options`): `managed.ingress.reconcile` ships this server's credential (`payload.monitor`, tpdaemon envelope) — the daemon sets the monitor globals from it and **rewrites `monitor.cnf`**; primary `managed.apply` ships `monitorUsers[]` (one per fronting server — members + bound consumers) and the engine creates each role (`GRANT pg_monitor` / MySQL PROCESS+REPLICATION CLIENT); standbys inherit them via WAL. Per-host random `monitor.cnf` seeds alone cannot work cross-host: ProxySQL's monitor cred is one global per instance and a single engine role holds one password. Legacy fallback (payload fields absent): host-seeded `monitor.cnf` + local role after the same lazy `runProxySqlSetup` as ingress. **Never** leave ProxySQL defaults (`monitor`/`monitor`) — they spam engine logs and never authenticate. MySQL/MariaDB account host scoping: `ctx.clientSourceHosts` (every member host IP including this host's `privateListener` address, plus `ingressSourceAddresses` consumers) adds per-host monitor/client/root accounts + grants alongside the managed-docker-network pattern — omitting the local listener left ProxySQL on this host SHUNNing replicas (`Host '…' is not allowed to connect`) |
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
- **External access publishes both families.** With the setting on the
  control plane sends `["0.0.0.0", "::"]` on a server with IPv6 (only to a
  daemon advertising `managed-ingress-ipv6-v1`), else `["0.0.0.0"]`. `::`
  renders as `"[::]:<port>:<port>"` and reads back unbracketed, so self-heal
  keeps the IPv6 publish. See **Real client addresses (IPv6 network)** below
  for how IPv6 clients reach ProxySQL with their own address.
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

### Real client addresses (IPv6 network)

ProxySQL's `cli_host` (and anything that later filters on the client address)
is only as good as what Docker hands it. Before this, the managed network was
IPv4 only, so Docker's userland proxy (`docker-proxy`) accepted every IPv6
connection on the host and opened a fresh IPv4 one to the container: every
IPv6 client showed up as the managed network's gateway (`172.x.0.1`, measured
on canary with ProxySQL 3.0.9 / Docker 29.8). `proxysql-ipv6.ts`:

- **ProxySQL's own IPv6-only network.** While a client listener is published on
  an IPv6 address (`proxySqlBindsUseIpv6`), the compose file joins a
  compose-owned network `proxysql-ipv6` (`enable_ipv4: false`,
  `enable_ipv6: true`, one unique local /64 from SHA-256 of the managed-ingress
  `serviceId`, `proxySqlIpv6Subnet`). Docker picks the IPv4 and IPv6 gateways
  separately (the first endpoint with each family, moby `getGatewayEndpoint`)
  and maps each family's host ports on its own gateway endpoint, so the IPv4
  gateway and IPv4 publish stay exactly where they were and the `[::]`
  publish becomes a kernel DNAT to the container's address on this network.
  Only ProxySQL joins it; the shared managed network (engines, Orchestrator)
  is not touched or recreated. No IPv6 publish, no network: an IPv4-only
  server's compose file is byte-for-byte what it was.
- **ProxySQL listens on IPv6 too.** `mysql-interfaces` / `pgsql-interfaces`
  become `0.0.0.0:<port>;[::]:<port>` with the network
  (`desiredProxySqlListenerInterfaces`). ProxySQL sets `IPV6_V6ONLY`, so the
  two do not collide and IPv4 clients keep plain IPv4 addresses. Both are read
  only at start, and `proxysql.cnf` only on a first boot (an existing
  `proxysql.db` in the data volume wins, ProxySQL "ignoring configuration
  file"), so `managed.ingress.reconcile` reads `runtime_global_variables` and,
  when the running value differs, `SET`s them and `SAVE … VARIABLES TO DISK`
  (no `LOAD … TO RUNTIME`: ProxySQL would put the running value back) *before*
  compose recreates the container (`stageProxySqlListenerInterfaces`), so the
  new container starts with them. After the admin apply it reads them again
  and, if they still differ (no recreate happened, or staging could not reach
  the admin port), saves them and restarts the container once, then checks
  they took (`activateProxySqlListenerInterfaces`). With an IPv6 listener it
  then probes `[::1]:<port>` inside the container for each family in use with
  the container's own `mysql` client (the only command the docker-gate allows
  there; a refused connect, ERROR 2002/2003, means closed, anything past the
  connect means open), because the variable says nothing about whether the
  bind worked; a failed probe fails the reconcile. Staging uses no admin
  connect retries, so a missing or stuck container costs nothing. The same path also applies a
  changed listener port on a host whose `proxysql.db` predates it.
- **Upgrade path.** The next `managed.ingress.reconcile` on a server publishing
  `::` re-renders compose and recreates the container onto the new network
  (data volume kept) with the IPv6 listeners already saved: one short listener
  blip, no engine container and no database data touched. The
  `system.reconcile` self-heal keeps exactly the IPv6 network on disk
  (`readCurrentProxySqlIpv6Subnet`) and never adds it, because it does not
  switch the listeners: a network without the IPv6 listener would send IPv6
  clients to a closed port.
- **What clients show after the fix.** Internet IPv6 clients: their real
  address. Internet IPv4 clients: their real address (unchanged, DNAT). Host
  processes on `127.0.0.1` (site PHP through `tp-php-loopback`, the panel
  host's own tools): still the managed network's IPv4 gateway — Docker serves
  loopback publishes through `docker-proxy` (and with `userland-proxy: false`
  masquerades them), so a loopback client is never seen as itself. `::1` is
  not published. Containers that dial ProxySQL by name on a network it shares
  (the managed network, a `tpn_*` attachment): their own container address, as
  before. A container on the managed network that dials the host's public
  address instead is hairpinned through `docker-proxy` and shows the gateway.
  (The loopback and hairpin answers follow from Docker's documented rules; the
  canary client-address test is the measurement.)
- **Firewall.** IPv6 published traffic now crosses ip6tables `FORWARD` /
  `DOCKER-USER` like IPv4 instead of the host's `INPUT` chain, so the host
  firewall's `published` rules apply to it (`src/firewall/render.ts` renders
  both families). `firewall.ts` `TP-MGD-<id>` is engine private-listener
  scoping and stays IPv4 only.
- **Host requirements.** Docker Engine 28+ (separate IPv4/IPv6 gateway
  choice and IPv6-only networks: on Engine 27 one network is the gateway for
  both families, so the IPv4 path could move) and Compose 2.33.1+
  (`enable_ipv4`). The reconcile checks both (`proxySqlIpv6NetworkSupport`);
  on an older version it renders no IPv6 network and no IPv6 listener and logs
  a warning, so IPv6 keeps the old `docker-proxy` path (connected, gateway
  address). A version that cannot be read (dockerd restarting) keeps whatever
  the previous compose file had. dockerd also needs `ip6tables` on (the default
  since Docker 27); without it the publish falls back to `docker-proxy`.
- **Turning IPv6 off** drops the network from compose and `[::]` from the
  listeners (same staging). Compose leaves the now-unused
  `<project>_proxysql-ipv6` network behind; it is empty, harmless, and reused
  (same subnet) if IPv6 comes back.

### Server version reported to clients

ProxySQL answers the client handshake itself with one global string per
module: `mysql-server_version` (default `8.0.11`) and `pgsql-server_version`
(default `16.1`), so PostgreSQL 18, MySQL 9.7 and MariaDB 11.8 all looked like
PostgreSQL 16.1 / MySQL 8.0.11 to drivers and tools. The control plane sends
each cluster's `engineVersion` (the release series from its image: `18`,
`9.7`, `11.8`) and `buildProxySqlAdminStatements` sets both variables
(`SET … ; LOAD … TO RUNTIME; SAVE … TO DISK`, dynamic, no restart). Rule
(`proxysql-server-version.ts`), per listener: the newest PostgreSQL series on
the PostgreSQL listener; on the shared MySQL-family listener the newest MySQL series when any
MySQL cluster is on it, else the newest MariaDB series as `<series>-MariaDB`
(MariaDB 11+ format, no `5.5.5-` prefix). Clusters without a version count for
nothing; a family with none keeps its value. The series has no patch level, so
it is padded with zeros because clients parse the string (MySQL-family drivers
such as Connector/Python, Rails, libmysqlclient and mysqlnd want three parts;
PostgreSQL versions always have two, so a longer one is cut): `9.7.0`,
`11.8.0-MariaDB`, `18.0`. MySQL and PostgreSQL variables share one
`LOAD`/`SAVE` per family with the monitor credentials.
Never written into `proxysql.cnf`: that file is read on a first boot only, and
a static-section change restarts ProxySQL for every client.

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
   Normalized engine compose never emits arbitrary `ports:`. A cluster may
   publish **one** engine port bound exclusively to the member's datacenter,
   fabric (`tp0` relay), **or public** address at the instance-allocated
   `private_port` — that private listener is the single cross-host path for
   both streaming replication and remote ProxySQL backends (including a
   single-member engine whose bound app lives on another host). Loopback and
   `0.0.0.0` binds are rejected. A cluster with no remote peer and no remote
   consumer still publishes nothing; client traffic enters only via the
   shared ProxySQL client listeners. The consumer host's reconcile still
   ships `clusters[].users` for that remote backend — a missing private port
   fails the whole cluster (no frontend login), which is why apply must
   allocate the port first.
   A **public** bind (`privateListener.transport === 'public'`) is mandatorily
   **Organization CA** TLS-only: `assertPublicPrivateListenerTls` (exported from
   `compose.ts`, run first in `apply.ts` and again during compose normalization)
   refuses the listener unless `orgTlsMaterial` is present, so `tls/server.crt` +
   `ca.crt` (Organization CA material) always land before the publish exists. `firewall.ts` then scopes that
   publish to the known peer address(es) — still never `0.0.0.0`, and never a
   broad fallback when no stable peer address is known. When apply later
   clears the listener (or it is no longer public), the same path removes the
   per-cluster `TP-MGD-<id>` chain so a leftover DROP cannot block a later
   cluster that reuses that address/port.
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
   - **A restore returns the database to the backup's state, all or nothing.**
     Postgres runs one transaction: `restoreResetSql` drops every user schema
     (only `public` is recreated, with its owner and privileges; the dump
     creates the others), then the dump is replayed as plain SQL
     (`pg_restore --no-owner --clean --if-exists -f -` into `psql`), then
     `restoreReadWriteLoginSchemasSql` recreates per-login read-write schemas.
     `COMMIT` is sent only when `pg_restore`
     succeeded, and the script fails unless the server confirmed the commit,
     so a truncated dump, a failing statement or a lock timeout (30 s) leaves
     the data untouched. Rows, tables and schemas made after the backup are
     gone. Roles, the database itself and its connect rights are not touched.
     The replay creates objects as the platform admin (`--no-owner`); inside the
     same transaction `handOverPlatformObjectsSql` then gives them to the
     database's owner (`tp_<db>_owner`, or the chosen owner login), so a
     migrations login keeps working on restored tables. A database still owned by
     the platform admin is left as it is. Every apply of an owner-role database
     runs the same hand-over for objects the platform admin or root login made,
     which repairs databases restored by an earlier release. The hand-over covers
     schemas, tables, views, materialized views, foreign tables, standalone
     sequences, routines and types; operators, collations, text search
     configurations and dictionaries, conversions, extended statistics, foreign
     servers, publications and large objects stay with the platform admin, and
     objects an extension owns or another role made are never touched. It waits
     at most 5 s for a lock (a repeat is safe).
     **`pg_restore --clean --if-exists` inside the transaction** drops and
     recreates only objects **named in the archive** (tables, schemas, extensions
     in dumped schemas, publications, event triggers, large objects, …). Anything
     database-global created **only after the backup** and absent from the dump
     is **not** removed by `--clean` (for example a publication or event trigger
     that did not exist at backup time). Schema reset (`restoreResetSql`) still
     removes post-backup user schemas and their contents before replay. The
     replay strips `SET lock_timeout` / `SET statement_timeout` lines from
     `pg_restore` output so the transaction's `SET LOCAL lock_timeout = '30s'`
     stays in effect for the whole restore. That `sed` step must stay plain
     POSIX (no GNU-only flags such as `/I`): the default image
     `postgres:18-alpine` ships BusyBox `sed`, which rejects them, and every
     restore then rolled back. `postgres-restore.real-pg.test.ts` runs on
     `16`, `18` and `18-alpine` by default for that reason. The session sets
     `client_min_messages = warning` first, so the reset's "drop cascades to"
     notices never crowd the real error out of a failed restore's message.
     MySQL/MariaDB dumps already drop and recreate the dumped tables.
   - **`.part` cleanup on failure.** Partial artifacts must never look complete.
   - **Prune by retention, one directory at a time.** After create, keep the
     newest `retentionKeep` artifacts **in the artifact's own directory**;
     omit retention → no prune. Manual backups prune `<backupDir>/managed/<managedId>/`
     (files only, so never a `policy-*` subdirectory); a scheduled backup
     prunes only its `policy-<policyId>/` directory, so an hourly keep-24
     policy never deletes a daily or manual backup.
   - **One core, two entry points.** `createManagedBackupArtifact` /
     `restoreManagedBackupArtifact` hold the dump/verify/restore logic;
     `handleManagedBackup` / `handleManagedRestore` validate the command
     payload and call them. Scheduled runs call the same core with a
     `policyId`. The core re-checks every id it builds a path from.
   - **`managed.destroy` removes `<backupDir>/managed/<managedId>/`** alongside the
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
| Slots / disk hazard | Physical slots; `ensurePrimary` drops orphan slots (never one a replica is attached to) and replaces `lost` ones (invalidated by the `max_slot_wal_keep_size` cap, unusable even for a re-seed) before it creates the desired ones, with a slot created **unreserved** (keeps no WAL, so no retain/lost loop) that health keeps reporting as `critical` / `walStatus: awaiting_resync` on every later apply until the Resync reserves it (slot lookups use `starts_with`, not `LIKE`); a failing sweep is logged and never fails the apply; a primary with no replication payload (last replica removed) sweeps every `tp_member_*` slot via `pruneOrphanSlots`. The instance sets the cap in `postgresql.conf`. Primary `readHealth` adds `slotRetention` (`ok` / `lagging` = a slot holds more than `max_wal_size` / `critical` = `unreserved`, `lost` or `awaiting_resync`, that replica needs a Resync) | **No slots.** Platform `my.cnf` (rendered by the control plane, daemon writes verbatim) sets `binlog_expire_logs_seconds` to 7 days (`BINLOG_EXPIRE_LOGS_SECONDS`). **Total binlog size is not capped:** MySQL 8.4 / 9.7 have no combined-volume option, so a busy primary can still fill the disk inside those 7 days. Do not add a size-based purge — it can drop binlogs a replica has not yet applied. Expiry stays seconds-based so lagging replicas are not cut off by a cap |
| Bootstrap | `bootstrapStandby` **before** compose up seeds via `pg_basebackup -R` | Probe only before compose up (uninit → `seeded` deferred; marker → `already_standby`; datadir without marker → `needs_resync`). Actual seed in **`configureStandby`** after compose up (logical dump + `CHANGE REPLICATION SOURCE` / MariaDB `CHANGE MASTER` + GTID) |
| Bootstrap probes | All engines probe data-dir state via `sh -c 'test … && echo present \|\| echo absent'` and **require the probe container to succeed** — a docker-level failure throws (`standby data probe failed`) instead of being misread as an uninitialized volume and triggering a spurious re-seed | same |
| Data dir | PGDATA is **pinned** to `<volume>/data` by the compose spec (postgres:18 images changed their default to `<volume>/<major>/docker`); probes/seed target `<volume>/data`. Seed is atomic: uninitialized → clear `data`/`data.tmp` → `pg_basebackup -D data.tmp` → `mv data.tmp data`, so an interrupted seed never strands a half-copied PGDATA | MySQL/MariaDB datadir is the image default `/var/lib/mysql` (initdb by entrypoint; seed via `configureStandby` SQL, no file-level copy) |
| Credentials | Short-lived `0600` env-file for basebackup | Short-lived `0600` defaults file over exec stdin (never `-p` / never `MYSQL_PWD`) |
| Standby SQL | not used (config-file primary_conninfo) | Optional `configureStandby` hook — replication channel setup is not user-data mutation |
| Promote | Operator switchover, DR route, or TurboPanel-gated auto-failover after fence (Orchestrator designated recover-to, else `managed.promote` fallback) | same (`STOP REPLICA` / `STOP SLAVE` + clear read_only). **MySQL-family planned switchover:** fence `managed.lifecycle` stop with `captureSwitchoverGtid` quiesces the old primary (`read_only` / `super_read_only`), records `gtid_current_pos` (MariaDB) or `gtid_executed` (MySQL), then stops; `managed.promote` (or Orchestrator recover fallback) waits with `MASTER_GTID_WAIT` / `WAIT_FOR_EXECUTED_GTID_SET` on the target before clearing read-only and promoting. Timeout aborts promotion; the control plane may `reactivateAfterSwitchoverAbort` the old primary only with `switchoverAbortPromoteSafe: true` and without `switchoverTargetPromoteCompleted` / a `switchover_promote:promote_started` error from the target — the daemon refuses reactivation otherwise and keeps the demoted marker until compose start and SQL reactivation succeed. |
| Follow (repoint) | After promotion, `repoint` with `ensureSlots` on the new primary first (`ensureSlots` / `createPhysicalSlotSql`, refuses if the member is a standby), then `repoint` on each other healthy replica: `isStandby` must be true, `followPrimary` rewrites `primary_conninfo`, reload, restart WAL receiver, then poll `readHealth("standby")` until `streaming` (3 s, 90 s) | Same order: slots no-op on the new primary; `followPrimary` is `STOP` + `CHANGE SOURCE/MASTER` host+port only (no dump) + `START`; refuses a non-standby; streaming verified the same way |
| Health | `streaming` requires active WAL receiver; `lagSeconds` is 0 when replay has caught the primary's last reported WAL end (an idle primary must not make a caught-up replica look lagged) | `streaming` requires both IO + SQL threads running. `readHealth` (the same poll `managed-health-request` / apply / lifecycle use) restarts stopped IO/SQL threads when the primary is reachable and the last error is a connection error — never an applier/GTID error |

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
  old primary can still be fenced. **Whole-host loss is not this probe's job**
  (a dead host sends nothing): the control plane detects it itself from the
  daemon connection going silent, confirmed by the replicas
  (`turbopanel/src/features/managed/ha-host-loss-sweep.ts`). What the daemon
  adds for that path is the **boot hold** below, so a primary that returns
  after a power cut cannot serve writes unchecked.
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
    suppresses 10 min + 30 s from THEN (a **successful** `promote` or
    `failover` only 1 min + 30 s: those report success once the new primary is
    writable, so a primary killed minutes after a switchover is a real
    failure, not something to wave off for another ten); only the command
    that owns the current marker refreshes it (concurrent commands: the last
    to finish never overwrites a newer marker);
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

## Boot hold after an unclean host restart

While a host is off the control plane may promote a replica, but Docker
restarts engines (`restart: unless-stopped`) before this daemon runs, so a
stale primary can accept writes again within seconds of boot.

- **Detect** (`host-boot.ts`): `<stateDir>/system/host-boot.json` holds the
  kernel `boot_id` of the last run, plus a `cleanShutdownAt` stamp written on
  SIGTERM/SIGINT (`entry/run.ts`). A different `boot_id` with no stamp is an
  *unclean* boot (power cut, kernel panic, `reboot -f`); with the stamp it is a
  planned reboot; the same `boot_id` is a daemon restart. No boot id or no
  record means no information: no hold. Wall-clock time is never compared.
- **Hold** (`boot-hold.ts`, first thing in `runDaemon`): on an unclean boot,
  every primary in `ha-member.json` with at least one peer gets a HELD `stop`
  intent marker (so the dead-primary probe reads the stop as intended), a
  `managed/<id>/boot-hold.json`, and `docker compose -p <id> stop`. Standalone
  databases and replicas are never held unless they carry a demoted marker
  (a replaced primary counts as replaced on boot and is never released).
- **Report** (`instance/boot-hold-reporter.ts`, every 60 s while a hold exists
  and the socket is attached): `managed-ha-event` with `detector: 'boot-hold'`
  and `evidence { reason, heldAt, engineStopped }`. It is never a failover
  request. The control plane answers a still-current primary with
  `managed.lifecycle start`; a successful start (or restart/apply/promote)
  releases the held marker, and the hold file goes with it
  (`listActiveBootHolds`). A primary the control plane replaced is left
  stopped (`needs_resync`). A demoted marker is the same as replaced: local
  release must not start that engine.
- **No answer possible**: a control plane without `managed-ha-boot-hold-v1`
  gets nothing; the daemon releases the hold itself and starts the engine (the
  behaviour before this feature) unless a demoted marker is present. A control
  plane that is merely unreachable leaves the hold on: that fails closed on
  purpose.
- Tests: `host-boot.test.ts`, `boot-hold.test.ts`,
  `../instance/boot-hold-reporter.test.ts`, `../entry/run.test.ts`.

## Demoted member fence

After failover or switchover the old primary is stopped and must stay stopped
(or read-only) until it is re-added as a replica. The control plane sends
`demoted: true` on that fence `managed.lifecycle` stop. In order, so a crash
between steps is always safe:

1. **Marker** `<stateDir>/managed/<managedId>/demoted.json` (member id +
   timestamp + engine, 0600, atomic). It drives everything below. It fences
   the whole cluster on this host whatever member id it or the request names
   (empty, equal or different): there is one data volume per cluster per host.
2. **On-disk fence** (`demoted-fence-volume.ts`), verified after writing:
   Postgres `standby.signal` on the data volume; MySQL / MariaDB a delimited
   `# BEGIN/END turbopanel demoted fence` block (`read_only=1`, plus
   `super_read_only=1` on MySQL) appended to the mounted `config/my.cnf`
   (the file the engine reads as `/etc/mysql/conf.d/zz-turbopanel.cnf`). The
   file is root-owned after apply, so a root helper container reads it and
   replaces it atomically (copy keeps owner/mode, then rename). A hand
   `docker start` re-resolves the bind mount and comes up read-only.
3. Best-effort SQL read-only (`fenced-member-enforce.ts`), then
   `compose stop`. A failing step never skips a later one or the stop; the
   command then fails with "demoted fence is incomplete".

The 5 s guard (`demoted-guard.ts`, from `runDaemon`, under
`tryWithManagedLifecycleLock`) re-plants the on-disk fence each tick, then
probes: a standby / read-only engine is left running; a writable one (or one
it cannot probe) gets SQL read-only, a held stop intent, and up to three
stop passes (`compose stop`, then `docker stop`/`kill` by id; when every
listing fails, `compose kill` and stop/kill by container name). Still
writable: an error log every tick, `compose kill` + kill by id and name, and
`unsafe` on the marker (marker only; not on the wire yet). Bookkeeping
failures (plant, intent, marker patches) are logged and never skip a stop.
MariaDB `read_only` does not bind READ ONLY ADMIN (root), so a running fenced
MariaDB counts as writable unless it is configured as a replica with
`read_only` on (a re-seed in progress). Postgres SQL read-only cannot bind a
superuser either; the container stop is the real fence.

`managed.lifecycle` start/restart refuses while the marker is present (except
switchover-abort reactivation). A standby `managed.apply` for a marked member
returns `needs_resync` unless it carries `forceResync` (the fence's own
`standby.signal` would otherwise make diverged data look like a standby). Clearing goes through ONE helper,
`clearManagedDemotionArtifacts`: on-disk fence removed and verified gone
first, marker removed last, any failure throws and keeps the marker. Callers:
replica `managed.apply` that reached `ready` (inside apply's lock),
`managed.promote` (takes the lifecycle lock when a marker exists, and Postgres
promote resets the fence's `default_transaction_read_only`), switchover-abort
reactivation (takes the lifecycle lock), and `managed.destroy`. The guard never
starts anything and never deletes data.
Tests: `demoted-marker.test.ts`, `demoted-fence-volume.test.ts`,
`fenced-member-enforce.test.ts`, `demoted-guard.test.ts`, `lifecycle.test.ts`,
`promote.test.ts`.
