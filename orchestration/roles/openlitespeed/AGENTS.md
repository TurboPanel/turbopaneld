# OpenLiteSpeed role (`openlitespeed`) — AGENTS.md

Ansible role for TurboPanel orchestration. Shared conventions: `../../AGENTS.md`.

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
| `/etc/turbopanel/openlitespeed/` | `root:tpols` (whole tree, re-applied on every converge) | `0750` | `httpd_config.conf` (daemon-owned, regenerated whole on every apply — no `sites-enabled` convention) + `mime.properties` (shipped in `files/`, from the v1.9.1 release) + per-site fragments (`sites/`) + per-vhost `vhconf.conf` (`vhosts/<name>/`) |
| `/var/log/turbopanel/openlitespeed/` | `tpols:tpols` | `0750` | `error.log` / `access.log` |
| `/var/lib/turbopanel/openlitespeed/` | `tpols:tpols` | `0750` | PID file (`lshttpd.pid`), `swap/` (`swappingDir`) |
| `{{ turbopanel_vendor_dir }}/openlitespeed/<version>/{cachedata,autoupdate,tmp,tmp/ocspcache}` | `tpols:tpols` | `0750` | OLS's own writable runtime dirs, kept inside the vendored tree since the binary resolves paths relative to its own `bin/` |
| `/run/turbopanel-ols/` | `tpols:tpols` | `0750` | LSAPI sockets; the unit's `RuntimeDirectory` (the role also creates it for an already-running server) |

Everything above is ensured on **every** converge, not only on first install: a
host upgraded over an older vendored tree skips the install block. Installs used to
chown the whole `/etc/turbopanel` to `tp:tp`; `daemon-install.yml` now skips the
engine trees (`turbopanel_engine_config_dirs`), and the role still puts the
OpenLiteSpeed config tree back to `root:tpols` on hosts that were already
flipped (owner and group only — the daemon sets each file's mode through
tp-host).

Identity comes from `web-service-user` (`tpols`, uid/gid **9990** — see the
table above); the **`site-openlitespeed-apply`** playbook
`include_role`s `web-service-user` (key `openlitespeed`) before `openlitespeed`
itself, mirroring `site-apache-apply`. Daemon-side config
generation (per-site `virtualHost`/`listener` fragments aggregated into the
single `httpd_config.conf`, `vhconf.conf` per vhost) lives in
`../src/deploy/site.ts` — see `../src/deploy/site/AGENTS.md`.

### `lsphp` (LSAPI PHP)

OpenLiteSpeed does **not** use php-fpm. Its PHP model is a per-vhost LSAPI
external processor: each vhost execs its own `lsphp` under suEXEC
(`extUser`/`extGroup` = the site principal, else `tpols`), so the process is the
isolation boundary rather than a shared pool. The role vendors it only when the
daemon passes `turbopanel_lsphp_install: true` — a static-only host never
downloads a PHP interpreter.

Same vendoring discipline as everything else here: the pinned
`lsphp<pkg-series>` Debian packages are pulled from litespeedtech's own pool
(`openlitespeed_lsphp_repo_base`) and extracted with `dpkg-deb -x` — **never**
`apt install lsphp*` (which would add their apt repo) and never the vendor
`install.sh`. Layout follows the `vendor/<tool>/<version>/` + `current`
convention, with the series as an extra level so a patch bump never changes a
generated vhost:

| Path | Owner | Mode | Purpose |
| ---- | ----- | ---- | ------- |
| `{{ turbopanel_vendor_dir }}/lsphp/<series>/<version>/` | `root:tpphp<series>` | `0750` | extracted `bin/lsphp` + `lib/` extensions; `bin/php.ini` (relocated config, below) |
| `{{ turbopanel_vendor_dir }}/lsphp/<series>/current` | symlink | — | what generated `extprocessor path` lines point at |

`openlitespeed_lsphp_series_map` carries per-series package data (version,
package list, which packages are `_all`) because a series needs more than a
version string to build its `.deb` URLs. Packages come from
`pool/main/<suite>/`, where the suite is the host's Debian release (a bookworm
build links `libzip.so.4`, which trixie lacks); every `.deb` is fetched with
`get_url` against its sha256 in `openlitespeed_lsphp_sha256` (from the suite's
`dists/<suite>/main/binary-<arch>/Packages`). `dpkg-deb -x` resolves no
dependencies, so `openlitespeed_lsphp_runtime_packages[<suite>]` lists the
shared libraries from the packages' `Depends:` and the role installs them on
every converge. The binary was built for `/usr/local/lsws/<pkg>/`, so its
compiled php.ini and extension paths do not exist here: the role writes
`bin/php.ini` from `php.ini-production` plus `extension_dir` and the shipped
extensions (PHP also reads php.ini next to its executable, so the vhosts need
no flag), then runs `lsphp -i` and fails unless that file is loaded with
OPcache and mysqli. `lsphp` and `php-fpm` are different binaries from
different sources, but a series string means the same thing to both, and one
entitlement group (`tpphp<series>`) covers whichever engine serves the site. Hosting `web.php` hints land in the vhost's `phpIniOverride{}` block as
`php_admin_value <key> <value>` — the OLS spelling of what an FPM pool writes as
`php_admin_value[<key>] = <value>`.

