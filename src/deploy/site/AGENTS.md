# Sites: nginx, Apache, OpenLiteSpeed (`src/deploy/site*`) — AGENTS.md

Parent context: `../AGENTS.md` (tenant deploy & hosting ingress).

When `environment.deploy` carries `sites[]` (compose services with
`x-turbopanel.serviceKind: site`), those services are **not** in
Docker Compose. The daemon:

1. Runs `playbooks/site-nginx-apply.yml` (vendor `nginx` role +
   `web-service-user` for `tpnginx`) when any site uses `engine: nginx`. When
   an nginx site carries hosting `web.php` hints the same playbook also vendors
   **php-fpm** (`turbopanel_php_fpm_install=true`) — the Apache playbook never
   runs on an nginx-only host, so the install cannot live there. The vhost gets a
   `location ~ \.php$` with `fastcgi_pass unix:<socket>`, guarded by
   `try_files $uri =404` so a request for a missing `.php` is never handed to
   FPM, and `include <configDir>/nginx/fastcgi_params` (installed by the nginx
   role) with `SCRIPT_FILENAME` set after it.
2. Runs `playbooks/site-apache-apply.yml` (vendor `apache` role +
   `tpapache`) when any site uses `engine: apache`, likewise vendoring
   **php-fpm** on `turbopanel_php_fpm_install=true` (installed from sury, not
   vendored — see the end of this section). Apache vhosts
   `SetHandler "proxy:unix:…|fcgi://localhost/"` (mod_proxy_fcgi — **never**
   mod_php).

   Both engines share the pool layout: per-site FPM pools under
   `<configDir>/php/pools/tp-<environmentId>-<service>.conf` honoring
   validated `php.settings` via `php_admin_value[…]`. A pool is keyed
   by environment + compose service, so it belongs to exactly one site and
   therefore one engine — which is why `listen.owner`/`listen.group` simply
   follow `site.engine` (`tpapache` or `tpnginx`) with no shared-socket
   ownership to negotiate. Metadata still lands in `.turbopanel/php.json`.
3. Runs `playbooks/site-openlitespeed-apply.yml` (vendor
   `openlitespeed` + `tpols`) when any site uses `engine: openlitespeed`, plus
   vendored **lsphp** on `turbopanel_lsphp_install=true` when an OLS site wants
   PHP. OpenLiteSpeed does not use php-fpm: `openlitespeedVhostConfig` gives the
   vhost its own LSAPI `extprocessor` (`path` → `<runtimesDir>/lsphp/<series>/current/bin/lsphp`,
   `address uds://tmp/lshttpd/<name>.sock`, on-demand via `runOnStartUp 0` +
   `autoStart 2`) under **suEXEC** — `extUser`/`extGroup` resolved from the site
   principal exactly the way a pool's `user`/`group` are, falling back to
   `tpols`. Hosting hints render into the vhost's `phpIniOverride{}` as
   `php_admin_value <key> <value>`, and the site fragment flips
   `enableScript 1`.

   **Several PHP series can run side by side.** `resolveSitePhpSeries` picks per
   site (`web.php.version`, else `DEFAULT_PHP_SERIES`), and
   `phpSeriesForDeploy` collects the distinct set a deploy needs. A php-fpm
   master is one binary, so each series is a separate systemd instance —
   `turbopanel-php-fpm@<series>` — owning its own config, pool glob, pidfile,
   and socket directory:

   ```
   /etc/turbopanel/php/<series>/{php-fpm.conf,pools/,conf.d/}
   /var/log/turbopanel/php/<series>/
   /run/turbopanel/php/<series>/{php-fpm.pid,<poolId>.sock}
   ```

   A site on 8.3 therefore never touches the 8.4 master serving everything
   else: `SiteStagedConfigs.phpFpm` is keyed by series and only the masters that
   actually changed get rolled out. Moving a site between series changes its
   socket path, which is correct and free — the engine's unchanged-content check
   notices and reloads only that engine.

   **The install path is additive.** `installSiteEngines` passes
   `php_fpm_versions` (and `openlitespeed_lsphp_versions`) the way native apps
   pass `node_app_versions`, and the roles install what they are handed and
   never remove a series they were not asked about — the payload describes one
   environment, but the host serves many. Retiring a series belongs to the
   *removal* path: `removeSites` sweeps every installed series' pools and
   `disableIdlePhpSeries` disables a master whose pool directory holds nothing
   but the bootstrap `default.conf`. Packages stay installed; uninstalling is a
   fleet decision.

   `php-fpm` and `lsphp` remain different binaries from different sources, but a
   series string means the same thing to both, so one value still selects both.
   OLS has no per-series reload granularity — per-vhost series selection works,
   but the server restarts as a whole.
4. Materializes document roots under
   `<stateDir>/sites/<environmentId>/<composeServiceName>/<root>/` (default
   `public`; writes a placeholder `index.html` when empty) — **unless the
   service is release-backed**, see below. Merged hosting
   `webEnv` / `php` hints land in `<site>/.turbopanel/hosting.env` and
   `php.json`. When `sites[].principal` is set (from a project
   principal ↔ service tenancy), the site tree is `chown`ed to
   `principal:engineGroup` (`site_user:tpnginx` / `tpapache` / `tpols`) with
   `u=rwX,g=rX` + setgid dirs so the engine can read while the principal owns
   writes. Without a pin, ownership stays the engine user (previous default).
   nginx/Apache php-fpm pools run workers as the principal when pinned (`user` /
   `group = ${username}-grp` from `ensureSystemPrincipals`); the listen socket is
   owned by the serving engine (`tpnginx` / `tpapache`). An OpenLiteSpeed vhost
   carries the same identity twice: as LSAPI `extUser`/`extGroup` on the vhost's
   `extprocessor`, **and** as the vhost's own `user`/`group` (`setUIDMode 0`) in
   the aggregated `httpd_config.conf`, so suEXEC covers everything the vhost
   runs rather than the external processor alone. Multiple principals on one
   site service are rejected at deploy-prepare
   (`site_principal_ambiguous`).
5. Installs loopback-only vhosts under FHS config — nginx
   `<configDir>/nginx/sites/tp-<environmentId>-<service>.conf`, Apache
   `<configDir>/apache/sites/…`, OpenLiteSpeed fragments +
   regenerated `httpd_config.conf` — listening on `127.0.0.1:<listenPort>`
   (and optionally the docker bridge). **Every managed file is installed only
   when its bytes actually change** (staged to `<path>.tmp`, compared with
   `sudo -n cmp -s`, staged further only on a difference — the daemon does not
   run as root, so a plain read of a `root:<engineGroup>` `0640` file would
   report "changed" every time). Reloads `turbopanel-php-fpm` when a pool
   changed, then `turbopanel-nginx` / `turbopanel-apache` /
   `turbopanel-openlitespeed` — each only when **that engine's** own config
   changed or its group membership newly requires a restart (never distro
   `nginx`/`apache2`/`php*-fpm` units). An apply that changed nothing runs no
   config-test and no reload at all.

   That whole sequence — render, stage-if-changed, swap, config-test, reload,
   validate — lives behind one interface in
   **`site/engine-driver.ts`**, which is the single place a new
   engine plugs in. Per-engine differences are data on the driver, not branches
   at the call site: `stageSiteConfig` (privileged `sudo -n install` for
   nginx/Apache; a daemon-owned write for OpenLiteSpeed fragments, which have to
   be **read back** to regenerate `httpd_config.conf`), `configTest` (`nginx -t`
   as `tpnginx`, `httpd -t` as root, `openlitespeed -t` as `tpols`), and
   `reload`. php-fpm is expressed as a driver too (`PHP_FPM_DRIVER`) but is
   reloaded explicitly first, since the engines' config-tests reference sockets
   it owns.

   **Safe rollout.** A rendered config never lands on its live path
   unvalidated. `rolloutSiteConfigs` stages each candidate at
   `<path>.tpnew` (same directory, so the swap is an atomic same-filesystem
   rename; not matching the `*.conf` glob the engines include, so the engine
   cannot see it yet) and snapshots the bytes currently live to `<path>.tpprev`.
   The whole engine's candidate set is then swapped in at once, config-tested,
   reloaded, and probed over HTTP on each site's `127.0.0.1:<listenPort>`
   (any status below 500 counts — the point is that the engine came back
   answering). A failed config-test, a failed reload, or an engine that stops
   answering restores `<path>.tpprev` — or deletes `<path>` for a brand new
   site — and re-tests/reloads the restored config. A deploy therefore cannot
   strand config on disk the engine refuses, which would otherwise break the
   *next* reload or restart long after the deploy that caused it.

   All three engines test a **main** config plus its includes, never a lone
   fragment, so the earliest instant an engine-native test can see a candidate
   is right after the swap. The `<path>.tpprev` snapshot is what makes that
   swap safe; regression coverage for both failure paths lives in
   `site-apply.test.ts`.
6. Rewrites hosting Caddy so hostnames for those services
   `reverse_proxy 127.0.0.1:<listenPort>` instead of Traefik.
7. Skips Docker/Traefik entirely when the payload has **no** container services
   (`compose.yaml` is `services: {}`) — still ensures hosting Caddy via
   `ensureHostingCaddyRuntime`.

All three engines — plus `lsphp` for OpenLiteSpeed PHP — are vendored under
`/opt/turbopanel/vendor/<tool>/<version>/` with a `current` symlink (`lsphp`
adds a series level: `vendor/lsphp/<series>/<version>/`) — **never** distro apt
packages.

**php-fpm is the deliberate exception.** It is installed from Ondřej Surý's
Debian repo (`packages.sury.org/php`) rather than vendored, because tracking CVE
fixes across two dozen extension libraries by hand is not a burden worth taking
on for an interpreter. TurboPanel still owns its runtime: sury's own
`php8.4-fpm.service` is masked and `turbopanel-php-fpm.service` runs the
packaged binary against `/etc/turbopanel/php/php-fpm.conf` and the same
`pools/` directory as before, so nothing in this file's paths changed. See
`../../orchestration/AGENTS.md` (Tenant/daemon-host web servers).

**Release-backed sites (`sourceMaterial[]`).** When the deploy carries a Git
source for a site compose service, that site's document root resolves
to `<principalHome>/sites/<serviceId>/current/<root>` instead of the daemon-owned
state dir. `current` is a stable *name*, so the generated vhost content is
byte-identical across releases — only the (already atomic) promote changes what
it points at. That stability is **enforced, not just intended**: the
unchanged-content check above means an ordinary promote reinstalls nothing,
config-tests nothing, and reloads nothing, so a redeploy of a Git-backed site is
a `current` symlink swap and no more. (Change the listen port, the `webEnv`, or the PHP
hints and the affected engine reloads exactly as before — the skip is content
based, not "release-backed sites never reload".) Because the release tree is
root-owned `0550` by design:

- **Nothing is created or seeded.** A missing `current`, or a missing `<root>`
  inside the release, fails the deploy with a clear error rather than silently
  publishing a placeholder `index.html` over what the operator believes is their
  application.
- **`chownWebTree` is skipped entirely.** Re-chowning the tree to the principal
  would hand a compromised app process write access to the code it runs — the
  exact property the release layout exists to prevent. Read access instead comes
  from `usermod -aG <username>-grp <engineUser>`
  (`ensureEngineGroupMembership`), giving the engine service account group `r-x`
  and nothing more. Supplementary groups are resolved when a process **starts**,
  so the first time an engine joins a group that engine is `systemctl restart`ed
  rather than reloaded; later deploys see the membership already present and go
  back to an ordinary reload. php-fpm is never restarted for this — its workers
  run as the principal, which owns the group already.
- **Hosting metadata moves out of the release.** `hosting.env` / `php.json` land
  in `<siteRoot>/.turbopanel-hosting/` (root-owned, group-readable), installed
  through the same `sudo -n install` seam as every other managed config file.
- **PHP is confined.** A release-backed nginx/Apache PHP pool gets
  `php_admin_value[open_basedir] = <documentRoot>:<siteRoot>/shared:/tmp`, so
  scripts read the release and write through `shared/` — reachable as
  `current/shared` — and nothing else on the filesystem. Daemon-owned sites
  (no release binding) stay unrestricted.
- **PHP is told the symlink moved.** PHP is the one runtime that would keep
  serving the old release after a promote even though the document-root *string*
  never changed, because two caches hide the swap: the realpath cache still
  resolves `…/current/<root>/…` to the previous release directory for
  `realpath_cache_ttl` (120s by default), and opcache with the default
  `opcache.revalidate_path = 0` reuses the cached resolution of the unresolved
  include path, so it never re-stats at all. Since an ordinary promote
  deliberately does **not** reload php-fpm, the mitigation is per-pool config:
  `RELEASE_SYMLINK_SWAP_PHP_DIRECTIVES` in `site.ts` emits
  `php_admin_value[realpath_cache_ttl] = 0`,
  `php_admin_value[opcache.revalidate_path] = 1`,
  `php_admin_value[opcache.validate_timestamps] = 1`, and
  `php_admin_value[opcache.revalidate_freq] = 0` on release-backed pools only.
  It costs a stat per include — the price of an atomic cutover with no reload —
  which is why the vendored baseline
  (`orchestration/roles/php-fpm/templates/php.ini.j2`) keeps opcache enabled with
  `revalidate_freq = 2` for daemon-owned roots, where nothing moves under a
  running worker. Both sides carry a pointer to the other.

Sites with no `sourceMaterial[]` entry are untouched by all of the above.

**Mixed Docker + site:** when an environment deploy includes both
container services and `sites[]`, the daemon (1) binds each
site vhost on loopback (for hosting Caddy) and on the docker bridge
address (`docker0`, override `TURBOPANEL_DOCKER_HOST_GATEWAY`), (2) applies
site **before** `docker compose up`, and (3) patches compose with
`extra_hosts: host.docker.internal:host-gateway` plus
`TURBOPANEL_SITE_<SERVICE>_URL` and
`TURBOPANEL_SITE_ENDPOINTS` JSON env on every container service.

**External Docker networks:** compose `networks.*.external: true` names must be
registered in the org network table (`kind: docker`, `options.dockerNetworkName`)
for the deploy server. Payload `dockerExternalNetworks[]` is ensured with
`docker network create` before compose up (`ensure-docker-networks.ts`).

**Payload-named platform networks** are a third, disjoint set. Neither the
shared hosting-ingress network nor the organization's managed network has a
literal name in daemon code any more — both arrive on the wire:

| Field | Names | Required when |
| --- | --- | --- |
| `hostingIngressNetwork` | The shared hosting-ingress Docker network **and** the shared HTTP Traefik compose project — both the `hosting-ingress` component's bare `serviceId` | The deploy carries at least one hosting (HTTP **or** tcp/udp — a tcp/udp-only deploy still needs the network for its per-service Traefik, even though `hostingIngress` identity is absent) |
| `managedNetwork` | The organization's managed engine network — the `network(kind='managed')` row's bare UUID | At least one compose service joins it (`managedNetworkServices[]` non-empty) |

Both are **rejected when present but unused**, not silently dropped, and
neither has a daemon-side default — a deploy that needs one and omits it is a
contract error. Canonical naming rule: `../managed/AGENTS.md` → **Compose
project names**.

**`fabricNetworks[]` is a disjoint set:** platform-owned `tpn_*` routed bridges
derived from `subnet` rows (`{ name, subnet, gateway?, mtu? }` — compose-bridge CIDRs, not datacenter subnets), never
operator-registered. Requiring a registry row would make every spanning deploy
fail — `tpn_*` is allocated by the compiler. The daemon ensures them via
`ensureFabricDockerNetworks` (fabric.ts routed-bridge path) as a belt-and-braces
path if `server.fabric.reconcile` lands stale.

`environment.stop` removes nginx, Apache, php-fpm pools (both engines share the
`pools/` directory and the `tp-<environmentId>-` prefix, so whichever pass runs
first sweeps them all and the second finds none), and OpenLiteSpeed site
fragments/vhost dirs (best-effort reload/regenerate) in addition to compose
down + hosting Caddy site removal. It also reclaims `siteReleases[]` — the
per-service release trees — but that step is **generic**, not a site
concern: it is the same tree the Git release engine publishes into and native
apps run out of. See the Git-backed releases section.

**OpenLiteSpeed** regenerates a whole `httpd_config.conf` from every fragment
under `<configDir>/openlitespeed/sites/` on each apply/remove (no
`sites-enabled` convention). PHP context lives inside the per-site
`vhosts/<name>/vhconf.conf` and fragment that removal already deletes, so
`removeOpenLiteSpeedSites` needs no PHP-specific step. `web.env`
hints remain unapplied for OLS (Apache-only `SetEnv`) — PHP parity did not
change that.

Future seams (not MVP): multi-version PHP side-by-side, OLS/nginx `web.env`,
swarm-style replicas, ACME issuance on the daemon. TurboFabric **is** the
single org mesh (`server.fabric.reconcile` — see `src/instance/commands/fabric.ts`
and `../../orchestration/AGENTS.md`). `{ enabled: false }` is a teardown; the
daemon owns apply (no Ansible apply playbook).

## Managed-directory sites

A site's content comes from one of two lanes, named by `sourceKind` on the wire
and never inferred:

- **`release`** (the default, and every site's behavior before this existed) —
  a Git-backed immutable tree the release engine publishes into
  `sites/<serviceId>/current`. `applyOneSite` **asserts** it and never creates
  it: silently seeding a placeholder would publish "TurboPanel site is ready"
  over what the operator believes is their application.
- **`managed-directory`** — a principal-writable `sites/<serviceId>/webroot/`
  the tenant fills over SFTP. Created here, because there is no release engine
  on this lane and the directory has to exist before the vhost that serves it.

`webroot/` is a deliberate **sibling** of `releases/` and `current`, and both
lanes resolve `serviceId` through the same `resolveReleaseServiceId`. That is
what makes connecting a repository to an existing site a field flip rather than
a move.

**Names the concession.** A managed directory gives up the immutable-release
property: the tree the engine executes is writable by the account running it,
which is exactly what release confinement exists to prevent. Correct for a
WordPress site (the application writes to itself by design), wrong for a built
application — which is why it is an explicit field and not an inference from
whether `source` is set. `open_basedir` still confines it to its own tree;
`releaseSymlinkSwap` does not apply, because nothing moves under a worker here
and telling PHP otherwise would disable realpath caching for nothing.

**A release wins over the flag.** A site carrying both takes the release branch,
because a promoted tree is what the release engine actually published and
serving the directory instead would ignore a build the operator asked for.
`deployManagedDirectoryBindings` drops the entry so the two can never disagree;
the branch order in `applyOneSite` is the backstop.

**Never recursively chowned.** `ensureManagedDirectory` creates the tree with
the right owner once; a recursive `chmod u=rwX,g=rX` every deploy would fight
whatever modes the tenant set on their own files. The placeholder `index.html`
is written **only into an empty document root**, for the same reason the release
lane asserts rather than creates.

**A principal is required, not optional.** "A directory and an account" needs
both; without an owner there is no account to upload as, and the fallback would
be the daemon-owned tree — which serves fine and is unreachable over SFTP
forever. Refused at three layers: deploy-prepare
(`site_managed_directory_unowned`, with a sentence naming the service), the
wire parser, and the daemon's own contract parser.

