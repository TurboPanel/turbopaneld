# Tenant deploy & hosting ingress — AGENTS.md

The `environment.deploy` / `environment.stop` command handlers: Docker Compose bring-up with Traefik labels, hosting Caddy (`:80`/`:443`, distinct from control-plane Caddy), org TLS materialization from `tpdaemon` envelopes, and best-effort container reporting.

**Managed engines are a separate path** (`../managed/AGENTS.md`): platform-owned compose + config under `<stateDir>/managed/<managedId>/`, native ports only, no hosting Caddy, no tenant Traefik/`turbopanel-ingress`, no user compose merge. Do not route `managed.*` commands through this deploy stack.

Root context: `../../AGENTS.md`. Instance-side command pipeline: `../../../instance/src/lib/commands/AGENTS.md`. Cross-repo `../<repo>/…` links are relative to the repo root.

### Tenant Docker Compose deploy + hosting ingress

`environment.deploy` (command router →
`src/instance/commands/deploy-environment.ts`):

1. Ensure Docker engine (`ensureDocker` → `runDockerSetup` when the binary is
   missing or the Engine API is unreachable). Docker CLI calls fall back to
   `sudo -n -u <self> -- docker …` when the socket is permission-denied so the
   first deploy after group membership still works without a daemon restart
   (`sg docker` fails for `/usr/sbin/nologin` service accounts with "This
   account is currently not available").
2. Bootstrap Traefik on Docker network `turbopanel-ingress` with loopback-only
   entrypoints `127.0.0.1:7080` (`web`) and `127.0.0.1:7443` (`websecure`,
   entrypoint-level TLS via Traefik's default self-signed cert), both with
   `proxyProtocol.insecure=true`. **No** socat/`ingress-bridge`/unix socket.
   Hosting Caddy dials `:7080` over h2c and `:7443` over HTTP/2+TLS
   (`tls_insecure_skip_verify`) with PROXY protocol v2. HTTP/3 is offered only
   at the public browser edge (browser→Caddy). **No** public `:80`/`:443` on
   Traefik; **no** ACME/LE.
3. Ensure vendored hosting Caddy (`ensureHostingCaddy` — Ansible `caddy-setup`
   then direct GitHub download) when
   `/opt/turbopanel/vendor/caddy/current/caddy` is missing. On-demand like
   Docker; daemon-converge does not install it. Required for hostname ingress.
4. When `principalMaterial[]` is present, ensure Linux users/groups on the host
   (`ensureSystemPrincipals` in `src/deploy/ensure-principal.ts`). Homes live
   under `layout.principalHomeRoot` (default `/srv/users/<principalId>`):
   home `0750`, `.ssh` `0700` (reserved for `authorized_keys`), and `volumes`
   `0750`, all owned `uid:gid`. Shell comes from `principalMaterial[].shell`
   (default `/usr/sbin/nologin`) via `useradd -s` / `usermod -s`. Existing users
   are reconciled with `usermod -d` / `usermod -s` when home/shell differ —
   never `usermod -m` (no data move) — but only after the passwd UID/GID match
   the principal; a username collision with a different account fails instead
   of mutating that account. Directory creation uses
   `sudo -n install -d` so a non-root daemon can write under `/srv`.
5. When `storageMaterial[]` is present, materialize paths under
   `<stateDir>/storage/<organizationId>/<storageId>/` (`materialize-storage.ts`);
   `docker volume create` for `docker_volume` kinds using instance-supplied
   **`volumeName`** when present (else legacy `tp-<org8>-<name>`); optional
   `chown` when a principal is linked. The instance owns Docker volume naming.
   Principal-owned `bind_mount` entries arrive with an instance-derived
   `sourcePath` of `/srv/users/<principalId>/volumes/<storageId>` (explicit
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
   preDeployCommand) then `docker compose up -d --remove-orphans`, then post-deploy
   hooks (`run-deploy-hooks.ts`).
9. When the payload includes `tlsMaterial[]`, materialize org certs under
   `layout.tlsDir` (`/etc/turbopanel/tls/<tlsId>/fullchain.pem` + `privkey.pem`,
   modes `0640`/`0600`) via `materializeTlsCertificates`
   (`src/deploy/materialize-tls.ts`). Private keys arrive as `tpdaemon`
   envelopes — decrypt only through `POST /api/daemon/v1/secrets/decrypt`
   (daemon JWT); never log plaintext.
7. Refresh hosting Caddy config under `/etc/turbopanel/hosting/`
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
10. Best-effort `docker compose ps --format json` — per-container identity/status
   (`containerId`, `containerName`, `composeServiceName`, `status`, optional
   `serviceId` from `payload.hostings`) is included in the command result when
   collection succeeds; a `ps`/parse failure never fails an otherwise-successful
   deploy.

### Raw TCP/UDP port hosting (non-HTTP docker services)

`hostings[].protocol` (`http` default/omitted, or `tcp`/`udp`) lets a Docker
service (Postgres, a game server, a UDP relay, …) publish raw port(s) straight
through Traefik instead of routing hostnames through hosting Caddy — **no**
hostname/TLS/path routing for those hostings; `hostings[].ports[]` (required,
non-empty for `tcp`/`udp`) is a `{ published, target }` list.

- **Compose labels** (`compose-labels.ts` `applyTcpUdpHostingLabels`): one
  `traefik.tcp.routers.<hostingId>-<published>` / `traefik.udp.routers…` pair
  per published port. TCP routers get a catch-all `HostSNI(\`*\`)` rule (no
  SNI to match without a hostname); UDP routers take no rule label at all.
  Both get a `…loadbalancer.server.port` label targeting the container port.
- **Traefik static config is regenerated, not hot-reloaded**: Traefik cannot
  add entrypoints at runtime, so `traefikCompose()` (`ingress.ts`) takes the
  full merged set of `TcpUdpIngressEntry` and emits one
  `--entrypoints.<protocol><port>.address=:<port>[/udp]` static arg plus one
  `<bind>:<port>:<port>/<protocol>` compose `ports:` line per entry (bind
  defaults `0.0.0.0`; IPv6 literals get bracketed). `ensureHostingIngress`
  rewrites this file and `docker compose up -d` every deploy/stop — Traefik
  restarts whenever the merged entrypoint set changes, which is why entries
  are deduped and sorted for a stable diff.
- **Cross-environment port uniqueness**: the daemon has no global view of
  every environment's hostings, so each environment's TCP/UDP entries are
  persisted to `<stateDir>/ingress/tcp-udp/<environmentId>.json`
  (`syncTcpUdpIngressEntries`, called from both `deploy-environment.ts` and
  `stop-environment.ts`). Sync reads every *other* environment's file
  (`collectTcpUdpIngressEntries`), rejects with `TcpUdpPortConflictError` when
  another environment already claims the same `protocol`+`publishedPort`
  (**no partial write** on conflict), then writes this environment's file
  (or deletes it when empty) and returns the full merged set for
  `ensureHostingIngress`. `environment.stop` calls
  `removeTcpUdpIngressEntries` and only re-syncs Traefik when that environment
  actually had entries (`null` return short-circuits a no-op restart).
- Extraction from the deploy payload: `buildTcpUdpIngressEntries` maps each
  `tcp`/`udp` hosting's `ports[]` to one `TcpUdpIngressEntry` (carrying that
  hosting's resolved `bindAddress`, if any).

`environment.stop` (command router →
`src/instance/commands/stop-environment.ts`):

1. `docker compose -p <projectName> -f <stateDir>/deployments/<environmentId>/docker-compose.yml down --remove-orphans --volumes`
   when the compose file exists (idempotent no-op when missing).
2. Remove `/etc/turbopanel/hosting/sites/<environmentId>.caddy` via
   `removeHostingCaddySite` and best-effort reload hosting Caddy.
3. Delete the deployment directory.
4. Return authoritative `containers: []` so the instance clears Postgres
   container pins.

Helpers: `src/deploy/ensure-docker.ts`, `src/deploy/ingress.ts`,
`src/deploy/materialize-tls.ts`, `src/deploy/ensure-hosting-caddy.ts`,
`src/deploy/materialize-storage.ts`, `src/deploy/apply-storage-volumes.ts`,
`src/deploy/run-deploy-hooks.ts`, `src/deploy/ensure-principal.ts`,
`src/deploy/traditional-web.ts`, `src/deploy/traditional-web-docker.ts`,
`src/deploy/ensure-docker-networks.ts`.

### Traditional web (nginx + apache + OpenLiteSpeed)

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
