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

### Docker (`docker`)

Thin wrapper around the deferred `geerlingguy.docker` Galaxy role (fetched
on demand by `ensureGalaxyDockerRole()`, never during bootstrap) with a
fast-path when the binary is present and the service active. The role
**also owns `/etc/docker/daemon.json`** for the org-wide dockerd addressing
(`tasks/daemon-json.yml`):

- Inputs are `turbopanel_docker_address_pools` (dockerd
  `default-address-pools`, `[{ base, size }]`) and
  `turbopanel_docker_default_bridge_cidr` (dockerd `bip`), passed by the
  daemon as **one JSON `-e` object** (`runDockerSetup(opts)` /
  `buildDockerSetupExtraArgs`) so the list stays a list. With no options the
  daemon resolves them from `<configDir>/docker/networking.json`, the copy
  it persisted after `GET /api/daemon/v1/host/docker-networking`
  (`src/deploy/docker-networking-state.ts`, synced once per daemon session by
  `syncHostDockerNetworking`), so an on-demand install lands with the right
  pools too.
- **Always-on egress block** (`tasks/egress-guard.yml`, `files/turbopanel-docker-egress`, unit
  `turbopanel-docker-egress.service`, var `turbopanel_docker_egress_guard`, default true; audit P1-4): chain `TP-EGRESS`
  hung off `DOCKER-USER` and `INPUT` for traffic entering on `docker0` / `br-+` only. Drops 169.254.0.0/16,
  168.63.129.16, 100.100.100.200 (IPv4) and fe80::/10 (ICMPv6 allowed), fd00:ec2::254 (IPv6), with a DNS (53)
  exception for link-local resolvers. Independent of the opt-in host firewall (`TP-FWD`/`TP-INPUT`). Re-applied after
  every docker.service restart (`PartOf`/`After`), never removed on stop; purge removes unit, script, chain and jumps.
  It does not cover fetches the BuildKit engine makes itself (`ADD http://`, remote contexts), which run in dockerd's
  own namespace. Tests: `src/firewall/egress-guard.test.ts` (stub iptables).
- **Builder backstop**: the merge also forces `builder.entitlements` `network-host` and `security-insecure` to `false`
  (`turbopanel_docker_deny_builder_entitlements`, default true), so the engine's own builder refuses a build that asks
  for either ("granting entitlement network.host is not allowed by build daemon configuration"), whatever the Docker
  gate sees. Other `builder` keys and entitlements are kept. A real diff restarts dockerd like any daemon.json change.
  On a co-located instance host (never auto-restarted by the handler) a change leaves
  `/etc/docker/turbopanel-restart-pending`; this and every later converge restart dockerd once the running dockerd
  reports live-restore, then clear the marker, and otherwise warn that a restart is pending.
  `daemon-converge` re-applies just this deny (`tasks/converge-builder.yml`, `turbopanel_docker_builder_only`) on
  hosts the role provisioned earlier: address pools, `bip` and `live-restore` are left as found, and it reads
  `daemon.json` back and fails if the deny is not on disk.
- **Strict no-op when both are empty and nothing is being cleared** (and
  when `turbopanel_docker_manage_daemon_json: false`): `daemon-json.yml` is
  not even included, so an unrelated converge never reads, writes or
  restarts anything.
- **Clearing**: when an empty org config replaces a non-empty descriptor the
  host already applied, `syncHostDockerNetworking` passes
  `clearAddressing: true` → `turbopanel_docker_clear_addressing: true`,
  which forces the include so the merge *removes* `default-address-pools`
  and `bip` from the file (Docker's built-in defaults take over). The local
  descriptor is only persisted after that removal succeeds, so a failed
  clear retries next session instead of reading as `unchanged`.
- **Merge, never overwrite**: the existing file is `slurp`ed, `from_json`ed,
  refused if it is not a JSON object, the two owned keys are dropped and
  then `default-address-pools` / `bip` are `combine`d back on when
  non-empty — so an empty value removes the key, and every other operator
  key survives verbatim. Written with `to_nice_json`, `owner/group root`,
  `mode 0640`, `backup: true`.
- **Restart gate**: the write `notify`s `Restart docker`
  (`handlers/main.yml`), so dockerd restarts only on a real content change.
  A `debug` task announces it first. Existing containers keep their
  addresses and existing networks keep their subnets — pools only affect
  networks created afterwards.

### Docker gate (`docker-gate`)

Moved to `roles/docker-gate/AGENTS.md`. Included at the end of the `docker`
role and run by `daemon-converge.yml`; managed hosts with Docker only, observe
mode, never fatal in stage 1.

### RAPL sysfs (`rapl-access`)

Kernel RAPL `energy_uj` is **0400** (root-only). The daemon collector reads it
for CPU package watts and Intel iGPU PP1/`uncore` watts — file reads only, no
`CAP_PERFMON`. This role templates
`/etc/udev/rules.d/99-turbopanel-rapl.rules` (`chgrp` the daemon group +
`chmod g+r`, never world-readable) and applies the same grant to live
`/sys/class/powercap/*/energy_uj` on every converge. Wired into
`daemon-converge.yml`, `daemon-install.yml`, and `daemon-systemd-setup.yml`
(plus the dev overlay `instance-dev-install.yml`). Hosts without RAPL are a
no-op (`failed_when: false` on the live grant).

### TurboFabric (`server.fabric.reconcile`)

There is **no** Ansible WireGuard apply role. The daemon
(`src/commands/fabric.ts`) owns the org mesh on interface `tp0`:
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

Observed peers in the reconcile result carry `interface`: the local NIC whose
connected subnet holds the peer's live endpoint (`src/commands/fabric-peer-interface.ts`,
matched against the addresses `collectServerIps` already reports, so it starts
no process and changes no route). Absent means the endpoint is reached by the
default route. The control plane's traffic map compares it with the datacenter
it planned the endpoint from.

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

Vendored — **never** a distro package, and never compiled on the host (a
2-core build took over 10 minutes and timed the first deploy out). Apache
(httpd + bundled APR / APR-util) is built **once in CI** by
`.github/workflows/vendor-apache.yml` (`scripts/build-apache.sh`, native
x86_64 and arm64 runners, same configure flags) and published as the release
`vendor-apache-<httpdver>`: `apache-<httpdver>-<arch>.tar.gz` plus
`SHA256SUMS`. The role pins version, URL and per-arch SHA-256 in its defaults
(`apache_sha256`), asserts the digest like the caddy role (`get_url`
`checksum:`), unpacks into `{{ turbopanel_vendor_dir }}/apache/<version>`
(`creates:` on `bin/httpd` keeps it idempotent) and points `current` at that
tree. Only runtime libraries (`libexpat1`, `libpcre2-8-0`, `libssl3`) come from
apt. The role refuses to run while a digest is the `UNPINNED` placeholder: run
the workflow, then pin its checksums. A published release is never overwritten
(a rebuild changes the digest); to change the build, bump the version or use a
new release name. A release is never rebuilt on the host as a fallback. Main config is
`/etc/turbopanel/apache/httpd.conf` with `IncludeOptional …/sites/*.conf`
and loads `mod_proxy` + `mod_proxy_fcgi` for PHP. Driven by
**`turbopanel-apache.service`**, which runs the whole server, master
included, as `tpapache` (`User=`/`Group=` in the unit, none in
`httpd.conf`). Logs and the pidfile live in the unit's top-level
`LogsDirectory=turbopanel-apache` / `RuntimeDirectory=turbopanel-apache`
(`/var/log/turbopanel-apache`, `/run/turbopanel-apache`), never in the
`tp`-owned trees. A changed unit restarts a running server (`try-restart`);
a reload would keep the old master. The daemon's config test is
`sudo -n -u tpapache -- httpd -t -f /etc/turbopanel/apache/httpd.conf`,
pinned in sudoers. Main config includes a
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

**Deno** (`deno-app-runtime` role, `playbooks/deno-app-runtime-apply.yml`) vendors the
tenant Deno under `vendor/deno-app/<series>/current`, the way `node-app-runtime`
vendors Node: the newest stable release of the series from the official Deno
distribution (`dl.deno.land/release-latest.txt`, else the release list when the
series is no longer the newest), the archive checked against the release's
published SHA-256 before it is unpacked, group `tpdeno<series>`, gid in the
entitlement band. Deno ships one major, so the series is the major (`2`). The
playbook and its `deno_app_versions` extra-var are on `tp-orchestrate`'s
allowlists.

**Groups are per `(runtime, series)`** — `tpphp84`, `tpnode24`, `tpdeno2` — never one group
per runtime. Co-installed PHP versions are distinct binaries, so a single
`tpphp` would mean granting 8.4 also grants 8.3 with whatever CVEs another
tenant's pinned app carries. It is also what lets a shell wrapper resolve a
caller's series from its group list. One PHP group spans both flavors:
`tpphp84` owns `/usr/sbin/php-fpm8.4`, `/usr/bin/php8.4`, **and**
`vendor/lsphp/8.4/current/bin/lsphp` — "may execute PHP 8.4 here", whichever
engine serves the site.

gids are hand-assigned in the registry, never computed from the version string
(that breaks the day `8.10` exists). Band **9900–9979** is entitlements;
**9980–9999** is service identities (9994 stays reserved for `tpbuild`, the
retired shared build account; builds now run as per-build systemd
`DynamicUser=` identities). `../src/orchestration/service-accounts.test.ts`
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

### instance-launch control-plane TLS

Control-plane Caddy binds **exactly one TCP port**, `:8443`. It never binds
`:80` or `:443` and never runs Let's Encrypt (`auto_https off`). Hosting Caddy
owns public `:80`/`:443` for tenant sites and does **not** publish panel names.
`turbopanel_hostnames` is the list of `{host, source, cert_id}` the
`public-urls-update` wire renders. `uploaded` names are extra `:8443` sites
with `tls uploaded-<cert_id>.{crt,key}` (legacy empty `cert_id` uses
`uploaded.{crt,key}`). `lets-encrypt` names are extra `:8443` sites with
`tls letsencrypt-<host>.{crt,key}` under `turbopanel_instance_certs_dir`,
rendered **only when both files exist** (`letsencrypt-files.yml` stats them
before the template). The daemon installs each certificate as `root:tp`
mode `0640` and each key as `root:tp` mode `0600` through `sudo -n install`.
The cert directory is `tpctrl:tp` mode `0750`, so an unprivileged write from
`tp` cannot create the files, and a later handoff leaves the key owned by
`caddy_user` mode `0600`, which `tp` cannot read on the next copy.
`letsencrypt-files.yml` reassigns that key to `caddy_user` mode `0600` and
loads it with `openssl pkey` as that user before the hostname is marked
ready. Before that stat, it copies a validated pair out of the previous
control-plane store
(`<state>/caddy/.local/share/caddy/certificates/<issuer>/<host>/`) when the
named files are absent. The host list includes the deprecated
single-hostname alias: `resolve-hostnames.yml` synthesizes
`turbopanel_public_hostname` as `lets-encrypt` when `turbopanel_hostnames`
is empty and `turbopanel_tls_mode` is `lets_encrypt`. A converge therefore
keeps serving the leaf that control-plane Caddy already issued instead of
falling through to the Platform CA on `:8443`. Root-run `caddy validate` is
not that check. The first apply of a Let's Encrypt name that has no leaf
yet cannot fail Caddy validate or load: the bare `:8443` Platform CA site
stays the catch-all for IPs and other names. The managed
template binds literal `:8443`. `caddy_port` is only the dev overlay's
`CADDY_PORT` and does not move this listener. `turbopanel_tls_mode`,
`turbopanel_public_hostname`, and the single `uploaded.{crt,key}` pair stay
as deprecated aliases: an empty `turbopanel_hostnames` is synthesized from
them. The template's display-only mode is `upload` if any hostname is
uploaded, `lets_encrypt` if any is ACME, otherwise `self_signed`.

`instance-certs-apply` validates a candidate Caddyfile and reloads with
`caddy reload --address unix/<turbopanel_caddy_admin_socket> --force`
(default `unix//run/turbopanel/caddy/admin.sock`), so changed certificate
files are re-read even when the Caddyfile text is unchanged. The socket
directory is `caddy_user`:`caddy_primary_group` mode `0750`. This process
does not open a TCP admin port. A failed validate does not replace the live
file, so `:8443` stays up. `self-signed.{crt,key}` is a symlink to
`platform-ca.*` for one release. Named matchers in `(turbopanel_app)` are
unique across the snippet, including `handle_errors` — Caddy 2.11 rejects a
second `@api` (`matcher is defined more than once`) and the unit crash-loops.
`instance-launch` runs `caddy validate` on the rendered file so a bad
template fails the play instead of starting that loop.

Control-plane `XDG_DATA_HOME` is `{{ turbopanel_caddy_runtime_dir }}/share`
(`<state>/caddy/.local/share`). Hosting Caddy uses its own top-level
`StateDirectory=turbopanel-hosting-caddy` (`/var/lib/turbopanel-hosting-caddy`).
Those stores must not be the same directory.

### Hosting Caddy account (`hosting-caddy`)

`turbopanel-hosting-caddy.service` (public `:80`/`:443`, unit rendered by
`src/deploy/ingress.ts`, pinned by tp-host) runs as **`tpedge`** (uid/gid
9982), which is deliberately **not** in group `tp`: its only privilege is
`CAP_NET_BIND_SERVICE` (ambient and bounding), with `NoNewPrivileges=yes`.
Certificates, the ACME account, the internal CA and Caddy's autosave live in
the unit's `StateDirectory=turbopanel-hosting-caddy`, which systemd creates
owned by `tpedge`; the old root-written `<state>/hosting-caddy` store is
removed, not migrated (the internal CA and ACME account are recreated).
`caddy-setup.yml` runs this role after `caddy`; the daemon runs that playbook
whenever the binary **or** the account is missing (`ensureHostingCaddy`). The
role grants `tpedge` exactly what Caddy loads, as ACL entries for that one
user: traverse (`x`) on `/opt/turbopanel`, `vendor/` and `/etc/turbopanel`,
`rx` on the vendored binary, `rx` plus a default `rx` entry on
`/etc/turbopanel/hosting{,/sites}` (so every Caddyfile and snippet the daemon
writes is readable), and `r` on the files already there. `/etc/turbopanel/tls`
is `tp:tpedge` `2750`: the setgid bit gives every uploaded certificate the
`tpedge` group, and `materialize-tls.ts` writes the private key `0640` only
under that setgid directory (otherwise `0600`), so group `tp` never reads a
key. The daemon restarts the unit when its rendered content changes
(`enable --now` alone would keep the old process).

The control-plane Let's Encrypt window (co-located instance) proxies
HTTP-01 challenges to `unix/<run dir>/instance-acme.sock`. Connecting needs
`x` on `/run/turbopanel` (`tp:tp` `2770`) and `w` on the socket. The role
grants `tpedge` traverse only (`u:tpedge:x`, no listing, no default entry) on
the run directory, and because `/run` is tmpfs it also writes
`/etc/tmpfiles.d/turbopanel-hosting-caddy.conf` (`a+ … u:tpedge:x`) so the
entry returns at every boot. The socket is re-created on every bind, by the
daemon's preflight listener (as `tp`) or the issuer Caddy (as `tpcaddy`),
neither of which can name another user in an ACL, so the daemon then calls
`tp-host setfacl -P -m u:tpedge:rw <run dir>/instance-acme.sock`. That shape
accepts only that path and that entry, waits up to 5 s for the issuer to
bind, refuses a symlink, and never follows one (`-P`). `tpedge` is never put
in group `tp`. Residual: traverse lets `tpedge` open anything directly in
the run directory whose own mode grants "other" access (today the empty
`daemon.lock`, `0644`); no socket there is world-writable.

Vars (both roles; extra-vars win):

| Var | Purpose |
| --- | --- |
| `turbopanel_hostnames` | Per-hostname `{host, source, cert_id}` list |
| `turbopanel_hostnames_json` | Compact JSON of that list. `tp-orchestrate` accepts only `key=value` extra-vars, which stay strings, so public-urls apply passes this and `resolve-hostnames.yml` loads it with `from_json` into `turbopanel_hostnames` before `selectattr` and the Caddy template |
| `turbopanel_tls_mode` | Deprecated alias. Display-only once hostnames are set |
| `turbopanel_tls_cert_path` / `turbopanel_tls_key_path` | Legacy uploaded pair when `cert_id` is empty; copied to `uploaded.{crt,key}` |
| `turbopanel_public_hostname` / `turbopanel_acme_email` | Deprecated single ACME name, and the account email (no longer rendered into the Caddyfile) |
| `turbopanel_acme_directory` | ACME directory URL (no longer rendered as `acme_ca`; this process does not issue) |
| `turbopanel_tls_public` | Operator-declared publicly trusted leaf; forced true when any hostname is `lets-encrypt` |
| `turbopanel_public_urls` | Platform-ca hosts, comma-separated, for the leaf generator. Co-located public-urls apply also merges `/etc/turbopanel/dev-forward-hosts` so the Vagrant host LAN address stays on the leaf. When hostname rows are already set, `resolve-hostnames.yml` keeps those extra tokens and does not add them as hostname rows |
| `turbopanel_letsencrypt_ready` | List of Let's Encrypt hostnames whose `letsencrypt-<host>.{crt,key}` files exist; set by `letsencrypt-files.yml` after each key is `caddy_user` mode `0600` and that user can load it |
| `caddy_user` | Control-plane Caddy account (`tpcaddy` when `turbopanel_dev_user` is empty). Let's Encrypt keys are chowned to it |
| `turbopanel_caddy_admin_socket` | Unix socket for the managed admin API (`<run dir>/caddy/admin.sock`). Not a TCP port. The dev overlay does not use it |

`turbopanel_caddyfile` is the dev overlay (`<dev root>/dev/orchestration/Caddyfile`)
when `turbopanel_dev_user` is set; otherwise it is
`{{ turbopanel_config_dir }}/caddy/Caddyfile`, which `instance-launch`
**renders** from `templates/Caddyfile.j2` on every converge (root:tp `0640`,
"Render the Caddy site config", notifies a Caddy restart). Ports and leaf
paths are baked in at render time — no Caddy env placeholders, no static site
config in the instance release package. The unit does not grant
`CAP_NET_BIND_SERVICE`. Updating the proxy config is a template edit plus a
converge, never a hand edit of the rendered file.

**Managed install layout.** The instance package lies flat in the install
root beside the daemon — `bin/turbopanel` and `lib/libduckdb.so` (the unit's
`LD_LIBRARY_PATH` is `lib/`; email runs in-process, so there is no separate
mailer binary). The UI lands under `share/ui`. There is no nested instance
tree: `turbopanel_instance_dir` on a managed host is the install root itself
(units' `WorkingDirectory`, the cert generator's chdir), and both
`instance-launch` and `instance-certs` default `turbopanel_instance_run_mode`
to `compiled` whenever `turbopanel_dev_user` is empty, so
`instance-certs-apply.yml` (run by the daemon with defaults only) resolves
the binary's own `generate-self-signed-cert` verb.
`instance-deno.env.j2` emits `TURBOPANEL_TLS_PUBLIC=1` when the effective flag
is true — not the Workers env template, and not a per-upload boolean. Uploaded
public trust is whether the dialed certificate chains to a public root. The
catch-all leaf SANs include platform-ca hosts, operator extra SANs, and the
machine name, so an unlisted install name on `:8443` can still match.

A `lets-encrypt` hostname is managed-install only (`turbopanel_dev_user` must
be empty). Control-plane Caddy presents `letsencrypt-<host>.{crt,key}` on
`:8443` once those files exist. It does not solve HTTP-01. The daemon opens
a short window on hosting Caddy: `00-instance-acme-http01.caddy` forwards
only `/.well-known/acme-challenge/*` to `unix/<run dir>/instance-acme.sock`
and answers every other path with 404. A separate unit,
`turbopanel-instance-acme.service`, is installed and left disabled. The
daemon starts it for the issuance and stops it when the leaf is copied.
`WorkingDirectory` is prefixed with `-` because systemd chdirs before
`ExecStartPre`, and that directory is created by the first `ExecStartPre`
(`install -d`). A hard path fails the start job with status `200/CHDIR`
before `install` runs.
A certificate already inside the renewal window (about the last third of
its lifetime, `renewal_window_ratio` `0.33`) is copied only after the issuer
storage holds a different, currently valid leaf. An unchanged leaf is
accepted only when it is not due. An expired leaf is due. The issuer's
`XDG_DATA_HOME` is `<state>/instance-acme`, not hosting Caddy's store
and not control-plane Caddy's store. JSON logs go to
`/var/log/turbopanel/instance-acme.log`. If the sites directory then holds
only daemon-reserved files, the daemon disables hosting Caddy.

**Issuer proof (Caddy 2.11.4, Let's Encrypt staging, Vagrant guest, 2026-09-23).**
The guest's public port 80 is the site router, so staging cannot fetch that
address directly. A Cloudflare quick tunnel
(`cloudflared tunnel --no-autoupdate --url http://127.0.0.1:80`) supplied a
reachable hostname. Caddy 2.11.4 (`caddy_2.11.4_linux_amd64.tar.gz`, sha256
`527fbf917c39189a1e3b31d34fa955601680b2d5c8055d2a87b8b9588dec7bb9`) ran two
processes:

1. A forwarder on port 80 whose site was `http://<tunnel host>` and whose
   only challenge handler was `reverse_proxy unix/<run>/instance-acme.sock`
   with `header_up Host {http.request.host}`.
2. The issuer JSON: `admin.disabled`, an HTTP server on `unix/<sock>` with
   `automatic_https.disable`, `tls.certificates.automate` for that hostname,
   `challenges.tls-alpn.disabled`, staging directory
   `https://acme-staging-v02.api.letsencrypt.org/directory`, and
   `renewal_window_ratio` `0.33`.

The first start stored
`certificates/acme-staging-v02.api.letsencrypt.org-directory/<host>/<host>.crt`.
`ss -ltnp` for that process listed no TCP socket, only the unix socket. The
leaf was `notBefore=Sep 23 18:39:00 2026 GMT` and
`notAfter=Dec 22 18:38:59 2026 GMT` (about 90 days). A ratio of `0.99` does
not make a seconds-old leaf due: the window opens after one percent of the
lifetime. Setting `renewal_window_ratio` to `1` makes the window the whole
lifetime, so that stored leaf was already inside it (`remaining` about
7772484 seconds). Starting the issuer again logged `renewing certificate`
and then `certificate renewed successfully`, replaced the stored leaf
(sha256 fingerprint changed), and again bound no TCP port.
`challenges.bind_host` set to the socket path does not work: certmagic calls
`listen tcp` on `unix//path:80` and fails with `no such host`. Leave
`bind_host` unset so the solver targets port 80. When the forwarder already
holds that port, certmagic does not bind it and the socket server answers.
The loopback `bind_host` plus `alternate_port` fallback was not required.

`instance-certs-apply` asks the running control-plane process to load the
candidate through `turbopanel_caddy_admin_socket` with `--address` and
`--force`, and replaces the persistent Caddyfile only after that process
accepts it. A rejected reload leaves the live file in place. A cold start
restores the previous file when the new process does not stay up. `:8443`
stays up either way. Wildcards are upload-only: the stock Caddy binary
speaks HTTP-01, and DNS-01 needs a provider module that build does not
include.

### instance-launch systemd sandbox

`turbopanel-instance.service.j2` sandboxes the **production compiled** instance
(`turbopanel_dev_user` empty): `ProtectSystem=strict` + `ReadWritePaths`
(run dir, state, metrics, runtime/config dirs, instance log dir, plus
`/run/sudo`, `/var/lib/sudo`, `/run/faillock` for the root children of
`sudo pamtester`), `ProtectHome`, `PrivateTmp`, `PrivateDevices`,
`ProtectKernel*`/`ProtectControlGroups`/`ProtectClock`/`ProtectHostname`,
`RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK`,
`RestrictNamespaces/Realtime/SUIDSGID`, `LockPersonality`, and a deny-list
`CapabilityBoundingSet`. Left out on purpose: `NoNewPrivileges` (the instance
still runs `sudo`; see `tasks/upgrade-sudoers.yml`), `MemoryDenyWriteExecute`
(V8), `SystemCallFilter` and a positive capability set (the sudo targets run as
root and are unproven under them). Rollback: delete the sandbox block and
converge (`instance-launch`); no data is touched.
`src/orchestration/instance-unit-sandbox.test.ts` renders the unit and pins all
of it. `scripts/canary-instance-sandbox-proof.sh` is the on-host proof.

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

This keyring is the sole root of trust and this file is its only copy —
losing it is permanent, total data loss. Off-host backup is opt-in via
`turbopanel_instance_secret_escrow_path` (default `""`, skips entirely): when
set to a path *on the machine running the playbook* (never on the target
host), `ansible.builtin.fetch` pulls a fresh copy there on every converge,
including after a rotation. No Ansible Vault or other encryption is applied
to the fetched copy — the operator is responsible for the security of the
destination, the same trust model the `.instance_secrets` file itself
already has. `security.mdx` documents this for self-hosted operators and
covers the hosted (Workers) side separately, where `wrangler secret put` is
write-only and there is no equivalent automatable backup.

**Workers dev runtime extras (instance-launch):** `turbopanel-instance-cron.timer`
hits wrangler's local scheduled-trigger endpoint every minute, because
`wrangler dev` never fires the Worker's cron; the units are installed only when
`turbopanel_instance_runtime == 'workers'` and removed otherwise. The Workers
dev vars also carry Stripe from two by-hand files under the instance config dir
(`.stripe_secret_key`, `.stripe_webhook_signing_secret`) so a re-converge keeps
them. `system-compose` re-applies a changed Compose file to the running stack
(`docker compose up -d --remove-orphans`) — the stack unit is a oneshot, so
`state: started` alone never reached Docker and the runtime switch used to die
on a closed Postgres port.

---


### System services Compose stack (`system-compose`)

Moved to `roles/system-compose/AGENTS.md`.
