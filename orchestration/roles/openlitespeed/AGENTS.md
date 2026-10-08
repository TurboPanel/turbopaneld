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

Everything above is ensured on **every** converge, not only on first install: a
host upgraded over an older vendored tree skips the install block. Nothing re-owns
`/etc/turbopanel` recursively any more (`daemon-install.yml` has no find/chown
pass, P1-1): the role pins the three config folders and `tp-host` writes every
file in them as `root:tpols`.

Identity comes from `web-service-user` (`tpols`, uid/gid **9990** — see the
table above); the **`site-openlitespeed-apply`** playbook
`include_role`s `web-service-user` (key `openlitespeed`) before `openlitespeed`
itself, mirroring `site-apache-apply`. Daemon-side config
generation (per-site `virtualHost`/`listener` fragments aggregated into the
single `httpd_config.conf`, `vhconf.conf` per vhost) lives in
`../src/deploy/site.ts` — see `../src/deploy/site/AGENTS.md`.

### `lsphp` (LSAPI PHP)

OpenLiteSpeed runs as `tpols` and cannot switch users, so it never starts PHP
itself. Each PHP site runs its own runtime as the site owner, from systemd
(`turbopanel-php-<id>`, `src/deploy/site/php-runtime.ts`), and the vhost's
`extprocessor` connects to its socket with `autoStart 0`: `fcgi` for FastCGI
and php-fpm (the packaged binaries, from the `php-fpm` role, which
`site-openlitespeed-apply` includes on `turbopanel_php_fpm_install`), `lsapi`
for detached lsphp (this vendored `lsphp` on a systemd socket). Attached lsphp
(OpenLiteSpeed starting it through a setuid launcher) is not offered yet. The
role vendors lsphp only when the daemon passes `turbopanel_lsphp_install: true`
— a static-only host never downloads a PHP interpreter.

Same vendoring discipline as everything else here: the pinned
`lsphp<pkg-series>` Debian packages are pulled from litespeedtech's own pool
(`openlitespeed_lsphp_repo_base`) and extracted with `dpkg-deb -x` — **never**
`apt install lsphp*` (which would add their apt repo) and never the vendor
`install.sh`. Layout follows the `vendor/<tool>/<version>/` + `current`
convention, with the series as an extra level so a patch bump never changes a
generated vhost:

| Path | Owner | Mode | Purpose |
| ---- | ----- | ---- | ------- |
| `{{ turbopanel_vendor_dir }}/lsphp/<series>/<version>/` | `root:root` | not group/world writable; `other:rX` ACL (readable by everyone) | extracted `bin/lsphp` + `lib/` extensions; `bin/php.ini` (relocated config, below) |
| `{{ turbopanel_vendor_dir }}/lsphp/<series>/current` | symlink | — | what the per-site units' `ExecStart=` points at |
| `{{ turbopanel_vendor_dir }}/lsphp/<series>/<version>/lib/php/ext` | symlink | — | `lib/php/<api>/`: the stable `extension_dir` a per-site php.ini names |

Which series the role may be asked for follows the registry's `suiteSeries`
table (Debian 13: 8.1 to 8.5): `src/orchestration/php-series-pins.test.ts` fails
a suite that lists a series without a pinned, digested package set for it. PHP
8.5 compiles opcache in, so its set has no `lsphp85-opcache` and the relocated
php.ini does not load `opcache.so` (`builtinExtensions` in the registry).

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
extensions (PHP also reads php.ini next to its executable), then runs
`lsphp -i` and fails unless that file is loaded with OPcache and mysqli. A
per-site runtime sets `PHPRC` to its own php.ini, which replaces that file, so
its ini repeats `extension_dir` (through `lib/php/ext`) and the module lines;
tp-host allows only `curl`, `mysqli` and `pdo_mysql` there. `lsphp` and `php-fpm` are different binaries from
different sources, but a series string means the same thing to both, and every
site owner's Linux user may run every installed series, whichever engine serves
the site. Hosting `web.php` hints land in the per-site runtime's php.ini.

