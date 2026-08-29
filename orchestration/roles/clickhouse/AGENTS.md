# ClickHouse role (`clickhouse`, self-hosted analytics) — AGENTS.md

Ansible role for TurboPanel orchestration. Shared conventions: `../../AGENTS.md`.

The `clickhouse` Ansible role is **config-only**: user/group provisioning,
admin + app secret generation, `config.json`, and the `config.xml`/`users.xml`
`config.d`/`users.d` overlays. Container lifecycle (create/start/readiness) is
owned by the `system-compose` role above — see **System services Compose
stack** for the Compose service definition, labels, and the
`turbopanel-system-stack.service` unit. Post-ready SQL bootstrap + disabled
system-log `DROP TABLE` cleanup live in `roles/clickhouse/tasks/bootstrap.yml`,
`include_role`'d from `system-compose` once the analytics container is up and
ready (they need `docker exec` against a running container, so they cannot run
from the trimmed config-only role itself).

Instance-side ClickHouse metrics store + schema/query contract: `../../turbopanel/src/daemon/metrics/AGENTS.md`.
There is **no** `container_logs` table. `tasks/bootstrap.yml` runs an
idempotent `DROP TABLE IF EXISTS turbopanel_metrics.container_logs` so
existing installs stop retaining tenant output on the next converge.

| Path / resource                                                                          | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker image `clickhouse/clickhouse-server:{{ clickhouse_version }}`                     | ClickHouse server (no vendored binaries); referenced by the `analytics` service in the shared `turbopanel-system` Compose file (`system-compose` role)                                                                                                                                                                                                                                                                                                          |
| Container `turbopanel-analytics` / volume `turbopanel-analytics` on network `turbopanel` | Running server + persistent MergeTree data (in-container `/var/lib/clickhouse`)                                                                                                                                                                                                                                                                                                                                                                                 |
| `/etc/turbopanel/clickhouse/`                                                            | `config.xml` (`config.d` overlay), `users.xml` (`users.d` overlay — bootstrap `default` admin only), `config.json` (host/port/database/user + password-file paths — no secret values), `.clickhouse_admin_pass` + `.clickhouse_app_pass` (mode `0600`). The two XML overlays are bind-mounted read-only into the image's `config.d`/`users.d` by the Compose file (base image config preserved). The overlays are owned by `clickhouse_container_uid`:`clickhouse_container_gid` (`9994:9994` in production, backed by **`tpmetrics`**; the dev uid:gid in co-located dev) with group **`tp`** — **not** `root` — so the container process can actually read them (mode `0640` keeps `users.xml`, which holds the admin password, non-world-readable); the secret/password files and `config.json` stay owned for root/dev + the **`tp`** group as `instance-launch` needs |
| `/var/log/turbopanel/clickhouse/`                                                        | server logs (bind-mounted to the container's `/var/log/clickhouse-server`)                                                                                                                                                                                                                                                                                                                                                                                      |

The `config.d` overlay carries **idle-CPU tuning** for an otherwise-idle
single-server box: slow async-metrics cadence
(`asynchronous_metrics_update_period_s`/`asynchronous_heavy_metrics_update_period_s`
= 120); shrunken always-awake background pools
(`background_pool_size`/`background_schedule_pool_size`/`background_common_pool_size`
= 2, `background_merges_mutations_concurrency_ratio` = 1,
`merge_tree/merge_selecting_sleep_ms` = 30000); global thread-pool caps
(`max_thread_pool_size` = 64, `max_thread_pool_free_size` = 8,
`thread_pool_queue_size` = 64); shrunken eager-spawn schedule/move/fetch pools
unused by the metrics-only workload
(`background_message_broker_schedule_pool_size` /
`background_distributed_schedule_pool_size` /
`background_buffer_flush_schedule_pool_size` / `background_move_pool_size` /
`background_fetches_pool_size` = 1); and removal of the ClickHouse 26.x system
`*_log` MergeTree set — including `aggregated_zookeeper_log` alongside
`zookeeper_log` / `zookeeper_connection_log` (each log table adds flush + merge
scheduler threads). Shrinking the merge pool also requires lowering the
MergeTree free-entry gates (`number_of_free_entries_in_pool_to_execute_mutation`
/ `_to_lower_max_size_of_merge` / `_to_execute_optimize_entire_partition` = 1) —
ClickHouse 26.x refuses to start when any of those defaults (20 / 8 / 25) exceed
`background_pool_size * background_merges_mutations_concurrency_ratio` (keep
`background_pool_size` and the ratio at 2/1). Disabling a system log in config
stops new writes but does not drop an already-materialized table:
`roles/clickhouse/tasks/bootstrap.yml` (run from `system-compose` once the
analytics container is ready) does an idempotent post-ready admin cleanup that
`DROP TABLE IF EXISTS` every `*_log` removed in `config.xml.j2` (including
`aggregated_zookeeper_log`). `ansible.test.ts` asserts the DROP list stays
aligned with the config remove list.

**Low-footprint resource caps** (role defaults — `ansible.test.ts` pin
ceilings): `mark_cache_size` **64 MiB**, `max_server_memory_usage` **512 MiB**.
Container runtime caps are rendered into the shared `turbopanel-system`
Compose file by `system-compose`: `mem_limit` uses
`clickhouse_container_memory_bytes` (**768 MiB**) and `cpus` uses
`clickhouse_container_cpus` (**"1.0"**) — see
`roles/system-compose/templates/docker-compose.yml.j2`.

Primary write batching for ~1 sample/min traffic lives in the instance
`ClickHouseServerMetricsStore` (row count + max age). The `users.d` **default**
profile still enables secondary **async insert** coalescing (`async_insert=1`,
`wait_for_async_insert=0`, `async_insert_busy_timeout_ms=60000`,
`async_insert_max_data_size=1000000`) — not the main part-batching path.
`wait_for_async_insert=0` keeps the fire-and-forget write path non-blocking.

HTTP interface is published **loopback-only on `127.0.0.1:8123`** (native TCP
`9000` is **not** published — it stays internal to the container/network;
bootstrap SQL runs via `docker exec … clickhouse-client` on the container's
loopback). Default anonymous access is disabled. **Separate secrets:**
`.clickhouse_admin_pass` authenticates the `default` admin user in the `users.d`
overlay (bootstrap DDL / `access_management`); `.clickhouse_app_pass`
authenticates the least-privilege `turbopanel_app` user, which is created and
granted **only via SQL** (not declared in `users.xml`, default `HOST ANY`) and
scoped to database `turbopanel_metrics`.

**`turbopanel_app` grants (SQL bootstrap):** `SELECT`, `INSERT`, `CREATE TABLE`,
`CREATE VIEW`, `ALTER`, and `SHOW` on `turbopanel_metrics.*` — enough for
instance-owned `ensureSchema()` (`CREATE TABLE IF NOT EXISTS` plus
`MODIFY SETTING` / `MODIFY TTL`) and metrics reads/writes. No `DROP` or
`TRUNCATE`. The wildcard is `<database>.*`, not per-table, so
instance-owned tables added later are covered with no playbook change.

**Converge wiring:** co-located dev installs ClickHouse via the dev-repo
`<dev checkout>/orchestration/dev-converge-manifest.json` (role `clickhouse`,
after `postgres`/`redis`/`rabbitmq`, then `system-compose` brings the Compose
stack up before `tabix`/`mailpit`/`instance-user`) — same pattern as those data
services (not a discrete `setup.ts` step). Managed daemon-only hosts omit it
(`daemon-converge.yml`); use standalone `playbooks/clickhouse-setup.yml` (which
also runs `system-compose` after the config-only `clickhouse` role) /
`CLICKHOUSE_VERSION` (`26.5.5.8`) when a control-plane host needs the Deno
metrics store without the full dev overlay.

**instance-launch env:** when `.clickhouse_app_pass` exists, injects
`TURBOPANEL_CLICKHOUSE_URL` / `DATABASE` / `USER` into `runtime.env` and
`TURBOPANEL_CLICKHOUSE_PASSWORD` (app password only) into `runtime.dev-vars`.
The Deno/compiled `turbopanel-instance.service` loads `runtime.env` then
`runtime.dev-vars` via `EnvironmentFile=` so the process sees the full
ClickHouse + metrics config. Default:
`TURBOPANEL_SERVER_METRICS_RETENTION_DAYS=90` (metrics are always on — no
enable/disable env). Schema/query contract: **`../turbopanel/AGENTS.md`** (Server
metrics — ClickHouse).

**Workers runtime dev vars:** `instance-workers.dev-vars.j2` injects
`TURBOPANEL_ANALYTICS_ENGINE_API_TOKEN` when
`/etc/turbopanel/instance/.analytics_engine_api_token` exists (mode `0600`,
operator-provided Cloudflare **Account Analytics Read** token). Writes use the
wrangler `SERVER_METRICS` binding; chart queries need this token for the AE SQL
API. `CLOUDFLARE_ACCOUNT_ID` is already in `wrangler.jsonc` vars.

**Tabix dev GUI (dev-only):** the `tabix` Ansible role runs a dev-only container
`turbopanel-dev-tablix` (unit `turbopanel-tabix.service`) — a static browser
client for the ClickHouse metrics DB, opened at **`http://127.0.0.1:8125`**. The
upstream `spoonest/clickhouse-tabix-web-client` image is **amd64-only** (crashes
with `exec format error` on arm64), so the role extracts its `/var/www/html`
assets via `docker create` + `docker cp` (no exec) into
`/var/lib/turbopanel/tabix/html`, injects ClickHouse connection defaults into
`index.html` (same `window.global_tabix_default_settings` contract as the
upstream `start.sh`), and serves them with multi-arch
**`nginxinc/nginx-unprivileged:alpine`** (`127.0.0.1:8125` → container `8080`).
Prefill uses `.clickhouse_app_pass` → **`turbopanel_app`** against
**`http://127.0.0.1:8123`** / DB **`turbopanel_metrics`**. It **must** use the
app user: the `default` admin is `<networks>`-restricted to `127.0.0.1`/`::1`
(docker-exec only). Cross-origin browser access is enabled via the **dev-gated
`http_options_response` CORS block** in the ClickHouse `config.d` overlay (only
rendered when `turbopanel_dev_user` is set, so managed/prod config is
byte-for-byte unchanged) plus a `CH_PARAMS` value of
`add_http_cors_header=1&database={{ clickhouse_database }}` carried on every
Tabix request. Loopback-only; **not** routed through Caddy; runs as the
**current dev `--user`**. Installed via the dev-repo
`dev-converge-manifest.json` only (after `clickhouse`, so the app password
exists) — omitted from `daemon-converge.yml`, so daemon-only hosts get no GUI.

