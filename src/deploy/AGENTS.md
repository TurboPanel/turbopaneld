# Tenant deploy & hosting ingress — AGENTS.md

The `environment.deploy` / `environment.lifecycle` / `environment.stop` command handlers: Docker Compose bring-up with Traefik labels, hosting Caddy (`:80`/`:443`, distinct from control-plane Caddy), org TLS materialization from `tpdaemon` envelopes, non-destructive start/stop/restart, and best-effort container reporting.

**Managed engines are a separate path** (`../managed/AGENTS.md`): platform-owned
compose + config under `<stateDir>/managed/<managedId>/`, native ports only, no
hosting Caddy, no tenant Traefik/`turbopanel-ingress`, no user compose merge,
shared ProxySQL frontend (`turbopanel-proxysql` / `managed-ingress`). Do not
route `managed.*` commands through this deploy stack.

Root context: `../../AGENTS.md`. Instance-side command pipeline: `../../../instance/src/lib/commands/AGENTS.md`. Cross-repo `../<repo>/…` links are relative to the repo root.

## Tenant Docker Compose deploy + hosting ingress

`environment.deploy` (command router →
`src/instance/commands/deploy-environment.ts`):

1. Ensure Docker engine (`ensureDocker` → `runDockerSetup` when the binary is
   missing or the Engine API is unreachable). Docker CLI calls fall back to
   `sudo -n -u <self> -- docker …` when the socket is permission-denied so the
   first deploy after group membership still works without a daemon restart
   (`sg docker` fails for `/usr/sbin/nologin` service accounts with "This
   account is currently not available").
2. Bootstrap Traefik on Docker network `turbopanel-ingress` **only when the
   deploy has at least one container HTTP hosting with hostnames** (shared
   loopback entrypoints `127.0.0.1:7080` / `127.0.0.1:7443`, PROXY protocol,
   …). Bare container deploys (no hostnames / no HTTP hosting rows) never start
   the platform `-in` Traefik or declare the external ingress network on
   compose. When
   `<stateDir>/system/hosting-ingress.json` is present,
   `ensureHostingIngress` passes that descriptor into `traefikCompose()` so
   the shared container gets allocated `container_name` /
   `x-turbopanel` / labels; when absent (or corrupt — logged and ignored),
   the anonymous pre-identity shape is written for the fresh pre-provision
   state (descriptor not yet written by `system.reconcile`) so tenant deploys
   cannot orphan an allocated inventory row by rewriting anonymous compose
   over an identity-bearing Traefik.
3. Ensure vendored hosting Caddy (`ensureHostingCaddy` — Ansible `caddy-setup`
   then direct GitHub download) when
   `/opt/turbopanel/vendor/caddy/current/caddy` is missing. On-demand like
   Docker; daemon-converge does not install it. Required for hostname ingress.
4. When `principalMaterial[]` is present, ensure Linux users/groups on the host
   (`ensureSystemPrincipals` in `src/deploy/ensure-principal.ts`). Homes live
   under `layout.principalHomeRoot` (default `/srv/users/<username>`):
   home `0750`, `.ssh` `0700` (reserved for `authorized_keys`), and `volumes`
   `0750`, all owned `username:<username>-grp`. UID/GID are host-assigned
   unless an explicit operator override arrives on the payload. Username max
   length is **28** so `<username>-grp` fits the Linux 32-char group-name
   limit (keep in sync with instance `MAX_PRINCIPAL_USERNAME_LENGTH`). When a GID
   override is supplied and `<username>-grp` already exists with a different
   numeric GID, ensure fails (conflict) instead of silently attaching the
   principal to that group. Shell comes from `principalMaterial[].shell`
   (default `/usr/sbin/nologin`) via `useradd -s` / `usermod -s`. Existing
   accounts are adopted only when the passwd **home** matches the expected
   path — a username collision with a foreign home fails the deploy instead
   of mutating that account. Shell is still reconciled via `usermod -s`;
   never `usermod -m` / `-d`. Directory creation uses `sudo -n install -d`
   so a non-root daemon can write under `/srv`.
5. When `storageMaterial[]` is present, materialize paths under
   `<stateDir>/storage/<organizationId>/<storageId>/` (`materialize-storage.ts`);
   `docker volume create` for `docker_volume` kinds using instance-supplied
   **`volumeName`** when present (else legacy `tp-<org8>-<name>`); optional
   `chown` when a principal is linked. The instance owns Docker volume naming.
   Principal-owned `bind_mount` entries arrive with an instance-derived
   `sourcePath` of `/srv/users/<username>/volumes/<storageId>` (explicit
   operator paths still win); those paths are created via the same sudo-backed
   helper.
6. Decrypt secret variables from `variableMaterial[]` into compose YAML
   (`apply-deploy-variables.ts`); patch storage bind/volume mounts
   (`apply-storage-volumes.ts`) — docker volumes emit
   `volumes.<name> = { name, external: true }` so Compose mounts the
   pre-created volume (not a `<project>_<name>` orphan); `docker_volume`
   entries may omit `destinationPath` when the volume is only compose-declared
   (no service-mount append).
7. Write runtime compose under
   `<stateDir>/deployments/<environmentId>/docker-compose.yml` with Traefik
   labels (`src/deploy/compose-labels.ts`) — proxy middleware for
   `stripPrefix`, `gzip`/`brotli` compress; hosting Caddy respects
   `forceHttps` per hostname (`ingress.ts`). HTTP hostings that share a hostname
   are merged into one Caddy site with `handle` / path matchers (`pathPrefix`);
   Traefik routers already used `pathPrefix` via compose labels.
8. Run pre-deploy hooks (`serviceHooks[]`: optional `build --no-cache`, shell
   preDeployCommand). When the payload sets `noCache: true`, run
   `docker compose build --no-cache --pull` for the whole project, then
   `docker compose up -d --remove-orphans`, then post-deploy hooks
   (`run-deploy-hooks.ts`).
9. When the payload includes `tlsMaterial[]`, materialize org certs under
   `layout.tlsDir` (`/etc/turbopanel/tls/<tlsId>/fullchain.pem` + `privkey.pem`,
   modes `0640`/`0600`) via `materializeTlsCertificates`
   (`src/deploy/materialize-tls.ts`). Private keys arrive as `tpdaemon`
   envelopes — decrypt only through `POST /api/daemon/v1/secrets/decrypt`
   (daemon JWT); never log plaintext.
10. Refresh hosting Caddy config under `/etc/turbopanel/hosting/`
   (`auto_https off` always). Per-hostname site blocks use
   `tls <fullchain> <privkey>` when a resolved `tlsId` was materialized;
   otherwise `tls internal`. When `hostings[].bindAddress` is set, both the
   HTTPS site block and the `forceHttps` HTTP redirect block emit a Caddy
   `bind <address>` directive (IPv4/IPv6 literal validated before interpolation)
   so neither listener attaches to all interfaces — sourced at deploy-prepare
   time from hosting `bind` scope: **public** pinned `ip` row, **datacenter**
   private `ip` (`scope = 'datacenter'` on the target server), or **local**
   loopback `127.0.0.1`. Unit `turbopanel-hosting-caddy.service` when sudo
   allows. **Distinct** from control-plane Caddy (`:8443`).
11. Best-effort `docker compose ps --format json` — per-container identity/status
   (`containerId`, `containerName`, `composeServiceName`, `status`, optional
   `serviceId` from `payload.hostings`) is included in the command result when
   collection succeeds; a `ps`/parse failure never fails an otherwise-successful
   deploy.

## Raw TCP/UDP port hosting (non-HTTP docker services)

`hostings[].protocol` (`http` default/omitted, or `tcp`/`udp`) lets a Docker
service (Postgres, a game server, a UDP relay, …) publish raw port(s) straight
through a **per-service Traefik** instead of routing hostnames through hosting
Caddy — **no** hostname/TLS/path routing for those hostings;
`hostings[].ports[]` (required, non-empty for `tcp`/`udp`) is a
`{ published, target }` list.

**Managed engines do not use this path** — they enter via the shared ProxySQL
project (`turbopanel-proxysql` / `managed-ingress`). This section applies only
to **tenant** docker-compose hostings.

**HTTP hostings are excluded** from this path: they stay on the shared
loopback Traefik (`turbopanel-ingress` / `traefikCompose()` — `web` /
`websecure` only, no published public ports) via Docker labels. They never
get a per-service Traefik project or an `ingressServices[]` entry.

- **Compose labels** (`compose-labels.ts` `applyTcpUdpHostingLabels`): one
  `traefik.tcp.routers.<hostingId>-<published>` / `traefik.udp.routers…` pair
  per published port, plus `com.turbopanel.service=<serviceId>` (from
  `injectHostingLabels`). TCP routers get a catch-all `HostSNI(\`*\`)` rule;
  UDP routers take no rule label. Both get a `…loadbalancer.server.port`
  label targeting the container port.
- **Per-service Traefik** (`serviceTraefikCompose` / `ensureServiceIngress`):
  every service in `payload.ingressServices[]` gets its own compose project
  `turbopanel-ingress-<serviceId>` under
  `<stateDir>/ingress/services/<serviceId>/`, with
  `container_name: <serviceId>-in`,
  `x-turbopanel: { kind: ingress, serviceId, containerName }`, joined to
  `turbopanel-ingress`, and
  ``--providers.docker.constraints=Label(`com.turbopanel.service`,`<serviceId>`)``.
  Static config is regenerated (not hot-reloaded): one quoted
  ``--entrypoints.<protocol><port>.address=:<port>[/udp]`` arg and one quoted
  ``"<bind>:<port>:<port>/<protocol>"`` `ports:` line per entry (bind defaults
  `0.0.0.0`; IPv6 bracketed; `assertValidBindAddress`). Entries are deduped
  and sorted for a stable diff.
- **Cross-service port uniqueness**: claim files live at
  `<stateDir>/ingress/tcp-udp/<serviceId>.json`
  (`syncTcpUdpIngressEntries`). Sync reads every *other* service's file
  (`collectTcpUdpIngressEntries`), rejects with `TcpUdpPortConflictError`
  when another service already claims the same `protocol`+`publishedPort`
  (**no partial write** on conflict), then writes this service's file (or
  deletes it when empty) and returns **this service's own entries** for
  `ensureServiceIngress`. Deploy syncs ingress **before** app `compose up`.
- **Stop**: `removeEnvironmentTcpUdpServiceIngress` unions payload
  `ingressServices[]` with the daemon-persisted environment index
  (`ingress/by-environment/<environmentId>.json`), then
  `removeServiceIngress` + `removeTcpUdpIngressEntries` for each and clears
  the index. Payload alone is not teardown truth — a hosting deleted or
  flipped to HTTP before stop still cleans stale Traefik. Shared HTTP
  Traefik is left alone (tcp/udp no longer live there).
- Extraction: `buildTcpUdpIngressEntries` maps each `tcp`/`udp` hosting's
  `ports[]` to one `TcpUdpIngressEntry` (with that hosting's `bindAddress`).

`environment.stop` (command router →
`src/instance/commands/stop-environment.ts`):

1. `docker compose -p <projectName> -f <stateDir>/deployments/<environmentId>/docker-compose.yml down --remove-orphans --volumes`
   when the compose file exists (idempotent no-op when missing).
2. Remove `/etc/turbopanel/hosting/sites/<environmentId>.caddy` via
   `removeHostingCaddySite` and best-effort reload hosting Caddy; remove
   traditional-web sites.
3. Tear down per-service tcp/udp ingress via
   `removeEnvironmentTcpUdpServiceIngress` (payload ∪ environment index).
4. Delete the deployment directory.
5. Return authoritative `containers: []` so the instance clears Postgres
   container pins.

`environment.lifecycle` (command router →
`src/instance/commands/lifecycle-environment.ts`):

1. Require
   `<stateDir>/deployments/<environmentId>/docker-compose.yml` — missing
   compose **fails** with a deploy-first message (unlike idempotent stop).
2. `docker compose -p <projectName> -f <composePath> <start|stop|restart>` —
   never `down`, `--volumes`, or `--remove-orphans`.
3. Best-effort apply the same action to each per-service Traefik project for
   this environment (`readEnvironmentTcpUdpServiceIds` →
   `serviceIngressComposePath` / `serviceIngressProject`); log and continue
   on failure. Read-only w.r.t. claim files.
4. Best-effort `docker compose … ps -a --format json` (include stopped
   containers); omit `containers` from the result when collection fails so
   the instance skips reconcile.
5. **Never** removes volumes, the deployment dir, hosting Caddy sites, or
   tcp/udp claim files.

Helpers: `src/deploy/ensure-docker.ts`, `src/deploy/ingress.ts`,
`src/deploy/labels.ts`, `src/deploy/ingress-identity.ts`,
`src/deploy/system-component.ts`, `src/deploy/materialize-tls.ts`,
`src/deploy/ensure-hosting-caddy.ts`,
`src/deploy/materialize-storage.ts`, `src/deploy/apply-storage-volumes.ts`,
`src/deploy/run-deploy-hooks.ts`, `src/deploy/ensure-principal.ts`,
`src/deploy/traditional-web.ts`, `src/deploy/traditional-web-docker.ts`,
`src/deploy/ensure-docker-networks.ts`, `src/deploy/compose-ps.ts`.

## Shared HTTP ingress identity

The shared loopback Traefik (compose project `turbopanel-ingress`, service key
`traefik`) is **platform inventory**, distinct from per-service tenant TCP/UDP
Traefik and from managed-engine ProxySQL:

| Pattern | Ownership | Compose project |
| --- | --- | --- |
| Shared HTTP ingress | Platform (`system/hosting-ingress.json`) | `turbopanel-ingress` |
| Tenant TCP/UDP ingress | Tenant service (`ingress/services/<serviceId>/`) | `turbopanel-ingress-<serviceId>` |
| Managed-engine ingress | Platform system component (`managed-ingress` → ProxySQL under `configDir/proxysql/`) | `turbopanel-proxysql` |
| System stack (database/queue/analytics) | Ansible/Ops (`system-compose` role), inspected via `system/<component>.json` | `turbopanel-system` |

**Keep these four patterns distinct:**

1. **Shared HTTP Traefik** (`hosting-ingress`) — self-heals via
   `ensureHostingIngress` when demand exists; loopback only to hosting Caddy.
2. **Tenant raw TCP/UDP Traefik** — still **per tenant service** under
   `ingress/services/<serviceId>/` for docker-compose hostings with
   `protocol: tcp|udp`. **Do not** fold tenant raw ports into ProxySQL.
   Ports `5432` / `3306` are reserved for the shared ProxySQL listeners
   (`PROXYSQL_RESERVED_PUBLISHED_PORTS`); tenant claims colliding on those
   published ports are rejected daemon-side.
3. **Managed-engine ProxySQL** (`managed-ingress`) — one per server,
   `proxysql/proxysql:3.0.2`, project `turbopanel-proxysql`. Desired state is
   whole-server `managed.ingress.reconcile` (not embedded on `managed.apply`).
   System self-heal dispatches to ProxySQL compose start/restart when the
   inventory component is present. Engine containers never publish host ports
   and never get a per-managed Traefik project.
4. **System stack (`turbopanel-system`)** — inspect-only, never self-healed.
   PostgreSQL/RabbitMQ/ClickHouse are provisioned by the `system-compose`
   Ansible role. `system.reconcile` only inspects (`selfHeal: none`).

Adoption for hosting-ingress and system-stack rows requires the documented
labels (`turbopanel.role`, `com.turbopanel.system.component`, …) — see below.
ProxySQL uses `role: turbopanel` + `com.turbopanel.system.component=managed-ingress`
when identity is stamped.

Descriptor path: `<stateDir>/system/hosting-ingress.json`
(`SystemComponentDescriptor`: `component`, `serviceId`, `composeServiceName`
must stay `traefik`, `containerName` = `<serviceId>-in`). When present,
`traefikCompose(identity)` emits `container_name`,
`x-turbopanel: { kind: system, component: hosting-ingress, … }`, and labels
`turbopanel.role=ingress`, `com.turbopanel.system.component=hosting-ingress`,
`com.turbopanel.service=<serviceId>` — **never** `traefik.enable`, HTTP router
labels, or `com.turbopanel.raw-port` (so tenant Traefik providers stay blind to
it). `ensureHostingIngress` reads the descriptor on every deploy; a missing
file is the normal pre-provision path (before `system.reconcile` writes
identity); a corrupt file logs a warning and falls back to the anonymous YAML
so tenant deploys still succeed. `inspectHostingIngressContainer` best-effort
returns the observed container in `EnvironmentDeployContainer` shape
(`role: ingress`); compose-ps failure returns `undefined` (omit `containers`),
absence returns `null`. A missing compose file is authoritative absence
(`null`), not a collection failure. Observed rows must match the allocated
`container_name` **and** compose service **and** carry allowlisted platform
labels (`turbopanel.role=ingress`,
`com.turbopanel.system.component=hosting-ingress`,
`com.turbopanel.service=<serviceId>`) — anonymous pre-provision
`turbopanel-ingress-traefik-1` rows (no platform labels) are ignored.
Production writer: the `system.reconcile` handler always calls
`writeSystemComponentDescriptor`, then self-heals via `ensureDocker` +
`ensureHostingIngress` when `desired: 'present'` (plus compose `restart` when
`action: 'restart'`), intentionally stops the shared project when
`action: 'stop'` (hosting-disable PATCH — `compose stop`, then `ps -a`
inspect), or report-only inspect when `desired: 'absent'` with
`action: 'reconcile'` — ordinary disabled-state drift must not silently tear
down a running proxy. **`desired: 'present'` is demand-driven**: hosting
enabled alone leaves the inventory pending until an HTTP hostname hosting
exists on the server (or the ingress was already observed after first start)
— bare enroll / enable-hosting must not pull Traefik.

For ProxySQL / `managed-ingress`, the descriptor + compose identity live with
`SYSTEM_COMPONENT_CONTRACTS.managed-ingress` (`selfHeal: "proxysql"`);
`containerName` = `<serviceId>-sql` (not bare uuid, not `-in`). Self-host
stack components (`database` / `queue` / `analytics`) stay bare-`serviceId`.
Runtime files under `configDir/proxysql/` are written by
`managed.ingress.reconcile` and optionally re-started by `system.reconcile`.
Host dirs and the `turbopanel-proxysql-stack` unit are Ansible-owned
(`proxysql` role).

**System stack (`turbopanel-system`) is inspect-only:**
`inspectSystemStackContainer` (`src/deploy/system-stack.ts`) reports
`docker compose ps` identity/status (`selfHealAllowed: false` for
`database` / `queue` / `analytics`). Adoption requires labels
`turbopanel.role=turbopanel` + `com.turbopanel.system.component=<database|queue|analytics>`
— **never** `com.turbopanel.service` (tenant/system Traefik identity) and
**never** `traefik.enable`. A missing `turbopanel-system` compose file is
authoritative absence (`null`).

## Traditional web (nginx + apache + OpenLiteSpeed)

When `environment.deploy` carries `traditionalWebSites[]` (compose services with
`x-turbopanel.serviceKind: traditional-web`), those services are **not** in
Docker Compose. The daemon:

1. Runs `playbooks/traditional-web-apply.yml` (vendor `nginx` role +
   `web-service-user` for `tpnginx`) when any site uses `engine: nginx`.
2. Runs `playbooks/traditional-web-apache-apply.yml` (vendor `apache` role +
   `tpapache`) when any site uses `engine: apache`. When any Apache site
   carries hosting `web.php` hints, the playbook also vendors **php-fpm**
   (`turbopanel_php_fpm_install=true`). Conflicting PHP series across sites
   fail validation; only the pinned series (`PINNED_PHP_FPM_SERIES` /
   `php_fpm_series`, currently **8.4**) is accepted. Per-site FPM pools under
   `<configDir>/php/pools/tp-<environmentId>-<service>.conf` honor
   `memoryLimit` / `maxExecutionTime` via `php_admin_value[…]`; Apache vhosts
   `SetHandler "proxy:unix:…|fcgi://localhost/"` (mod_proxy_fcgi — **never**
   mod_php). Metadata still lands in `.turbopanel/php.json`.
3. Runs `playbooks/traditional-web-openlitespeed-apply.yml` (vendor
   `openlitespeed` + `tpols`) when any site uses `engine: openlitespeed`.
4. Materializes document roots under
   `<stateDir>/sites/<environmentId>/<composeServiceName>/<root>/` (default
   `public`; writes a placeholder `index.html` when empty). Merged hosting
   `webEnv` / `php` hints land in `<site>/.turbopanel/hosting.env` and
   `php.json`. When `traditionalWebSites[].principal` is set (from a project
   principal ↔ service assignment), the site tree is `chown`ed to
   `principal:engineGroup` (`site_user:tpnginx` / `tpapache` / `tpols`) with
   `u=rwX,g=rX` + setgid dirs so the engine can read while the principal owns
   writes. Without a pin, ownership stays the engine user (previous default).
   Apache php-fpm pools run workers as the principal when pinned (`user` /
   `group = ${username}-grp` from `ensureSystemPrincipals`); the listen socket
   stays `tpapache:tpapache` for mod_proxy_fcgi. Multiple principals on one
   traditional-web service are rejected at deploy-prepare
   (`traditional_web_principal_ambiguous`).
5. Installs loopback-only vhosts under FHS config — nginx
   `<configDir>/nginx/sites/tp-<environmentId>-<service>.conf`, Apache
   `<configDir>/apache/sites/…`, OpenLiteSpeed fragments +
   regenerated `httpd_config.conf` — listening on `127.0.0.1:<listenPort>`
   (and optionally the docker bridge). Reloads `turbopanel-php-fpm` (when PHP
   pools changed) then `turbopanel-nginx` / `turbopanel-apache` /
   `turbopanel-openlitespeed` (never distro `nginx`/`apache2`/`php*-fpm`
   units).
6. Rewrites hosting Caddy so hostnames for those services
   `reverse_proxy 127.0.0.1:<listenPort>` instead of Traefik.
7. Skips Docker/Traefik entirely when the payload has **no** container services
   (`composeYaml` is `services: {}`) — still ensures hosting Caddy via
   `ensureHostingCaddyRuntime`.

All three engines (plus php-fpm for Apache PHP) are vendored under
`/opt/turbopanel/vendor/<tool>/<version>/` with a `current` symlink — **never**
distro apt packages. See `../../orchestration/AGENTS.md` (Tenant/daemon-host
web servers).

**Mixed Docker + traditional-web:** when an environment deploy includes both
container services and `traditionalWebSites[]`, the daemon (1) binds each
traditional-web vhost on loopback (for hosting Caddy) and on the docker bridge
address (`docker0`, override `TURBOPANEL_DOCKER_HOST_GATEWAY`), (2) applies
traditional-web **before** `docker compose up`, and (3) patches compose with
`extra_hosts: host.docker.internal:host-gateway` plus
`TURBOPANEL_TRADITIONAL_WEB_<SERVICE>_URL` and
`TURBOPANEL_TRADITIONAL_WEB_ENDPOINTS` JSON env on every container service.

**External Docker networks:** compose `networks.*.external: true` names must be
registered in the org network table (`kind: docker`, `options.dockerNetworkName`)
for the deploy server. Payload `dockerExternalNetworks[]` is ensured with
`docker network create` before compose up (`ensure-docker-networks.ts`).

`environment.stop` removes nginx, Apache, php-fpm pool, and OpenLiteSpeed site
fragments/vhost dirs (best-effort reload/regenerate) in addition to compose
down + hosting Caddy site removal.

**OpenLiteSpeed** regenerates a whole `httpd_config.conf` from every fragment
under `<configDir>/openlitespeed/sites/` on each apply/remove (no
`sites-enabled` convention). It is static-only for now — no PHP/env hints
(parity with nginx).

Future seams (not MVP): multi-version PHP side-by-side, OLS/nginx PHP,
multi-server service placement, swarm-style replicas, ACME issuance on the
daemon. WireGuard mesh apply is handled by `server.wireguard.apply` — see
`src/instance/commands/wireguard.ts` and `../../orchestration/AGENTS.md`
(WireGuard).
