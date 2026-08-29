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
| `/etc/turbopanel/openlitespeed/` | `root:tpols` | `0750` | `httpd_config.conf` (daemon-owned, regenerated whole on every apply — no `sites-enabled` convention) + `mime.properties` + per-site fragments (`sites/`) + per-vhost `vhconf.conf` (`vhosts/<name>/`) |
| `/var/log/turbopanel/openlitespeed/` | `tpols:tpols` | `0750` | `error.log` / `access.log` |
| `/var/lib/turbopanel/openlitespeed/` | `tpols:tpols` | `0750` | PID file (`lshttpd.pid`), `swap/` (`swappingDir`) |
| `{{ turbopanel_vendor_dir }}/openlitespeed/<version>/{cachedata,autoupdate,tmp,tmp/ocspcache}` | `tpols:tpols` | `0750` | OLS's own writable runtime dirs, kept inside the vendored tree since the binary resolves paths relative to its own `bin/` |

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
| `{{ turbopanel_vendor_dir }}/lsphp/<series>/<version>/` | `root:tp` | `0750` | extracted `bin/lsphp` + `lib/` extensions |
| `{{ turbopanel_vendor_dir }}/lsphp/<series>/current` | symlink | — | what generated `extprocessor path` lines point at |
| `{{ turbopanel_vendor_dir }}/openlitespeed/<version>/tmp/lshttpd/` | `tpols:tpols` | `0750` | `uds://tmp/lshttpd/<name>.sock` LSAPI sockets |

`openlitespeed_lsphp_series_map` carries per-series package data (version,
package basename, deb version) because a series needs more than a version string
to build its `.deb` URL. `lsphp` and `php-fpm` are different binaries from
different sources, but a series string means the same thing to both, and one
entitlement group (`tpphp<series>`) covers whichever engine serves the site. Hosting `web.php` hints land in the vhost's `phpIniOverride{}` block as
`php_admin_value <key> <value>` — the OLS spelling of what an FPM pool writes as
`php_admin_value[<key>] = <value>`.

