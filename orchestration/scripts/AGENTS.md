# Host Scripts (sudo, tp-host, tp-orchestrate) — AGENTS.md

Daemon repo context: `../../AGENTS.md`. Cross-repo `../<repo>/…` links are relative to the repo root.

## Privileged Host Scripts

- **sudo** — `roles/turbopanel-user/templates/sudoers.j2` grants root exactly
  four commands: **`tp-host`** (`orchestration/scripts/tp-host`, installed
  `root:root 0755` at `<install>/lib/tp-host`), `tp-orchestrate`, and the two
  pinned engine config tests. There is no raw host utility, no Docker, no
  shell. `(tp) NOPASSWD: ALL` stays for the self re-exec pattern and engine
  config tests run as the engine service users.
  `src/orchestration/sudoers-contract.test.ts` pins that set and runs a corpus
  of classic escapes (`find -exec`, `tee`/`cp`/`install`/`mv`/`chown`/`chmod`
  to system paths, `systemctl link`, `useradd -o -u 0`, `usermod -aG sudo`,
  `sysctl kernel.core_pattern`, `ip netns exec`, `iptables --modprobe`,
  `docker run -v /:/h`, a foreign engine config) through a sudoers matcher.
- **tp-host** — every root host command the daemon issues goes
  `sudo -n -- <install>/lib/tp-host <verb> …`: every `sudo -n <cmd>` call site
  passes its argv through `hostSudoArgs` (`src/permissions/host-sudo.ts`),
  which rewrites a tp-host verb on a managed install and leaves development,
  root, `-u` re-execs, tp-orchestrate and engine tests alone;
  `host-sudo.test.ts` fails on any unwrapped `sudo -n <verb>` literal in `src/`.
  tp-host accepts only the argument shapes the daemon produces and:
  - confines paths to the trees TurboPanel owns (`/etc/turbopanel`,
    `/var/lib|log/turbopanel`, `/run/turbopanel`, the principal home root —
    recorded root-side in `lib/tp-host.conf`, never read from `daemon.env` —
    `/etc/ssh/turbopanel`) plus named files (`turbopanel-*` units,
    `60-turbopanel.conf`, `/etc/wireguard/tp0.conf`,
    `/etc/sysctl.d/99-turbopanel-*.conf`, operator storage under
    `/mnt|/media|/data|/srv` for principal-owned volumes);
  - pins every path (`cd -P` + `pwd -P` equality, so no component is a
    symlink) and works relative to the pinned directory; writes go through a
    root-only 0700 scratch directory and `mv -T`; root reads are checked on
    the opened descriptor (`/proc/self/fd/3`); files the daemon staged are
    read *as the daemon account* (`setpriv`);
  - checks systemd unit content before installing it: known directives only,
    tenant services `User=<principal>` / `Group=<principal>` /
    `Slice=turbopanel-<principal>.slice` (each `-` in the name written `.`:
    systemd reads a dash as a slice level, so `a-b` would otherwise sit inside
    `a`'s slice; `tp_principal_slice`, `principalSliceName`; `containers` and
    `tpbuild` are platform slices no principal may take) /
    `NoNewPrivileges=yes` / empty
    capability sets, no `+`/`!`/`:` exec prefixes, no line ending in a
    backslash (systemd would join it onto the next line, hiding e.g. `User=`
    from this line-by-line check), a timer may only start its own service;
    a `turbopanel-app-<id>.service` may carry exactly one `EnvironmentFile=`,
    equal to `<config>/node-app-env/<id>.env` (its own variables copy; systemd
    reads it as root, so no other path, no `-` prefix, no second line;
    `tp_app_envfile_ok`) and no other unit may carry one except the backup unit
    below. That folder is root's alone: only `app-env-install <id>` fills it
    (it reads the daemon's staged `<config>/node-apps/envs/<id>.env` as the
    daemon account on an open descriptor, refuses a symlink, a non-regular
    file, another owner, a second hard link or more than 1 MiB, checks the
    copy it made in root's scratch directory line by line against what the
    daemon renders, then places it `0600 root:root` with `mv -T`; the folder
    is `root:root 0700` under a sealed config root, checked on every run) and
    `app-env-remove <id>` empties it; tunnel connector tokens work the same
    way in `<config>/tunnel-env/` (`tunnel-env-install <id>` reads the daemon's
    staged `<state>/cloudflared/tunnels/<id>.env`, which must be exactly one
    `TUNNEL_TOKEN='<base64>'` line of at most 2048 characters; `tunnel-env-remove
    <id>`), and a `turbopanel-tunnel-<id>.service` unit is installed only if it
    equals `tp_tunnel_unit_text` (a throwaway `DynamicUser=` account, no
    capability); `tp_path_class` refuses the folder to
    every generic verb. Checking the text of a daemon-writable path is not
    enough: the daemon could swap it for a link to any root-only file after
    the check;
    the hosting-Caddy unit must run as `tpedge:tpedge` with
    `NoNewPrivileges=yes`, exactly `CAP_NET_BIND_SERVICE` in both capability
    sets, `StateDirectory=turbopanel/hosting-caddy` and only the
    `HOME`/`XDG_*` environment that points into it, and may only exec the
    vendored Caddy against the hosting Caddyfile; the `turbopanel-backup-` prefix is reserved for
    scheduled backups — a name under it must be exactly
    `turbopanel-backup-<lower-case uuid>.service|.timer`, and the service
    must run as `tp:tp` (`DAEMON_ACCOUNT`), with exactly one
    `ExecStart=<install>/lib/tp-backup-run <that uuid>`, only
    `EnvironmentFile=-/etc/turbopanel/daemon.env`, `Nice=10`,
    `IOSchedulingClass=idle` (those three directives exist for no other
    unit), and no `Environment=`, `Slice=` or `ExecReload=`
    (`tp_backup_unit_ok`);
  - reserves `turbopanel-php-<siteId>.service|.socket` for per-site PHP
    running as the site's owner (`tp_php_unit_ok`): FastCGI (`php-cgi<series>`
    on a socket), php-fpm (`Type=notify`, its own runtime directory) or
    detached lsphp (vendored, `PHPRC=` its php.ini, on a socket). Every line is
    pinned: the owner, its group and slice, no capabilities, the exec line per
    mode and series, `IPAddressDeny=localhost link-local multicast
    0.0.0.0/8 fc00::/7` with only `IPAddressAllow=127.0.0.53` (required,
    exact),
    `BindPaths=<home>/tmp:/tmp`, `ProtectSystem=strict` with
    writes only inside the home, and `TemporaryFileSystem=/etc/turbopanel:ro`
    plus `BindReadOnlyPaths=` of the site's config directory (the owner cannot
    traverse tp's 0750 tree otherwise). Sockets sit at
    `/run/turbopanel-php-<siteId>/`, the owner's, group a web server's, 0660.
    Config lives in `/etc/turbopanel/php/sites/<siteId>/` (dir 0750, files
    0640, root:<owner>, directive allowlist; php.ini's only non-plain
    section is `[PATH=<owner home>]`, the locked limits; php-fpm pools take
    `listen.acl_users`, never `user`/`group`/`listen.group`);
    `php-test <siteId>` runs the installed unit's binary on that config as
    the owner. daemon-install's tp:tp pass over the config tree skips it;
  - changes only principal accounts (uid ≥ 15001, primary group the
    account's own group `<name>` in the same band, home under the principal
    root, a listed shell), adds principals only to the SSH access
    groups `runtime-registry.json` defines and engine accounts only to a site owner's
    own group (`tp_principal_own_group`: the account `<name>` exists in the
    band and the group `<name>` is its primary group), and creates a group
    (`groupadd`) only under a name `useradd` would take: never `root`, `tp*`,
    `systemd-*`, a name in `TP_RESERVED_NAMES` (privileged and system group
    names such as `sudo`, `admin`, `wheel`, `adm`, `lxd`, `docker`, kept equal
    to the control plane's reserved list), a name a `sysusers.d` file declares
    (a package's system user or group that may not exist yet), a group sudoers
    names (`%name`, quoted or escaped, in `/etc/sudoers`, `sudoers.d` and the
    files it `@include`s), a name ending in `-grp` (an older owner's group),
    an all-digit name, an existing account or an existing group. `useradd`
    takes the same names and only a fresh group of the user's own name: in the
    band, nobody's primary group yet, no members. Residual risk accepted with
    the per-user group: polkit rules, PAM `access.conf` and sshd `Match Group`
    lines that name a group are not scanned. `groupmod` only renames a site
    owner's old `<name>-grp` primary group to `<name>`. It takes `chpasswd`
    input only as one sha512-crypt line;
  - allows `systemctl` verbs on `turbopanel*` / `wg-quick@tp0` / `ssh(d)`
    units, fixed `journalctl`/`ss`/`sshd -t|-T`/`sysctl`/`ip`/`wg` shapes, and
    xtables without `--modprobe` or rule files.
  - starts tenant builds only through
    `build-run <build-id> <project-id> <owner>` (ids `[a-z0-9-]{1,64}`; the
    owner is the site owner's Linux user, an existing principal with a uid
    in 15001-60000 and a plain name with no `--`, never another `tp*` name,
    or `tpbuild` for a build nobody owns; checked again under the build lock;
    nothing else in argv). Every build runs as a **throwaway user systemd creates for that one
    run** (`DynamicUser=yes`, `User=tpb-<16 hex of sha256(owner/project)>`: a
    uid from systemd's 61184-65519 range that exists only while the unit runs,
    never a host account, never in docker/tp/sudo, refused if a host account
    or group already has that name or any group lists a `tpb-*` member; no
    supplementary group: the vendored runtimes are readable by everyone),
    inside the **site owner's own resource group**
    (`Slice=turbopanel-<owner>-build.slice`, a child of the owner's
    `turbopanel-<owner>.slice`, dashes in the owner's name written `.`, so a
    build counts against whatever limits that slice carries;
    `turbopanel-tpbuild.slice` with no owner; both slice names are refused as
    unit files). It checks the root-owned
    `/var/lib/turbopanel-build/{work,caches}` layout, takes a host-wide lock
    (one build at a time), makes `caches/<owner>/<project>` (root 0700 dirs;
    a cache is never shared between site owners or projects), and execs
    `systemd-run --wait --pipe` with a fixed property set (`NoNewPrivileges`,
    no capabilities, `ProtectSystem=strict`, systemd's private tmp, private
    devices/IPC/PIDs, the daemon's trees, principal homes,
    Docker/containerd/gate sockets and `/etc/ssh` made inaccessible,
    `/var/lib/turbopanel-build` a read-only tmpfs with only this build's work
    tree and cache bound in, private/link-local/CGNAT egress denied except
    the host's literal nameservers, loopback open but port-filtered for the
    unit's own cgroup by `lib/tp-build-loopback` (nftables table
    `inet turbopanel_build`, `socket cgroupv2 level N "<unit cgroup>"`; loaded
    empty by `build-run` to prove nft works, then with the build's rules as the
    unit's first `ExecStartPre=+ … sync <id> <owner>`, which refuses unless
    its own cgroup is exactly the one systemd builds for that owner's build
    slice; no `nft` or a load failure means the build does not start), 4G
    memory, 200% CPU, 1800 s). The unit's second `ExecStartPre=+` is
    `tp-host build-handover <id> <project> <owner>`: refused unless its cgroup
    is exactly that unit's, it reads the throwaway uid from the unit's
    `RuntimeDirectory=` (`/run/turbopanel-build-<id>`, created by systemd
    owned by that user; read-only to the build so it cannot fill `/run`),
    takes the work tree from the daemon (top directory root 0700), refuses
    (and unlinks) any regular file with more than one name in it (a hard link
    the daemon planted to a file outside), and only then hands the pinned
    cache and work tree to the build's user (`chown -R -h -P`). The only command is
    `/bin/sh` on `lib/tp-build-runner`, loaded as a systemd credential (PID 1
    reads it; the build's user gets a private copy); the spec rides stdin to
    the runner (format in its header; `TMPDIR` is `<work>/tmp`, because
    `DynamicUser=` always gives the unit systemd's own private `/tmp`: a 10%
    of RAM tmpfs on systemd 257, a hard limit; host `/tmp` on 255, which
    `build-watch` checks every 10 s against 1.5 GB, not a hard limit).
    `principal-remove` deletes the owner's `caches/<owner>`, so a later owner
    given the same name never builds with them. The image builder's plan
    version is recorded only when it is 1-64 plain characters. Not `CacheDirectory=`: on systemd 257 with `DynamicUser=` it is
    owned by `nobody` on disk and mounted `noexec`, which breaks `npx`/`pnpm
    dlx`. Below systemd 255 (Debian 13 / Ubuntu 24.04 floor) it warns and
    drops the newer properties, below 247 it refuses. `build-return
    <build-id>` chowns the tree back to the caller only once
    `turbopanel-build-<id>.service` is inactive; abort is `systemctl stop
    turbopanel-build-<id>.service`. `turbopanel-build-*.service` unit files
    are refused at install. On a managed host the daemon sends every
    native/static release build, and the image builder's prepare step,
    through it (`src/deploy/release/build-sandbox.ts`,
    `src/deploy/release/image-prepare-sandbox.ts`), so no tenant build command
    and no repository-reading build tool runs as `tp`. The shared `tpbuild`
    account, its cache and `tpbuild.slice` are retired (the `build-user` role
    removes them; uid 9994 stays reserved);
    **Build loopback (plain words):** Turbopack's helper processes talk over
    127.0.0.1 on ports the build picks, so the build may use loopback. The
    build is refused every known platform port (list in one place,
    `DENY_PORTS` in `lib/tp-build-loopback`, pinned to the code constants by
    `src/orchestration/build-loopback.test.ts`): ssh 22, web 80/443, web
    server admin 2019/2029/2039, database proxy 6032/6070/6132/13306/15432,
    router 7080/7081/7443, panel 8443, GPU metrics 9400, 19080/19820, database
    HA 33001/33002, platform Postgres 5432 (when `postgres_expose_port` is
    true), legacy ProxySQL 3306, site and app listen bands 18080-18999 and
    19100-19799 (includes 18110). Nothing inside the kernel ephemeral range
    (32768-60999) is listed, because a build's own workers may be handed any
    port there; managed private ports (45000-45999) bind a non-loopback
    address, so they are not listed either. The resolver stub (53) is not
    listed, so it stays reachable. **Residual risk, accepted by
    the owner:** anything else listening on 127.0.0.1 on a port not in that
    list (for example a Docker port a site owner published on loopback with
    an ephemeral port) can be reached by a build, because nftables cannot
    tell the build's own listeners from another service's. Adding a new
    fixed loopback port to the platform means adding it to `DENY_PORTS`;
  - brings a release into `<home>/sites/<svc>/releases/<id>` only through
    `publish-open <user> <svc> <id>` (a fresh daemon-owned leaf under
    `<principal root>/.tp-staging`, `root:tp 0710`, a class no generic verb
    accepts) and `publish <user> <svc> <id>` (`publish-keep` takes the same words and
    publishes without moving `current`, for a Node app that is
    serving); the same two verbs also take six
    words, `<owner> <scope> <slug> <service id> <release id> <publish id>`,
    for the scope tree (`<home>/<scope>/services/<slug>/releases/<id>`; the
    leaf is named by the publish id, the lock by the service id, all three
    lowercase UUIDs). Ownership in a home is checked by position: depth 1 is
    `home`/`tmp`/`data`, the older `sites`/`volumes`, or a scope folder
    (root-owned); below a scope only `services` and `volumes`; `rm` leaves
    scope, `services` and `volumes` folders alone; `asset-path` prints a
    folder's host path from its components and refuses what the shared
    name rules refuse; `folder-list` prints every well-formed asset folder
    (`<owner> <scope> service|volume <name>`, names only, links skipped) and
    ends with `complete` only when the whole walk finished; `setfacl -m
    u:<uid>:rwx,d:u:<uid>:rwx -- <volume folder>` gives one numeric uid (never
    0) an access and a default entry on a volume folder root and nothing else;
    `sftp-chroot check` walks the scope tree. Publish: it takes the leaf, refuses hard
    links, special files and a shipped `shared`, seals it recursively
    (`root:<user>`, no set-id, nothing group/other-writable), refuses a
    symlink that resolves outside it, renames it in through a root-owned chain
    on the same filesystem, links `shared`, sets the top to `0550` and swaps
    `current` (a directory at `current` or `current.tmp.<id>` is refused).
    `install -d` / `mkdir -p` under `releases/<id>` are refused, `cp -a` is
    gone, and `ln` uses `-T`;
  `src/permissions/tp-host.test.ts` runs it unprivileged in its test mode
  (`TP_HOST_TEST_PREFIX`, ignored as root) against the daemon's own rendered
  units and a hostile corpus. Known gap: it is TOCTOU-safe for paths it pins,
  but `chown -R`/`chmod -R`/`find -exec chmod g+s` over a tenant-owned tree
  rely on coreutils not following symlinks (and run as the tree's owner where
  possible), not on per-entry pinning.
- **tp-orchestrate** (`orchestration/scripts/tp-orchestrate`, POSIX sh,
  `root:tp 0750`) — Ansible `become` from `tp` would need `sudo /bin/sh`, so on
  managed hosts `runPlaybookStreaming` routes through
  `sudo -n tp-orchestrate playbook …` (`src/orchestration/privileged.ts`):
  the helper accepts only `-i localhost, -c local`, allowlisted extra-vars and
  one shipped playbook **basename** resolved under the root-owned tree.
  `tp_extra_var_value_ok` lists every key the daemon passes with its value
  shape (enums, RFC 1123 hosts, a plain email, an https directory, backups
  only under storage roots) and pins `turbopanel_install_root` /
  `turbopanel_instance_dir` to its own tree; it refuses `ansible_*`,
  `turbopanel_dev_*`, any unknown key, whitespace, controls and Jinja
  delimiters. A JSON `-e` object is accepted only with
  `TP_JSON_EXTRA_VAR_KEYS`, parsed by the Ansible venv's python3.
  `src/orchestration/tp-orchestrate-argv.test.ts` runs the daemon's real argv
  builders and a hostile corpus through the validator lifted verbatim from
  the script (`src/testing/tp-orchestrate-validator.ts`). It rebuilds
  PATH/ANSIBLE_* itself, and keeps Ansible's temp/home in a root-only
  `/tmp/turbopanel-orchestrate`. `update` fetches
  `run.sh` (CDN, or an HTTPS overlay host with the canonical
  Platform CA — never `-k`) and runs it with re-validated flags, which is how
  panel-driven daemon updates work now (`executeRunReconcile` →
  `rootHelperReconcileInvocation`; the daemon never hands root a script body).
  **`tp-update-guard`** (`orchestration/scripts/tp-update-guard`, POSIX sh,
  `root:tp 0750`) is installed with `turbopaneld-update-guard.service` /
  `.timer` and runs only as **root** via `OnFailure=` and the one-shot timer
  after a daemon self-update — not through `sudo` and not from the `tp` user.
  `daemon-launch` also copies it to `/opt/turbopanel/lib/tp-update-guard`, and
  the unit's `ExecStart` is that path, so restoring an older orchestration
  tree cannot remove the only executable the timer can run. Its records live
  in `tp`-owned `RUN_DIR`/`STATE_DIR`, so every root write goes through
  `tp_write_file` (a verified root-only 0700 subdirectory, then `mv -T`) and
  never through a symlink `tp` planted (`update-guard.test.ts`).
  The control plane is a separate verb, `sudo -n tp-orchestrate update-instance
  --channel canary|rc|release [--manifest-url …] --no-start`
  (`rootHelperInstanceUpdateInvocation`). It takes no license, host, overlay,
  or Platform CA. `--manifest-url` is passed to `run.sh` as
  `--instance-manifest-url` so it does not set `TURBOPANEL_MANIFEST_URL` (that
  pin is the daemon package). `trunk` and `edge` are refused: the instance and
  UI packages publish only through GitHub Releases. `--no-start` is required;
  the daemon restarts `turbopanel-instance` and `turbopanel-caddy` after a
  successful install and does not restart itself. Before the helper runs, the
  daemon refuses a target below `MIN_SUPPORTED_INSTANCE_VERSION`. A missing
  or non-semver target is unknown and is allowed. The control plane accepts
  `instance-update` from any connected daemon. Daemon self-update does not
  consult the instance floor. Detail: `src/instance/AGENTS.md` (Managed updates).
  Root (`run-installer`) and co-located dev run `ansible-playbook` directly.
  Tests: `src/orchestration/tp-orchestrate.test.ts`, `privileged.test.ts`,
  `sudoers-contract.test.ts`.
