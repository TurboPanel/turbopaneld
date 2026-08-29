# Orchestration — AGENTS.md

Ansible roles and playbooks under `orchestration/`. Root context: `../AGENTS.md`. Cross-repo `../<repo>/…` links are relative to the repo root.

### Upstream licenses (Ansible tooling)

Ansible Core, `ansible-lint`, the `ansible.posix` collection, the
`geerlingguy.docker` Galaxy role, and any packages these playbooks
install remain under their upstream licenses. Pins live in
`requirements.txt` (Ansible Core / ansible-lint constraints),
`requirements.lock.txt` (hash-locked CI install set), `requirements.yml`
(`ansible.posix`), and `requirements-docker.yml` (`geerlingguy.docker`).
Installing them onto a host is a different licensing event from
redistributing them. Any TurboPanel-published appliance, VM/OCI image,
or offline bundle that ships copies must carry the applicable upstream
license, copyright, notice, and source-compliance material.

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

### TurboFabric (`server.fabric.reconcile`)

There is **no** Ansible WireGuard apply role. The daemon
(`src/instance/commands/fabric.ts`) owns the org mesh on interface `tp0`:
mode-`0600` private key and `tp0.conf` under `<daemonStateDir>/network/wireguard/`,
`wg syncconf`, `wg-quick@tp0` for reboot durability, `/etc/sysctl.d/99-turbopanel-fabric.conf`
(`net.ipv4.ip_forward=1`), Docker routed-bridge networks, and `TP-FORWARD` off
`DOCKER-USER`. `{ enabled: false }` is a teardown. Peer PSKs are decrypted into
mode-`0600` files under `wireguard/psk/`, inlined into `tp0.conf`, then deleted
— they never appear in logs. `wireguard-tools` is listed in `daemon-prereqs`
on managed hosts — **the only Ansible-side prerequisite**. There is **no**
`wireguard` role and **no** `wireguard-apply.yml` playbook; do not re-add
either. Default MTU is **1420** on `tp0` and each routed bridge
(payload-overridable). **Preflight** verifies `wg` / `ip` / `iptables` /
`docker` (presence *and* invocability, direct or `sudo -n`) before mutating
anything. The durable interface unit, `/etc/wireguard/tp0.conf`, and the
`sysctl.d` drop-in are **daemon-written**. Daemon start restores from
`state.json` and re-installs `TP-FORWARD` (dockerd can rebuild `DOCKER-USER`).
Deploy-time `fabricNetworks[]` is the belt-and-braces bridge path alongside
command-driven reconcile and boot restore. **Not** wired into
`daemon-converge.yml` (command-driven, plus boot restore).

### ProxySQL (`proxysql`)

Moved to `roles/proxysql/AGENTS.md`.

### Orchestrator (`orchestrator`)

Moved to `roles/orchestrator/AGENTS.md`.

### Web-service user (`web-service-user`)

Moved to `roles/web-service-user/AGENTS.md`.

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

The role also installs a static `fastcgi_params` (`roles/nginx/files/`) to
`/etc/turbopanel/nginx/fastcgi_params`. Generated PHP vhosts `include` it by
absolute path and then set `SCRIPT_FILENAME` / `PATH_INFO` themselves, so a
site's own document root always wins. PHP itself is the sibling `php-fpm` role
below — `site-nginx-apply.yml` includes it (and provisions the `tpapache`
account php-fpm's master runs as) when the daemon passes
`turbopanel_php_fpm_install: true`.

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

### Runtime entitlements (`runtime-entitlement`, `runtime-registry.json`)

**A runtime entitlement is a unix group**, because that is the only form the
kernel enforces at `execve`. Anything derived only into a generated systemd unit
or an FPM pool is invisible to an interactive shell or a cron job — both of which
run as the principal, and both of which are exactly the cases the grant has to
cover.

`orchestration/runtime-registry.json` is the single artifact: Ansible reads it
with `include_vars` in the `runtime-entitlement` role, and the daemon imports the
same file in `../src/runtime/registry.ts`. Same bytes, so group names and gids
cannot drift.

**Groups are per `(runtime, series)`** — `tpphp84`, `tpnode24` — never one group
per runtime. Co-installed PHP versions are distinct binaries, so a single
`tpphp` would mean granting 8.4 also grants 8.3 with whatever CVEs another
tenant's pinned app carries. It is also what lets a shell wrapper resolve a
caller's series from its group list. One PHP group spans both flavors:
`tpphp84` owns `/usr/sbin/php-fpm8.4`, `/usr/bin/php8.4`, **and**
`vendor/lsphp/8.4/current/bin/lsphp` — "may execute PHP 8.4 here", whichever
engine serves the site.

gids are hand-assigned in the registry, never computed from the version string
(that breaks the day `8.10` exists). Band **9900–9979** is entitlements;
**9980–9999** is service identities. `../src/orchestration/service-accounts.test.ts`
enforces uniqueness across both and that entitlement gids stay inside their band.

**Membership is reconciled by the daemon, not by this role.** The role only
creates groups and grants them traverse-only ACLs on `/opt/turbopanel` and
`vendor/`. `ensurePrincipalManagedGroups` (`../src/deploy/ensure-principal.ts`)
adds *and revokes* during principal materialization — which runs before any unit
is installed, because systemd resolves supplementary groups at `execve` and a
unit started too early dies `203/EXEC`. Revocation only ever touches names the
registry defines, so `<username>-grp`, `tp`, engine groups, and anything an
operator added by hand are never stripped.

### php-fpm (`php-fpm`)

Moved to `roles/php-fpm/AGENTS.md` — co-installed sury series, per-series
`turbopanel-php-fpm@<series>` instances, statoverrides, masked sury units.

### OpenLiteSpeed (`openlitespeed`)

Moved to `roles/openlitespeed/AGENTS.md` — includes the `lsphp` (LSAPI PHP)
subsection.

### instance-launch secret keyring

The `instance-launch` role persists the control-plane root secret keyring under
the instance config dir (never in the git checkout):

| Path | Owner / mode | Purpose |
| --- | --- | --- |
| `…/instance/.instance_secrets` | `root:{{ turbopanel_group }}` `0640` | Versioned keyring, `<version>:<value>` comma-separated, highest/current first |

Slurped into the `turbopanel_instance_secrets` fact and templated as
`TURBOPANEL_SECRETS=` into both `instance-deno.dev-vars.j2` /
`instance-workers.dev-vars.j2`. Rotation is
opt-in via `turbopanel_instance_secret_rotate` (default `false`): prepends
`max(existing ∪ {1}) + 1` so the first rotate is `v2`, and writes atomically.
`src/orchestration/ansible.test.ts` pins the default, the gate expression, the
ownership/mode, and the templated env lines.

---


### System services Compose stack (`system-compose`)

Moved to `roles/system-compose/AGENTS.md`.

### ClickHouse (self-hosted analytics)

Moved to `roles/clickhouse/AGENTS.md` — role, idle-CPU tuning, app-user
grants, dev-only Tabix GUI.
