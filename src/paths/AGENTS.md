# Path Model — AGENTS.md

Daemon repo context: `../../AGENTS.md`. Cross-repo `../<repo>/…` links are relative to the repo root.

## Filesystem layout & path model (dev vs prod)

`src/paths/layout.ts` is the **single source of truth** for every managed
install location. `resolveLayout(env, opts)` returns mode-aware defaults;
`detectInstallMode()` picks `development` vs `production` (a resolvable daemon
checkout — `orchestration/ansible.cfg` or `main.ts`, and not a `deno-compile-*`
extraction dir — means development, otherwise production). Every path is
env-overridable (`TURBOPANEL_HOME`, `TURBOPANEL_BIN_DIR`, `TURBOPANEL_LIB_DIR`,
`TURBOPANEL_RUNTIME_DIR`, `TURBOPANEL_SHARE_DIR`, `TURBOPANEL_UI_DIR`,
`TURBOPANEL_ORCHESTRATION_DIR`, `TURBOPANEL_CONFIG_DIR`, `TURBOPANEL_STATE_DIR`,
`TURBOPANEL_DAEMON_STATE_DIR`, `TURBOPANEL_LOG_DIR`, `TURBOPANEL_BACKUP_DIR`,
`TURBOPANEL_RUN_DIR`, `TURBOPANEL_RUNTIMES_DIR`, `TURBOPANEL_DAEMON_ROOT`,
`TURBOPANEL_PRINCIPAL_HOME_ROOT`).
`src/orchestration/assets.ts` and `src/instance/sockets.ts` derive their constants
from `resolveLayout` — do **not** hardcode absolute paths in runtime code;
add/extend a layout field instead. The development default checkout root is
`<devRoot>/turbopaneld` (from `TURBOPANEL_DEV_ROOT` / `$HOME`); production runtime
code must never name the retired `/opt/turbopanel/platform` token — the layout
module and CI guard are the only places allowed to reference it.

**Production (managed / FHS)** — compiled release, no source checkout. The daemon runs as **`tp:tp`** (UID/GID 9999); per-service accounts (`tpctrl`, `tpcache`, `tpdata`, `tpqueue`, `tpcaddy`) are listed in **`../turbopanel/AGENTS.md`** (Production UID/GID allocation):

| Purpose                                                           | Path                                  |
| ----------------------------------------------------------------- | ------------------------------------- |
| Native daemon binary                                              | `/opt/turbopanel/bin/turbopaneld`     |
| Deno JS runtime (`turbopaneld.js`; page-size-incompatible hosts)  | `/opt/turbopanel/bin/turbopaneld.js`  |
| Orchestration assets (Ansible)                                    | `/opt/turbopanel/share/orchestration` |
| Static UI export                                                  | `/opt/turbopanel/share/ui`            |
| Vendored runtimes (node/deno/caddy/uv/python/ansible/cloudflared) | `/opt/turbopanel/vendor`              |
| Daemon install root (`daemonRootDefault`)                         | `/opt/turbopanel/lib/daemon`          |
| Config (`daemon.env`, `instance-ca.pem` — **Platform CA** bundle fetched from the control plane; no Organization CA material is ever stored there) | `/etc/turbopanel`                     |
| Persistent identity (license, `server.id`, keys, tunnels)         | `/var/lib/turbopanel`                 |
| Tenant principal homes (`principalHomeRoot`)                      | `/srv/users/<username>`               |
| Logs                                                              | `/var/log/turbopanel`                 |
| Backups (`backupDir`; `managed/`, `volumes/`, `panel/` inside)    | `/backup`                             |
| Runtime (sockets, `daemon.lock`)                                  | `/run/turbopanel`                     |

**Files at the root of the config and state trees (P1-1).** `/etc/turbopanel`
and `/var/lib/turbopanel` end up root-owned (the `daemon-seal` role, last before
the daemon restarts, with a sweep of links the daemon planted; an administrator's
root-owned links stay): the daemon (`tp`) writes only its own
folders below them (`DAEMON_CONFIG_LEAVES` / `DAEMON_STATE_LEAVES` in
`src/paths/layout.ts`, created by the `daemon-layout` role). The few files that
live at the root itself (`instance-ca.pem`, `firewall*.v4|v6`, `server.id`,
the server key and key-id files, `update-guard-disarm.json`,
`release-link-scan.json`) go through
`writeDaemonFile` / `removeDaemonFile` / `ensureDaemonDir`
(`src/permissions/daemon-files.ts`): rename in directly when the folder is
writable, otherwise `tp-host install -o tp` / `rm`. Never `Deno.rename` or
`Deno.mkdir` a new entry straight into those two roots. `/var/log/turbopanel`
is root-owned too (the daemon writes nothing there). On a host that also runs
the control plane the state root stays shared with the instance for now
(`turbopanel_seal_state_root: false` in the co-located playbooks). `tp-host` treats every other entry directly under those two roots as root's: `rm`, `mv`,
`chown` and `install -d -o` refuse it, and `install`/`tee`/`cp -p` refuse a root-owned
regular file there (`tp_refuse_root_entry`, `tp_put_file`; the leaf and loose-file lists
mirror `layout.ts`, pinned by `tp-host.test.ts`). Root Ansible never
recurses or follows links inside a leaf (pinned by
`src/orchestration/root-tasks-platform-parents.test.ts`).

`backupDir` is deliberately **outside** the FHS state tree and carries the same
`/backup` default in development and production: backups are the one artifact
an operator is expected to point at other storage (a second disk, a NAS mount,
an attached volume), so `TURBOPANEL_BACKUP_DIR` repoints them without moving
anything else. The root is named once (`BACKUP_ROOT` in `src/paths/layout.ts`)
and holds one folder per kind: `managed/<managedId>/` (`managed/engine-paths.ts`'s
`managedBackupsDir`), `volumes/<copyId>/` and `panel/` (the control plane's
upgrade backups at `panel/<upgradeId>/` and its scheduled database dumps at
`panel/database/`), so an id can never collide with a kind word. Artifacts are
written 0600 by the daemon user itself. `tp-host` reads the root from
`backup_dir=` in `lib/tp-host.conf`. Restore intents are state, not backup data:
`<daemonStateDir>/backup/restore-intents/`. Paths the daemon reports are
absolute today; `backupRelativePath` / `resolveBackupPath` accept either
spelling so the control plane can store them relative to the root. Repointing the
override affects **new** backups only — nothing relocates an existing tree —
and `managed.destroy` still removes an engine's backup directory along with its
state dir, so destroying an engine never leaves an orphan tree on that storage.

**Server folders that look odd and are kept on purpose.** The tables in
`src/paths/layout.ts` (`ROLE_MADE_FOLDERS`, `RUN_FOLDER_UNITS`,
`BUILD_SIBLING_DIR`) are the one list.
- `/var/lib/turbopanel-build` is the only sibling of the state root: the
  throwaway build user is not in group `tp`, so a work folder inside
  `root:tp 0750` would be unreachable. The hosting Caddy and Docker gate state
  (`/var/lib/turbopanel/{hosting-caddy,docker-gate}`), the gate cache
  (`/var/cache/turbopanel/docker-gate`) and the Apache logs
  (`/var/log/turbopanel/apache`) are nested `StateDirectory=` / `CacheDirectory=`
  / `LogsDirectory=` folders; the SFTP switch is
  `/etc/ssh/turbopanel/sftp-chroot` and the egress helper
  `/opt/turbopanel/lib/docker-egress`. `check:layout` refuses the old names.
- Run folders stay one per unit at the top of `/run` (`turbopanel-nginx`,
  `turbopanel-php-<id>`, `tp-publish`, ...): systemd removes them with the unit
  and the short path keeps a socket inside the 108-byte limit.
- A native app's variables are staged in `<config>/node-apps/envs/` (daemon-owned)
  and read from `<config>/node-app-env/` (root-only, made by `tp-host`). The two
  parents differ on purpose: a daemon-owned parent would let the daemon replace
  the root-only folder.
- The hosting Caddy snippets are `<environmentId>.caddy` (one per environment,
  UUID key, `.caddy` so the site Caddy's `sites/*.conf` glob never matches).
- OpenLiteSpeed virtual host names are `tp_<environment>__<service>` with every
  character other than a letter or digit escaped as `_` and two hex digits, so
  two different pairs can never share a name.
- `proxysql` and `orchestrator` under the config root are daemon leaves
  (`tp:tp 0750`, made by daemon-layout because the daemon writes their compose
  files before any role has run on a daemon-only host); the proxysql and
  orchestrator roles now set that same owner and mode instead of `root:tp 0770`,
  so neither play undoes the other, and work only inside. There is no
  `<state>/proxysql` folder (ProxySQL keeps its data in a Docker volume) and the
  orchestrator role no longer re-owns `<state>/orchestrator` (a daemon leaf).
- `host-boot.json` and the host-wide intent marker live in `<state>/system/`,
  not among the per-database folders.

The **host** allocates UID/GID via `useradd`/`groupadd` from **15001–60000**
(`-K` on that one command; `/etc/login.defs` is not edited). The control plane
may send an optional operator override, which must be **15001–60000** (above
it is systemd's 61184–65519 range for throwaway build users) and clear
the `tp*` service band **9989–9999**. Homes are keyed on the username. Override
the home root with
`TURBOPANEL_PRINCIPAL_HOME_ROOT` (`layout.principalHomeRoot`). **Platform CA**
vs **Organization CA** (two-CA distinction):
`../turbopanel/src/lib/tls/AGENTS.md`.

**Development (co-located checkout)** — `./console` from
[TurboPanel/dev](https://github.com/TurboPanel/dev) runs the daemon from source
(`deno run main.ts`); all mutable paths are **dev-user-owned**:

| Purpose                          | Path                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| Daemon checkout / install root   | `<TURBOPANEL_DEV_ROOT or $HOME>/turbopaneld`                                            |
| Orchestration assets             | `<checkout>/orchestration` (prod roles); overlay in `<dev checkout>/orchestration` |
| Vendored runtimes                | `/opt/turbopanel/vendor`                                                           |
| Daemon env file                  | `/etc/turbopanel/daemon.env`                                                       |
| Daemon state                     | `/var/lib/turbopanel`                                                              |
| Logs                             | `/var/log/turbopanel`                                                              |
| Backups (`managed/`, `volumes/`, `panel/`) | `/backup`                                                                          |
| Config dir                       | `/etc/turbopanel`                                                                  |
| Runtime (sockets, `daemon.lock`) | `/run/turbopanel`                                                                  |

**Development identity:** co-located dev creates **no** dedicated `tp`,
`tpctrl`, or `tpcache` service accounts. The
`turbopaneld`, instance, UI, and Caddy systemd units, plus Docker-backed
services (Postgres and RabbitMQ consolidated under the single
`turbopanel-system-stack` Compose stack — see
`orchestration/roles/system-compose/AGENTS.md` — plus standalone Redis and Mailpit), all run as
the **current dev user**. The optional Stripe CLI forwarder
(`orchestration/roles/stripe-listen`, unit `turbopanel-stripe-listen`,
extra-var `turbopanel_optional_stripe_listen`, off by default) is dev-only
too: it vendors the pinned `stripe` binary under `vendor/stripe-cli/` and keeps
the hand-supplied test key and the CLI's forwarding secret in
`/etc/turbopanel/stripe-listen/stripe.env` (seeded once, never re-templated).
The instance unit does **not** load that file: billing exists only in the
Workers build, a self-hosted Deno instance has no billing surface and must
never see a Stripe key, and a `wrangler dev` instance takes its secrets from
`.dev.vars`. Production managed installs keep the dedicated
service users `tp`, `tpctrl`, `tpcache`, `tpdata`, `tpqueue`, and
`tpcaddy` — see **`../turbopanel/AGENTS.md`** (Production UID/GID allocation).
