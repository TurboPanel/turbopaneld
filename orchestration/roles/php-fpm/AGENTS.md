# php-fpm role (`php-fpm`) — AGENTS.md

Ansible role for TurboPanel orchestration. Shared conventions: `../../AGENTS.md`.

**The one component TurboPanel does not vendor.** php-fpm and its extensions
come from **Ondřej Surý's Debian repo** (`packages.sury.org/php`) — the upstream
Debian's own PHP packages descend from, and the only source shipping
co-installable `phpX.Y-*` builds with the whole extension set maintained against
CVEs. Vendoring an interpreter with two dozen extension libraries means owning
that CVE surface by hand; vendoring a supervised daemon (nginx / Apache /
OpenLiteSpeed / Caddy) does not. Note this is a *deliberate exception* — do not
"fix" it back to a source build, and do not generalize it to the other engines.
`libapache2-mod-php` is still never installed; Apache reaches FPM over
mod_proxy_fcgi. **OpenLiteSpeed's `lsphp` is unaffected** and still vendors from
`rpms.litespeedtech.com` (see below).

The repo is wired the current way — a packaged trust root
(`debsuryorg-archive-keyring.deb`) plus a deb822
`/etc/apt/sources.list.d/sury-php.sources` with an explicit `Signed-By`. No
`apt-key`, no `[signed-by=]` one-liner; both are deprecated. **Sury cannot be
cleanly removed once enabled** — it also ships replacement builds of libraries
such as OpenSSL, so dropping the repo breaks the PHP install. Treat it as
permanent on any host that ever serves PHP.

`php_fpm_series` (`8.4`) drives every package name. `php_fpm_apt_version` is an
optional exact apt pin; empty means "latest in the series". Extension packages
split into `php_fpm_baseline_extensions` (always installed, parity with the flags the previous
source build compiled in.

**Extensions resolve by union, per series.** The daemon passes
`php_fpm_extensions` as `{"8.4": ["intl","redis"]}` — the union of what every
site on that series opted into — and the role installs baseline ∪ requested.
There is no per-pool extension loading (`extension=` is `PHP_INI_SYSTEM`,
sury registers them in `/etc/php/<series>/mods-available`, and `dl()` is dead),
so **one site opting in loads it for every other site on that series**. Say so
in operator-facing copy; it is the honest constraint and exactly why the
allowlist in `runtime-registry.json` is closed. Installing one needs a
*restart*, not the daemon's USR2 pool reload — which drops in-flight requests
for every site on that series.

**TurboPanel still owns the runtime.** Sury's `php8.4-fpm.service` is
`masked` — not merely disabled, because an apt upgrade re-enables a disabled
unit — and `turbopanel-php-fpm.service` runs sury's `/usr/sbin/php-fpm8.4`
against **our** `php-fpm.conf` and **our** pool directory. Every path daemon
TypeScript writes to is therefore unchanged from the source-build era.

Two seams exist only because the interpreter is now packaged:

- **`PHP_INI_SCAN_DIR=:/etc/turbopanel/php/conf.d`** in the unit. The leading
  colon keeps the compiled-in scan dir (`/etc/php/8.4/fpm/conf.d`, where sury
  registers every extension) and appends ours after it, so
  `99-turbopanel.ini` overrides sury's defaults without unloading a single
  extension. **Drop the colon and the interpreter starts with no extensions.**
  That overlay must never re-declare `zend_extension = opcache` — sury's
  `10-opcache.ini` already loads it and a second load aborts startup.
- **`dpkg-statoverride`**, not a `file:` chmod, restricts
  `/usr/sbin/php-fpm8.4` and `/usr/bin/php8.4` to `root:tp` `0750`. A plain
  chmod is reset by every `php8.4-*` upgrade; statoverride survives it. Without
  this, a tenant principal with a shell could run PHP outside its own FPM pool.

FHS layout:

| Path | Owner | Mode | Purpose |
| ---- | ----- | ---- | ------- |
| `/etc/turbopanel/php/` | `root:tpapache` | `0750` | `php-fpm.conf`, `conf.d/99-turbopanel.ini`, per-site `pools/*.conf` |
| `/var/log/turbopanel/php/` | `tpapache:tpapache` | `0750` | `php-fpm.log` / `php-error.log` |
| `/run/turbopanel/php/` | `tpapache:tp` | `0750` | pidfile + unix sockets |

Driven by **`turbopanel-php-fpm.service`**. The FPM master, its bootstrap pool,
and the FHS config/log dirs are owned by **tpapache** (provisioned by
`web-service-user` before this role) — that stays true on an nginx-only host,
which is why `site-nginx-apply.yml` provisions the `apache` identity before
including this role. **Per-site** pools override that: workers run as the site
principal, and the listen socket is owned by whichever engine consumes it
(`tpapache` for an Apache site, `tpnginx` for an nginx one). `/run/turbopanel/php/`
is therefore grouped to **`tp`**, not `tpapache` — `tp` is the shared group every
engine account joins (`web-service-user`), so `0750` is traversable by both
engines with no world bit. The master runs as root and creates the sockets;
access control is on the sockets themselves (`0660`, per-engine owner). The
unit's `ExecStartPre=/usr/bin/install -d` recreates this directory on every
start and must stay in step with the role task.

Both `site-nginx-apply` (nginx) and `site-apache-apply` include
this role when the daemon passes `turbopanel_php_fpm_install: true` (that
engine has a site with `web.php` hints). Daemon TypeScript writes per-site pools
and reloads the unit **before** either engine, so `fastcgi_pass unix:…` /
`proxy:unix:…|fcgi://localhost/` sockets exist when the engine config-tests. One
series per host (multi-version side-by-side is a future seam); OpenLiteSpeed
sites do not appear here at all — see `../openlitespeed/AGENTS.md` (**lsphp**).

