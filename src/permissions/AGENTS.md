# Managed-Host Privilege Boundary — AGENTS.md

Daemon repo context: `../../AGENTS.md`. Cross-repo `../<repo>/…` links are relative to the repo root.

## Managed-host privilege boundary (2026-09-19 hardening, sudo 2026-09-25)

**What this boundary does not contain yet — read first.** The daemon account
`tp` is still root-equivalent on a managed host, through three paths the
controls below do not close:

1. **Docker.** The `docker` role adds `tp` to the `docker` group, and Docker
   socket access is root (`docker run -v /:/h`). There is no sudo grant for
   Docker any more; the group is the residual. Closing it is under way with an
   authorizing proxy in front of the socket: **stages 1-3 are installed** (the
   root-owned `turbopanel-docker-gate` service, observe mode: it forwards
   everything and logs what the strict profile would refuse, with a platform
   allowance, ownership observation and a signed-approval verifier; plus a
   read-only listener Traefik can use instead of the Tecnativa socket proxy
   behind a per-host switch, off by default; nothing of the daemon's own is
   routed through it yet and `tp` is still in the group) — see
   `orchestration/roles/docker-gate/AGENTS.md` for the stages.
2. **Closed: the hosting Caddy no longer runs as root.**
   `turbopanel-hosting-caddy.service` runs as `tpedge` (not in group `tp`)
   with `AmbientCapabilities=`/`CapabilityBoundingSet=CAP_NET_BIND_SERVICE`
   and `NoNewPrivileges=yes`, its certificates in the nested
   `StateDirectory=turbopanel/hosting-caddy` (`/var/lib/turbopanel/hosting-caddy`). tp-host refuses the unit in any
   other shape. Its Caddyfile is still `tp`-written (`/etc/turbopanel/hosting`,
   read through a per-user ACL), so a hostile config now lands as `tpedge`,
   not root; `stripPrefix` and the other inputs still need validation.
3. **php-fpm's config test runs as root** — `php-fpm<x.y> --fpm-config
   /etc/turbopanel/php/<x.y>/php-fpm.conf --test` (`TP_ENGINE_VALIDATE`,
   pinned to exactly that file). `/etc/turbopanel` is `tp`-owned, so `tp`
   can replace it, and php-fpm loads extensions while testing. Apache's
   `httpd -t` no longer does: it runs as `tpapache` (pinned arguments, no
   `env`), and `turbopanel-apache.service` runs its master as `tpapache`.
4. **Engine-account config tests load configs `tp` writes.** `tp` may run
   exactly one command as each of `tpnginx`, `tpols` and `tpcaddysite`: that
   engine's config test with the binary (`<vendor>/<engine>/current/…`), every
   argument and the main config path pinned (`TP_NGINX_VALIDATE`,
   `TP_OLS_VALIDATE`, `TP_CADDY_VALIDATE`; no `env`, no wildcard — audit
   P2-8, pinned by `src/orchestration/sudoers-contract.test.ts`). The config
   those tests parse is still daemon-written, so a config `tp` installs
   (e.g. nginx `load_module`) runs as the engine account — no more than the
   running service already does after a reload.

The controls below remove every direct root escape through sudo and keep a
daemon bug or an injected argument from reaching arbitrary host paths,
units, accounts or root Ansible. Each has a test that fails the build when
it regresses:

- **Deno grants** — `src/permissions/daemon-permissions.ts` is the one definition of what
  the production daemon may read/write/run; `renderDaemonPermissionFlags()`
  is copied verbatim into the three `compile*` tasks in `deno.json` and the
  JS-fallback `ExecStart` in `daemon-launch/templates/turbopaneld.service.j2`,
  and `renderInstallerPermissionFlags()` into `TP_INSTALLER_DENO_PERMISSIONS`
  in `scripts/run.sh` (the root-run `bootstrap-orchestration` /
  `run-installer` verbs). `src/permissions/daemon-permissions.test.ts` pins every copy,
  refuses `--allow-all` and any bare `--allow-read/write/run/ffi/sys`, and
  derives the `--allow-run` set from every literal `Deno.Command` / `run(…)`
  target in `src/` — add a new spawn target there or the test fails. The
  compiled binary is also the **installer**: `run.sh` runs the root-only
  `bootstrap-orchestration` / `run-installer` verbs through it on hosts where
  it executes, and `deno compile` bakes one grant set the binary cannot widen
  at runtime (the JS fallback gets `renderInstallerPermissionFlags()`; the
  native binary cannot). The daemon write grant therefore also carries
  `INSTALLER_VENDOR_DIRS` (`vendor/uv`, `vendor/python`, `vendor/ansible`) —
  inert at daemon runtime because those trees are `root:tp 0750` and the
  process is `tp` — and the test maps every orchestration bootstrap write
  target (`UV_INSTALL_DIR`, `PYTHON_RUNTIME_DIR`, `ANSIBLE_INSTALL_DIR`, the
  Galaxy dirs, the stamps) onto that grant, which is what the first canary
  install after this hardening tripped over (`Requires write access to
  "/opt/turbopanel/vendor/uv/<version>"`). One
  grant stays unscoped and is documented in `DAEMON_UNSCOPED_GRANTS`:
  `--allow-net` (operator-configured control-plane origin, ACME probes to
  tenant domains, container-address scrapes, ProxySQL bind — Deno has no
  wildcard/CIDR host grant) paired with `--deny-net` for the cloud metadata
  endpoints. Env is scoped to `DAEMON_ENV_NAMES` (`TURBOPANEL_*`, `HOME`,
  `PATH`, `USER`, `LOGNAME`) plus a bare `--ignore-env`, which turns a read of
  any other name into `undefined` and lets `Deno.env.toObject()` return just
  the allowed names (without it Deno refuses `toObject()` under a scoped
  grant). `src/permissions/env-allowlist.test.ts` scans `src/` and fails on a
  read the list does not cover — add the name there, never go back to a bare
  `--allow-env`. Bumping
  `UV_VERSION` / `ANSIBLE_CORE_VERSION` / `CLOUDFLARED_VERSION` changes the
  rendered `--allow-run` paths: re-render (see the test failure) and commit
  all copies. The compile tasks pass `--quiet` so the binary does not print an
  `Info Failed to resolve '<tool>' for allow-run` line for every listed tool the
  host lacks; errors still print and the allow-run list is unchanged. NVML is opened by absolute path first (`NVML_LIBRARY_CANDIDATES`)
  because a scoped `--allow-ffi` resolves bare names against the cwd.
- **Two writes `--allow-write` never covers** — `src/permissions/scoped-writes.ts`.
  Deno refuses *every* write (`writeFile`, `copyFile`, `chmod`, `rename`,
  `remove`) to a path on the **`--allow-run`** allowlist, so uv, uvx, and
  cloudflared — run targets that the binary-as-installer also has to install —
  go through `installVendorExecutable` (`cp` + `chmod`). And **`Deno.symlink()`
  requires *unscoped* read and write**: a link's target is only resolved on
  traversal, so no path-scoped grant covers it however wide, and every
  `current` link — vendor runtimes, release promote, railpack, hosting Caddy —
  goes through `createSymlink` (`ln -sfn`). Neither is reported at compile
  time: the first broke the first canary install after this hardening, the
  second silently skipped every vendor `current` symlink on the same run.
  `cp` / `chmod` / `ln` are therefore on both run allowlists, and
  `src/permissions/scoped-writes.test.ts` reproduces both refusals in a child process with
  production-shaped grants and fails on a new `Deno.symlink(` anywhere in
  `src/`. A helper that fails throws **`ScopedWriteError`**, which is the
  subprocess counterpart of `PermissionDenied`: privilege ladders that retry
  under `sudo` (`release/promote.ts`) must treat both as "the unprivileged
  attempt could not do it" — `Deno.symlink`'s own refusal is `NotCapable`, so
  catching `PermissionDenied` alone silently skipped the sudo tier.
- **Install root ownership** — `/opt/turbopanel`, `bin/`, `lib/`, `share/`,
  `share/orchestration` and every vendored runtime are `root:tp 0750`
  (`turbopanel-user`, `daemon-layout`); `daemon-install.yml` no longer chowns
  the vendor or orchestration trees to `tp`. The daemon can write only
  `DAEMON_WRITABLE_VENDOR_DIRS` (`vendor/uv/cache`, `vendor/cloudflared`) plus
  the FHS state/config/log/run/backup trees — ownership, not the Deno grant,
  is the boundary here (the grant also names `INSTALLER_VENDOR_DIRS` for the
  root-run install verbs, see above); `turbopanel_daemon_vendor_cache_dirs`
  mirrors the chowned list and `src/orchestration/sudoers-contract.test.ts`
  pins the two together. `tp`'s home is `/var/lib/turbopanel`, and the JS unit sets
  `DENO_DIR` under it. `repointUvCurrent` & co. are no-ops when the root-owned
  `current` symlink is already right; `ensurePython` skips uv when the pinned
  interpreter is present.
