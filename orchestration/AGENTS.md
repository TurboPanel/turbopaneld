# Orchestration — AGENTS.md

Ansible roles and playbooks under `orchestration/`. Root context: `../AGENTS.md`. Cross-repo `../<repo>/…` links are relative to the repo root.

### Time sync (`time-sync`)

First-party role (no Galaxy deps) that installs/enables `systemd-timesyncd`,
templates `/etc/systemd/timesyncd.conf`, toggles NTP via `timedatectl set-ntp`,
and optionally sets timezone via `timedatectl set-timezone` when
`turbopanel_timezone` is non-empty. Defaults: Debian NTP pool +
`time.cloudflare.com` fallback; `turbopanel_ntp_enabled: true`; empty timezone
(leave unchanged). Wired into `playbooks/daemon-converge.yml` so every managed
converge re-ensures NTP. Command-driven apply playbook:
`playbooks/time-sync-apply.yml` (invoked by daemon `server.timezone.set` /
`server.ntp.set` via `runTimeSyncApply`). Extra-vars are passed as **one JSON
`-e` object** so `turbopanel_ntp_servers` / `turbopanel_ntp_fallback_servers`
stay lists and `turbopanel_ntp_enabled` stays a boolean (`key=value` would
stringify them). `timesyncd.conf` is `root:<systemd-timesync|root>` mode
`0640` so the `User=systemd-timesync` service can read it; the restart handler
  is gated on `turbopanel_ntp_enabled | bool` so a disable + config change does
  not restart/start timesyncd after `timedatectl set-ntp false`.

### WireGuard (`wireguard`)

First-party role (no Galaxy deps) that installs `wireguard-tools`, templates
`/etc/wireguard/<interface>.conf` at mode **`0600`** with **`no_log: true`**, and
enables `wg-quick@<interface>` via systemd. The interface **private key never
travels through Ansible extra-vars** — the template reads
`wireguard_private_key_file` via `lookup('ansible.builtin.file', …)`.
Command-driven apply playbook: `playbooks/wireguard-apply.yml` (invoked by daemon
`server.wireguard.apply` via `runWireguardApply`). Extra-vars are passed as **one
JSON `-e` object** so `wireguard_peers` stays a list and
`wireguard_configure` / `wireguard_ip_forward` / `wireguard_manage_forwarding`
stay booleans. Set `wireguard_configure: false` for a package-only run (tools
install without bouncing the tunnel). The restart handler is gated on
`wireguard_configure | bool`. Peer `AllowedIPs` is a multi-CIDR list
(`join(', ')`) so site-to-site gateways can advertise datacenter LAN CIDRs
alongside host routes.

**Forwarding sysctls are host-wide, not per-interface** —
`net.ipv4.ip_forward` / `net.ipv6.conf.all.forwarding` apply to the whole
host, but a single host can run multiple managed WireGuard interfaces (one
per VPN) with independent gateway roles. The role itself only reconciles
whatever single boolean it is given (`wireguard_ip_forward`) and only when
`wireguard_manage_forwarding | bool` is true — it has no cross-interface
knowledge. The daemon (`src/instance/commands/wireguard.ts`) owns the
cross-interface union: it persists a per-interface forwarding requirement in
`forwarding-state.json` under the WireGuard state dir, recomputes the `OR`
across every interface it has ever applied on this host on every
`handleWireguardApply` call, and passes that union (never just the current
call's own interface) as `wireguard_ip_forward` alongside
`wireguard_manage_forwarding: true`. This is why demoting one gateway
interface correctly leaves the sysctl **enabled** when a sibling VPN
interface on the same host is still a gateway, and correctly disables it once
none are. The stamp-match fast path in `handleWireguardApply` additionally
checks the interface's *recorded* forwarding requirement (not just its
WireGuard config stamp) before skipping, so a stale/missing forwarding-state
entry cannot leave the host sysctl wrong indefinitely.
`ensureWireguardTools()`'s bootstrap/tools-only call omits both
`enableIpForwarding` and `manageForwarding` (defaulting to `false` in the
extra-vars builder) so a call with no host-wide interface knowledge never
resets the current sysctl state. The role writes both sysctls via
`ansible.posix.sysctl` to `/etc/sysctl.d/99-turbopanel-wireguard.conf`.
**No NAT/masquerade is configured** — the operator must ensure the
datacenter LAN has a return route to the gateway for site traffic.
`wireguard-tools` is also listed in `daemon-prereqs` on managed hosts.
**Not** wired into `daemon-converge.yml` (command-driven only, like
`time-sync-apply`).

### ProxySQL (`proxysql`)

Shared **managed-database ingress** on every host that will run managed
engines. Host prerequisites only — **not** a full stack bring-up of compose
content. Meta-depends on the `docker` role. Standalone playbook:
`playbooks/proxysql-setup.yml` (invoked by daemon `runProxySqlSetup` after
`ensureGalaxyDockerRole`).

**Division of labour**

| Owner | Responsibility |
| --- | --- |
| Ansible (`proxysql` role) | Config dir `0750` root:`turbopanel_group`, `tls/` subdir, state data dir + first-run alpine `chown` to `999:999`, one-shot `admin.cnf` mode `0600`, initial static `proxysql.cnf` **only when absent** (`force: no`), `wait-ready.sh`, `turbopanel-proxysql-stack.service`, ensure docker network `turbopanel-managed` |
| Daemon (`src/managed/proxysql.ts`, `managed.ingress.reconcile`) | Write/update `docker-compose.yml`, regenerate full durable `proxysql.cnf` (static listeners + users/servers/rules), materialize TLS PEMs under `tls/`, admin runtime apply, compose up/restart |
| Systemd unit | `Type=oneshot` `RemainAfterExit`; create network if missing; **if compose file exists** → `docker compose up -d` + wait-ready; **if compose not yet written** → no-op success (pre-reconcile hosts stay healthy after converge) |

**Paths**

| Path | Mode / owner | Purpose |
| --- | --- | --- |
| `/etc/turbopanel/proxysql/` | `0750` root:group | Config root (`proxysql_config_dir`) |
| `…/tls/` | `0750` root:group | Org-CA leaf + CA for frontend TLS (daemon writes PEMs) |
| `…/admin.cnf` | `0600` root:group | mysql-client-style `[client]` admin user/password (like postgres `.pgpass`) |
| `…/proxysql.cnf` | `0640` root:group | Cold-start config (Ansible seeds static globals once; daemon owns thereafter) |
| `…/wait-ready.sh` | `0750` root:root | Probe admin `127.0.0.1:6032` after compose up |
| `…/docker-compose.yml` | daemon `0640` | **Not** written by Ansible |
| `/var/lib/turbopanel/proxysql/` | pre-owned `999:999` | Host-side data tree marker / optional bind target |
| Network `turbopanel-managed` | bridge | Engines + ProxySQL (never tenant `turbopanel-ingress`) |
| Unit `turbopanel-proxysql-stack.service` | `0640` | Reboot durability once compose exists |

**Image pin:** `proxysql_image: proxysql/proxysql:3.0.2`. Must not be loosened
without reviewing **GHSA-58ww-865x-grpr** (pre-auth heap overflow on the
first-packet path affecting ProxySQL **3.0.x** listeners, May 2026 advisory).
Keep in step with daemon `PROXYSQL_IMAGE` in `src/managed/proxysql.ts`.

**Ports (defaults):** admin `6032` (loopback), pgsql frontend `5432`, mysql
frontend `3306`. These published frontend ports are reserved against tenant
raw TCP hostings (`PROXYSQL_RESERVED_PUBLISHED_PORTS`).

**Installer vocabulary:** component/status token `proxysql` → **ingress** (see
`src/orchestration/presentation.ts`).

### Web-service user (`web-service-user`)

Tenant/daemon-host web servers (nginx, Apache, OpenLiteSpeed, LiteSpeed enterprise) run under dedicated **99xx** system accounts — distinct from control-plane **tpcaddy(9993)**. The `web-service-user` role provisions **only** the group + system user (no package install). **Not** wired into `daemon-converge.yml`; traditional-web apply playbooks `include_role` it on demand when a traditional-web site is deployed, then vendor the matching engine role.

| Service key | User / group | uid / gid |
| ----------- | ------------ | --------- |
| `nginx` | `tpnginx` | 9992 |
| `apache` | `tpapache` | 9991 |
| `openlitespeed` | `tpols` | 9990 |
| `litespeed` | `tplsws` | 9989 (reserved) |

Each account uses primary group matching its username, `shell: /usr/sbin/nologin`, `system: true`, `create_home: false`, and supplementary membership in **tp** when that group exists (getent-safe).

```yaml
- name: Provision nginx service identity
  ansible.builtin.include_role:
    name: web-service-user
  vars:
    web_service_key: nginx
```

Override the map by passing `web_service_user`, `web_service_uid`, `web_service_group`, and `web_service_gid` directly instead of `web_service_key`. Canonical map: `roles/web-service-user/defaults/main.yml` → `web_service_user_map`.

**All three engines are vendored** under
`{{ turbopanel_vendor_dir }}/<tool>/<version>/` with a `current` symlink
(same layout as `caddy`/`deno`/`node`/`redis`) — **never** `apt install
nginx|apache2|openlitespeed`. Apply playbooks:

| Engine | Playbook | Role | Systemd unit |
| ------ | -------- | ---- | ------------ |
| nginx | `traditional-web-apply.yml` | `nginx` | `turbopanel-nginx` |
| apache | `traditional-web-apache-apply.yml` | `apache` (+ `php-fpm` when PHP) | `turbopanel-apache` (+ `turbopanel-php-fpm`) |
| openlitespeed | `traditional-web-openlitespeed-apply.yml` | `openlitespeed` | `turbopanel-openlitespeed` |

Site fragments live under `/etc/turbopanel/{nginx,apache,openlitespeed}/sites/`
(and php-fpm pools under `/etc/turbopanel/php/pools/`) — daemon TypeScript owns
the file contents (see `../src/deploy/traditional-web.ts` /
`../src/deploy/AGENTS.md`). Leftover distro `nginx` / `apache2` / `php*-fpm`
units are stopped/disabled when the vendor roles run so they cannot steal
ports or config.

### nginx (`nginx`)

Vendored — **never** a distro package. The role downloads the pinned
**nginx.org** Debian `.deb` (`nginx_deb_version`, bookworm pool — runs on
Debian 13 too), extracts the binary with `dpkg-deb -x` (same pattern as the
`redis` role / packages.redis.io), and installs
`{{ turbopanel_vendor_dir }}/nginx/<version>/sbin/nginx` + `current`. Main
config is templated to `/etc/turbopanel/nginx/nginx.conf` and
`Include`s `/etc/turbopanel/nginx/sites/*.conf`. Temp paths / logs / pidfile
are under `/var/lib|/var/log|/run/turbopanel/nginx/`. Driven by
**`turbopanel-nginx.service`** (runs as `tpnginx`; high-port vhosts only —
hosting Caddy owns `:80`/`:443`).

### Apache (`apache`)

Vendored — **never** a distro package. The role downloads pinned ASF
**httpd** + **APR** + **APR-util** source tarballs, builds them with
`--prefix={{ turbopanel_vendor_dir }}/apache/<version>` (compile-time apt
deps only: `build-essential`, `libssl-dev`, `libpcre2-dev`, … — not
`apache2`), and points `current` at that tree. Main config is
`/etc/turbopanel/apache/httpd.conf` with `IncludeOptional …/sites/*.conf`
and loads `mod_proxy` + `mod_proxy_fcgi` for PHP. Driven by
**`turbopanel-apache.service`** (master starts as root and drops to
`tpapache` via `User`/`Group` in `httpd.conf`). Main config includes a
bootstrap `Listen 127.0.0.1:19080` so httpd can start before any site
fragment exists (Apache refuses zero-Listen configs). ASF httpd has **no**
mod_php — PHP is the sibling `php-fpm` role below.

### php-fpm (`php-fpm`)

Vendored — **never** a distro package. Official PHP source has no relocatable
prebuilt Linux binaries, so the role **compiles** the pinned release
(`php_fpm_version`, series `php_fpm_series`) with `--enable-fpm` into
`{{ turbopanel_vendor_dir }}/php/<version>/` plus `current` and
`<series>` symlinks (idempotent short-circuit when `sbin/php-fpm` already
exists). Compile-time apt deps only (`build-essential`, `libssl-dev`,
`libxml2-dev`, … — not `php-fpm` / `libapache2-mod-php`). FHS layout:

| Path | Owner | Mode | Purpose |
| ---- | ----- | ---- | ------- |
| `/etc/turbopanel/php/` | `root:tpapache` | `0750` | `php.ini`, `php-fpm.conf`, `conf.d/`, per-site `pools/*.conf` |
| `/var/log/turbopanel/php/` | `tpapache:tpapache` | `0750` | `php-fpm.log` / `php-error.log` |
| `/run/turbopanel/php/` | `tpapache:tpapache` | `0750` | pidfile + unix sockets |

Driven by **`turbopanel-php-fpm.service`**. Workers run as **tpapache** (same
identity as Apache — provisioned by `web-service-user` before this role).
`traditional-web-apache-apply` includes this role only when the daemon passes
`turbopanel_php_fpm_install: true` (Apache sites with `web.php` hints).
Daemon TypeScript writes per-site pools and reloads the unit before Apache
so `proxy:unix:…|fcgi://localhost/` sockets exist. One series per host for
now (multi-version side-by-side is a future seam).

### OpenLiteSpeed (`openlitespeed`)

Vendored — **never** a distro package. The role downloads the official
precompiled binary tarball from the `litespeedtech/openlitespeed` GitHub
release matching `openlitespeed_release_tag`, extracts it under
`{{ turbopanel_vendor_dir }}/openlitespeed/<version>/` with a `current`
symlink (same layout as `caddy`/`deno`/`node`), and prunes everything but the
core HTTP server: the bundled admin console, docs, and `example/` vhost are
removed. OpenLiteSpeed determines its own home directory relative to `bin/`
at startup (it is inherently relocatable), so the pruned tarball structure —
not just the `openlitespeed` binary — must stay intact under the vendor path.
A `bin/litespeed → bin/openlitespeed` symlink exists solely so the bundled
`lswsctrl` control script (which looks for a binary literally named
`litespeed`) keeps working if invoked manually; the daemon itself drives the
server through the templated **`turbopanel-openlitespeed.service`** systemd
unit (`systemctl start|stop|restart`), not `lswsctrl`.

The role also provisions FHS-compliant config/log/state directories (mirroring
`instance-certs`-style ownership, not the vendor tree itself):

| Path | Owner | Mode | Purpose |
| ---- | ----- | ---- | ------- |
| `/etc/turbopanel/openlitespeed/` | `root:tpols` | `0750` | `httpd_config.conf` (daemon-owned, regenerated whole on every apply — no `sites-enabled` convention) + `mime.properties` + per-site fragments (`sites/`) + per-vhost `vhconf.conf` (`vhosts/<name>/`) |
| `/var/log/turbopanel/openlitespeed/` | `tpols:tpols` | `0750` | `error.log` / `access.log` |
| `/var/lib/turbopanel/openlitespeed/` | `tpols:tpols` | `0750` | PID file (`lshttpd.pid`), `swap/` (`swappingDir`) |
| `{{ turbopanel_vendor_dir }}/openlitespeed/<version>/{cachedata,autoupdate,tmp,tmp/ocspcache}` | `tpols:tpols` | `0750` | OLS's own writable runtime dirs, kept inside the vendored tree since the binary resolves paths relative to its own `bin/` |

Identity comes from `web-service-user` (`tpols`, uid/gid **9990** — see the
table above); the **`traditional-web-openlitespeed-apply`** playbook
`include_role`s `web-service-user` (key `openlitespeed`) before `openlitespeed`
itself, mirroring `traditional-web-apache-apply`. Daemon-side config
generation (per-site `virtualHost`/`listener` fragments aggregated into the
single `httpd_config.conf`, `vhconf.conf` per vhost) lives in
`../src/deploy/traditional-web.ts` — see `../src/deploy/AGENTS.md`.

---

### System services Compose stack (`system-compose`)

Postgres, RabbitMQ, and ClickHouse run as **one Docker Compose project**,
**`turbopanel-system`** (`docker-compose.yml` at
`/etc/turbopanel/system/docker-compose.yml`, services `database` / `queue` /
`analytics`), brought up by a single `Type=oneshot` systemd unit —
**`turbopanel-system-stack.service`** — instead of three independent
`docker run` containers each with its own unit. This replaced the older
per-service `turbopanel-postgres.service` / `turbopanel-rabbitmq.service` /
`turbopanel-clickhouse.service` units and their `*-wrapper-start.sh` scripts.

**Role split:** the `postgres` / `rabbitmq` / `clickhouse` roles are now
**config-only** — user/group provisioning, secret generation
(`.pgpass` / `.rabbitmq_pass` / `.clickhouse_admin_pass` +
`.clickhouse_app_pass`), `config.json`, and (for ClickHouse) the
`config.xml`/`users.xml` `config.d`/`users.d` overlays. None of them run
`docker`/`docker inspect`/`docker run`, install a per-service systemd unit, or
install a wrapper-start script anymore. The **`system-compose`** role (meta
`docker` dependency) runs *after* whichever of those three roles ran in the
same play and:

1. Slurps each service's password file directly (`.pgpass` / `.rabbitmq_pass`
   / `.clickhouse_admin_pass`) — it does not depend on facts set by the prior
   roles, so it stays idempotent/self-sufficient across separate playbook runs.
2. A service block only renders when its secret file exists, so the role
   degrades gracefully when only a subset of the three roles ran in this play
   (see the standalone `postgres-setup.yml` / `rabbitmq-setup.yml` /
   `clickhouse-setup.yml` playbooks, which each add `system-compose` after
   their one role). `queue` / `analytics` are additionally omitted on Workers
   runtime (`turbopanel_instance_runtime == 'workers'` — Mailgun / Cloudflare
   Analytics Engine replace them).
3. Ensures the `turbopanel` Docker network + the active named volumes exist,
   pre-owns volume data directories on the very first run (before Compose
   takes ownership), and force-removes any pre-existing non-Compose container
   with a conflicting name (migration path from the old per-service `docker
   run` containers — container names are unchanged: `turbopanel-database` /
   `turbopanel-queue` / `turbopanel-analytics`).
4. Templates `docker-compose.yml` (mode `0640`, owner `root:{{
   turbopanel_group }}`) and a `wait-ready.sh` readiness script, installs
   `turbopanel-system-stack.service`, stops/disables the three legacy
   per-service units, and starts the new unit.
5. `docker compose -p turbopanel-system … up -d --remove-orphans` — the
   `--remove-orphans` flag is what tears down `queue`/`analytics` containers
   when a converge switches to Workers runtime (no per-runtime "stop and
   disable" systemd task needed in `instance-launch`).
6. Restarts (targeted `docker restart`, not `--force-recreate`) just the
   `queue` or `analytics` container when the `rabbitmq`/`clickhouse` roles'
   config-overlay `template` tasks reported `changed` earlier in the play
   (`docker compose up -d` alone does not notice a bind-mounted file's
   *content* changing), then re-waits for readiness on that container.
7. Once ClickHouse is up (first run or after a config-triggered restart),
   `include_role: clickhouse, tasks_from: bootstrap` runs the post-ready SQL
   bootstrap (see below) — it needs a running container, so it cannot happen
   inside the trimmed `clickhouse` role itself.

**Labels:** every service in the Compose file carries **only**
`com.turbopanel.system.component: <database|queue|analytics>` and
`turbopanel.role: system` — never `com.turbopanel.service`, `traefik.enable`, or
`com.turbopanel.raw-port` (those identify *tenant* deploy containers; see
`../src/deploy/system-component.ts` / `../src/deploy/labels.ts`).

| Path / resource                                                                | Purpose                                                                                                                                                                                       |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/etc/turbopanel/system/docker-compose.yml`                                     | The `turbopanel-system` Compose project (services `database`/`queue`/`analytics`)                                                                                                              |
| `/etc/turbopanel/system/wait-ready.sh`                                          | Readiness script (`pg_isready` / `rabbitmq-diagnostics -q ping` / `curl .../ping` via `docker exec`), run as a second `ExecStart` so the oneshot unit blocks until services actually answer     |
| `turbopanel-system-stack.service`                                               | `Type=oneshot`, `RemainAfterExit=yes`; `ExecStart` = compose `up -d --remove-orphans` then `wait-ready.sh`; `ExecStop` = compose `down`                                                        |
| Containers `turbopanel-database` / `turbopanel-queue` / `turbopanel-analytics`  | Unchanged names/volumes from the old per-service containers — Compose adopts them (old non-Compose containers with the same name are force-removed on first run)                              |

Dependent units (`turbopanel-instance.service`, `turbopanel-dbstudio.service`,
`turbopanel-mailer.service`, `turbopanel-tabix.service`) declare
`After=`/`Wants=`/`Requires=turbopanel-system-stack.service` instead of the
retired per-service unit names.

**Converge order:** `postgres` → `rabbitmq` → `clickhouse` (config only) →
`system-compose` (brings the stack up, then runs the ClickHouse bootstrap
internally) → `tabix`. Standalone single-service playbooks
(`postgres-setup.yml` / `rabbitmq-setup.yml` / `clickhouse-setup.yml`) each run
their one config role followed by `system-compose`.

**`turbopanel-system` is inspect-only from the daemon's side** — this role (and
its readiness/restart-on-config-change logic above) is the *only* thing that
brings the stack up or restarts a service in it. `system.reconcile` never
calls `docker compose up`/`restart` for `database`/`queue`/`analytics` (see
`../src/deploy/AGENTS.md` → "Shared HTTP ingress identity", fourth table row).
Caddy (control-plane + hosting), Redis, the control-plane instance, and
`turbopaneld` itself stay **host-native** and are never part of this or any
other Compose project — they have no `container` row, and their health/restart
surface is the server **Control** tab / system-component control API on the
instance, not a container table. Rationale for why those four stay host-native
(PAM, `systemctl`/`git` update access, socket uid/gid, unix-socket
permissions) is canonical in `../../instance/AGENTS.md` → "Self-host system
inventory" — do not duplicate it here.

### ClickHouse (self-hosted analytics)

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

Instance-side ClickHouse metrics store + schema/query contract: `../../instance/src/daemon/metrics/AGENTS.md`.

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
`TRUNCATE`.

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
enable/disable env). Schema/query contract: **`../instance/AGENTS.md`** (Server
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

