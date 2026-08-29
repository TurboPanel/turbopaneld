# Web-service user role (`web-service-user`) — AGENTS.md

Ansible role for TurboPanel orchestration. Shared conventions: `../../AGENTS.md`.

Tenant/daemon-host web servers (nginx, Apache, OpenLiteSpeed, LiteSpeed enterprise) run under dedicated **99xx** system accounts — distinct from control-plane **tpcaddy(9993)**. The `web-service-user` role provisions **only** the group + system user (no package install). **Not** wired into `daemon-converge.yml`; site apply playbooks `include_role` it on demand when a site is deployed, then vendor the matching engine role.

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
| nginx | `site-nginx-apply.yml` | `nginx` (+ `php-fpm` when PHP) | `turbopanel-nginx` (+ `turbopanel-php-fpm`) |
| apache | `site-apache-apply.yml` | `apache` (+ `php-fpm` when PHP) | `turbopanel-apache` (+ `turbopanel-php-fpm`) |
| openlitespeed | `site-openlitespeed-apply.yml` | `openlitespeed` (+ vendored `lsphp` when PHP) | `turbopanel-openlitespeed` |

**PHP is available on all three engines, by two different mechanisms.** nginx
and Apache share the `php-fpm` role: each site gets its own pool, reached over a
unix socket (`fastcgi_pass` / `mod_proxy_fcgi`). Both apply playbooks include
that role on `turbopanel_php_fpm_install: true`, so an **nginx-only** host with
PHP installs php-fpm from `site-nginx-apply.yml` — the Apache playbook never
runs there. OpenLiteSpeed does not use php-fpm at all: its `openlitespeed` role
vendors `lsphp` on `turbopanel_lsphp_install: true`, and each vhost execs its
own LSAPI process under suEXEC. **Several PHP series co-install**: the daemon
passes the distinct series a deploy declared (`php_fpm_versions` /
`openlitespeed_lsphp_versions`), each php-fpm series runs as its own
`turbopanel-php-fpm@<series>` instance, and both roles are additive — they never
remove a series they were not asked about.

Site fragments live under `/etc/turbopanel/{nginx,apache,openlitespeed}/sites/`
(and php-fpm pools under `/etc/turbopanel/php/pools/`) — daemon TypeScript owns
the file contents (see `../src/deploy/site.ts` /
`../src/deploy/site/AGENTS.md`). Leftover distro `nginx` / `apache2` units, and
php-fpm units from any series other than the pinned one, are stopped/disabled
when the roles run so they cannot steal ports or config. The pinned series'
own sury unit is masked rather than disabled — see `../php-fpm/AGENTS.md`.

