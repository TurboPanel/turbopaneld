# Scripts (Purge and Installer) — AGENTS.md

Daemon repo context: `../AGENTS.md`. Cross-repo `../<repo>/…` links are relative to the repo root.

## Purge script

`scripts/purge.sh` purges TurboPanel from a host: everything TurboPanel put there and
nothing else. There is no keep-my-data option and no remove-only mode — one
path, ending in a typed confirmation line (`purge <hostname> <code>`). It
lives only in this repository: release packages do not ship it, and
turbopanel.sh does not serve it.

Canonical command (root, no sudo re-exec):

```sh
curl -fsSL https://raw.githubusercontent.com/TurboPanel/turbopaneld/trunk/scripts/purge.sh | sudo sh
```

The script refuses to continue unless it is already root. It does not
re-execute itself under sudo. `--dry-run` is root-only as well and still
needs a controlling terminal; there is no non-interactive bypass.

Server-type detection (self-hosted control plane, a daemon enrolled with
TurboPanel High Availability, a daemon enrolled with some other control
plane, or leftovers from an older or partial install) only changes the
labels and warnings printed before the prompt. Every removal step runs
either way, so a partial install is cleared by the same path as a full one.

A development environment is refused before anything is changed:
`TURBOPANEL_MODE=development`, `TURBOPANEL_DEV_ROOT`, or `TURBOPANEL_DEV_USER`
in `daemon.env`, `/etc/sudoers.d/turbopanel-dev-nopasswd`,
`/etc/turbopanel/dev-forward-hosts`, or a `turbopaneld.service` `ExecStart`
that runs `main.ts`. The message points at `~/dev/console` → Developer →
**Reset development environment** / **Purge completely**.

Four maintenance rules:

1. A new host file that lives outside the FHS folders this script already
   deletes must use a `turbopanel-*` or `tp*` name the scan already matches,
   or be added to the script explicitly.
2. When a release renames or retires a unit, account, path, or container
   name, add the old name to the `TP_LEGACY_*` block at the top of
   `scripts/purge.sh`.
3. **Never add a generic package to the purge.** Hosts run this on desktops and
   shared machines, and the installer's dependencies (curl, git, acl, gnupg,
   iptables, openssl, wireguard-tools, build-essential, sudo,
   systemd-timesyncd, ...) are not TurboPanel's to remove. Only Docker's
   packages (`TP_DOCKER_PACKAGES`) and the `phpN.N-*` packages plus
   `debsuryorg-archive-keyring` that the php-fpm role's sury repo supplied are
   purged. A role that adds a new apt repository for its own packages must add
   its source file and signing key to the removal (`TP_DOCKER_APT_SOURCES`,
   `TP_DOCKER_APT_KEYS`, `TP_SURY_APT_KEYS` or `tp_purge_apt_packages`). A role
   that holds a package at a version may only hold one of `TP_DOCKER_PACKAGES`:
   the purge passes `--allow-change-held-packages` for those, and a hold on
   anything else would make `apt-get purge -y` refuse.
   `scripts/purge-coverage.test.ts` reads the roles, playbooks, host scripts
   and `run.sh` and fails when one names an apt source, key, pin or config
   file, a systemd unit or drop-in, or a Docker or containerd config path that
   the purge does not remove, or holds a package it does not list.
4. A new folder the script must delete has to sit inside a tree listed in
   `TP_OWNED_TREES` (or be a `turbopanel*` unit drop-in), or be added to that
   list. `tp_path_is_safe` refuses everything else.

The purge runs the removal steps, then `tp_purge_hosted_data`. Detection
still only changes labels; the purge runs for every server type. Each step
checks what is actually present and is safe to run again after an earlier run
stopped partway. After confirmation, the purge writes a root-only marker and a
resume manifest under `/var/lib/turbopanel-purge/` (directory `0700`, files
`0600`, never through a symlink). That directory is outside the trees the
purge deletes. `--dry-run` does not write either file. `tp_main` checks the
marker before the empty-inventory exit, so a rerun resumes the purge when only
apt packages or Docker data are left. Docker being installed is not, by
itself, a TurboPanel install. The manifest is loaded from `tp_discover_paths`
and restores discovered config, state, log, run, backup, and principal-root
paths. Both files are removed once the purge finishes and every recorded
failure is benign (`tp_record_benign_fail`: a failed `apt-get update`, or a
Docker data root no rerun could find); any other failure keeps them for the
rerun. Commands go through `tp_run`, so `--dry-run` logs them and does not run
them.

**Path safety is an allowlist.** `tp_path_is_safe` resolves the parent's
symlinks (`realpath -m`), keeps the leaf as written, refuses `.` / `..`
segments and whitespace, and accepts only paths inside `TP_OWNED_TREES` or a
`turbopanel*` entry under a systemd unit directory. A folder discovered
outside those trees — a custom backup directory, principal root, or Docker
data root, from `daemon.env`, a unit, or the resume manifest — is never
deleted, and a principal root outside them is never used to pick accounts
for `userdel`: `daemon.env` is writable by the daemon account, so it must not
widen what root deletes. Such folders are listed as "Configured outside
TurboPanel's folders (kept)" in the report and the summary. Folder deletion
uses `tp_safe_rm_tree` (allowlist, symlink-only unlink, mount contents cleared
and the mount kept). There is one copy of that function. A Docker apt
`Signed-By` keyring is only removed when it is a file directly in
`/etc/apt/keyrings`, `/usr/share/keyrings`, or `/etc/apt/trusted.gpg.d`.

**Post-check rules (what "left over" means).** The final inventory must
match what can exist after the purge. A `.slice` unit that systemd still
reports as loaded but with no unit file and inactive (the retired `tpbuild.slice`) is gone
(`tp_unit_present`). After Docker Engine is purged, `tp_finalize_turbopanel_units`
stops `turbopanel.slice` / `turbopanel-containers.slice` again, runs
`daemon-reload` and `reset-failed`, so implicit slices are not reported as
left over while a container cgroup still held them. The summary's unit diff
also skips names `tp_unit_present` already treats as gone. Once Docker Engine was purged (`TP_DOCKER_ENGINE_GONE`)
the final inventory skips Docker, so the `<id>-in` containers removed with it
are not reported. Anything else still on disk stays a failure. When the Docker daemon is not answering at the final check, the pre-purge container and network lists are carried forward only if the removal step itself was skipped (`TP_DOCKER_LEFT`); a daemon that is gone after a removal that ran holds nothing, so it is never a false failure. The purge also
removes `/var/cache/turbopanel` (the Docker gate's cache, in `TP_OWNED_TREES`;
the hosting Caddy's and the gate's state folders sit inside `/var/lib/turbopanel`),
`/etc/tmpfiles.d/turbopanel-hosting-caddy.conf`, and the `tpgatebuild` group
(`TP_OTHER_GROUPS`, matched by exact name because its gid is outside the
9900 band). The resume marker clears whenever the remaining failures are
benign, so a clean run leaves `/var/lib/turbopanel-purge` gone. A role that
adds a group or state folder outside the `tp*`/`/var/lib/turbopanel` naming
must be added to these lists.

**Shell startup files** (`.bashrc` and friends) are scanned in root's home
and in every UID ≥ 1000 home except principal homes (those are purged whole
by the purge). A symlinked file is left alone. The
backup and the strip run as the owner of the directory holding the file
(`setpriv --reuid/--regid --clear-groups`), never as root: that owner controls
every name there, so a planted `.bak`, temp name, or swapped file could
otherwise turn root's write into an overwrite of `/etc/passwd`. An existing
backup is never reused; a second one gets a `mktemp` suffix. A file not owned
by its directory's owner, or a host without `setpriv`, is skipped and
reported.

**Tests:** `scripts/purge.test.ts` lifts the functions and constants out
of the real script and runs them as a normal user against temp directories
(planted `.bak` symlink, principal homes, path allowlist and symlink escape,
custom folders kept, benign-failure marker rule, no generic package is ever a
candidate, the apt-simulation guard keeps a package that would drag others
along, no autoremove / apt-mark / menu, firewall warning). CI also runs
`shellcheck -s sh scripts/purge.sh`
(`verify.yml`); an inline `shellcheck disable` needs a reason.

Purge order:

1. **Principal users.** Accounts are found by home directory under each
   discovered principal home root (default `/srv/users`), whatever the UID,
   including when that root directory is already gone. Directory enumeration
   and deletion of the root run only when the path exists. Older installs
   used ids from 1000 (host-picked) or 10001 (overrides); the current band
   starts at 15001. Matching the home is what still finds them. For each
   account: kill its processes, `userdel` it, then `groupdel` its own
   group: `<user>`, and `<user>-grp` from hosts set up before the group took
   the user's name (`tp_purge_principal_groups`). Either is removed only when
   its gid is in the site owners' band (`TP_PRINCIPAL_ID_MIN`-`MAX`,
   15001-60000), its name is plain and not `root`/`tp*`, and no account still
   has it as primary group: without the old suffix a directory called `sudo`
   or `staff` must never cost the host its real group, and a group of that
   name outside the band is only reported as kept. A directory in the root
   with no account (an earlier run already deleted the user) gets the same
   treatment, and additionally keeps a group that still lists any member.
   Homes are removed after the groups, with `tp_safe_rm_tree`, so a stopped
   run can still find a leftover group from the directory name. `/srv` itself is left; Debian ships
   it, and `tp_path_is_safe` refuses it. The preflight inventory records
   passwd accounts whose homes lie under a discovered root even when those
   directories are absent.
2. **Docker Engine.** The confirmation screen warns that this removes every
   container, volume, and image on the host, including ones TurboPanel did
   not create. Before Docker is stopped, the script reads the effective data
   root (`docker info` while the daemon responds, otherwise `data-root` in
   `/etc/docker/daemon.json`, otherwise `--data-root` on the docker unit).
   The Docker role preserves operator keys in `daemon.json`, including
   `data-root`. A nondefault root is shown in the confirmation report; it is
   removed only when it lies inside `TP_OWNED_TREES`, and otherwise listed as
   kept. If it cannot be determined, the summary says so (a benign failure);
   a root that was determined is kept in the resume manifest. Stop `docker.socket`, `docker`,
   and `containerd`. `apt-get purge` the installed Docker packages (Docker's
   own set and Debian's `docker.io` / `docker-compose` / `containerd` /
   `runc`) through the same apt-simulation guard as step 4 — a package whose
   purge would also remove something outside the Docker set (e.g. `runc` under a
   `podman` install) is kept and reported. Remove `/var/lib/docker`, `/var/lib/containerd`, the nondefault
   data root, and `/etc/docker` even when the packages are already gone.
   Remove any file in `/etc/apt/sources.list.d` that references
   `download.docker.com`, and the keyring named in that file's `Signed-By`
   (usually `/etc/apt/keyrings/docker.asc`). `groupdel docker`, only when no Docker engine package (any package in `TP_DOCKER_ENGINE_PACKAGES`, the one list the group decision and the engine-gone check share) is still installed: `docker.socket` needs the group at boot, and the Docker role recreates it on every run. Failed Docker units are reset (`tp_reset_failed_docker_units`). A docker socket file counts as a live engine only when something listens on it (`ss -xl`); a stale one is removed once the engine is gone. Once
   Docker Engine is gone (no `dockerd`, no `docker-ce`/`docker.io`;
   `tp_docker_engine_gone`), `tp_purge_docker_network_state` deletes the
   `docker0` and `br-<12 hex>` bridges, the rules in the filter, nat and raw
   tables that name those bridges or jump to a `DOCKER*` chain (rules with
   quoted words are never touched), and the `DOCKER*` chains. `DOCKER-USER`
   is kept when it holds anything but Docker's default `RETURN`. The
   iptables-nft tables themselves belong to the host and stay. When no FORWARD rule is left, a FORWARD policy of DROP (Docker's leftover) is set back to ACCEPT (`tp_restore_forward_policy`); an operator FORWARD rule keeps the policy as is. Whatever
   cannot be removed sets `TP_NET_LEFT`, which is the only time the summary
   asks for a reboot.
3. **Data folders.** Every discovered config, state, log, run, and backup
   path, plus `/etc/ssh/turbopanel`.
4. **PHP packages TurboPanel added**, last, and only when TurboPanel's own
   evidence is on the host (`tp_sury_evidence`: its `sury-php.sources` /
   `sury-php.list`, or a `turbopanel-php-fpm` unit in the pre-removal
   inventory). Candidates are the installed `phpN.N-*` packages and
   `debsuryorg-archive-keyring`; nothing else. Every other package the
   installer relied on (`curl`, `git`, `acl`, `gnupg`, `iptables`, `openssl`,
   `wireguard-tools`, `build-essential`, `sudo`, `systemd-timesyncd`, ...) is
   never touched, and there is **no `autoremove` and no `apt-mark`**. `apt-get
   update` runs, then `apt-get -s purge` simulates the candidates
   (`tp_purge_guarded_packages`). If that would remove packages that are not
   candidates, each candidate is simulated alone and any that still pull
   extras are dropped and reported, including when adding one to an otherwise
   safe set would pull them. Then `apt-get purge -y` the final list. The sury
   source file is removed last, so an interrupted run still finds it as
   evidence. `/etc/systemd/timesyncd.conf` stays as TurboPanel wrote it.

The purge warns, on the confirmation screen and in the summary, that no
inbound firewall remains: `ufw` / `firewalld` were purged at install and the
script removes TurboPanel's own `TP-*` rules.

The summary adds, on top of the skipped steps and the "could not
remove" list from the second scan: hosted data that is still present
(config, state, log, run, and backup paths, principal roots and homes, and
`/etc/ssh/turbopanel`), compared with the pre-removal snapshot. Empty
mountpoints kept on purpose are left off that list. It also lists packages
kept and why (a Docker or PHP package whose purge would have dragged others
along); a note that other packages stay installed by design; that
`/etc/systemd/timesyncd.conf` is left as written; a reboot only when Docker
bridges or chains could not be removed; and the commands to install a daemon or
a self-hosted control plane again.

## Installer script hosting

**https://turbopanel.sh is a plain redirect, and nothing in this repo hosts it.**
Only the domain root redirects, to the one copy of the installer on GitHub; no
other path on turbopanel.sh is served or referenced. The redirect is served from
outside this repository (the owner's DNS/redirect; the Cloudflare Worker that
used to do this was removed 2026-09-29):

    https://raw.githubusercontent.com/TurboPanel/turbopaneld/live/scripts/run.sh

**One installer host per environment** (2026-09-29, all served outside this repo,
each a redirect to that branch's `scripts/run.sh`): `turbopanel.sh` → `live`
(release channel), `staging.turbopanel.sh` → `staging` (rc channel),
`testing.turbopanel.sh` → `trunk` (canary rail: `trunk`, `edge`, `canary`).
The update channel picks the host, everywhere: the control plane's install
command, run.sh's re-run under sudo, `tp-orchestrate`'s run.sh download and the
daemon's own update path (`runScriptUrlForChannel` in
`src/instance/run-reconcile.ts`; `tp_installer_host_for_channel` in `run.sh` and
`tp-orchestrate`). The four copies are tested against each other
(`src/instance/installer-host-channel.test.ts`). run.sh only re-fetches itself
from a non-release host when `TURBOPANEL_UPDATE_CHANNEL` says so, which is why
the control plane's install command always carries the channel.

**One channel rule (owner decision 2026-10-01):** every component follows the
channel it was installed from — daemon, instance, UI and the co-located daemon.
An installer run with no channel given uses `release` (`tp_default_update_channel`
in `run.sh`, `turbopanel_update_channel` in the `daemon-config` defaults, the
`default('release')` in the env templates, `resolveUpdateChannelConfig`). The
single exception is a development overlay (`TURBOPANEL_DL_BASE`), whose catalog
only carries trunk. Pinned by `src/instance/default-update-channel.test.ts`.

`live` is the branch a release promotion fast-forwards, so an installer change
reaches new installs at release cadence, matching the `release` channel the
script installs by default. **Keep `scripts/run.sh` at that path on `live`** —
the redirect points straight at the file. Any of 301/302/307/308 works (every
consumer follows it); prefer 307 so a later change of target is not cached by
browsers and proxies. `curl -fsSL https://turbopanel.sh | sh` works because `-L` follows
the redirect (`curl https://turbopanel.sh | sh` without `-L` does not). Always print the `https://` form: a bare host makes curl's first request plain HTTP, and whoever answers it picks the script that runs as root, and every automatic-update consumer already
fetches with `-L`: `tp-orchestrate update` (`CDN_RUN_SCRIPT`), the daemon's
`downloadRunScript` (`src/instance/run-reconcile.ts`), and run.sh's own
re-exec. Threat model is unchanged: a party who could tamper with the domain
could serve a bad script directly, so the redirect widens nothing; the release
rail's signed manifests protect what the script then installs.

**Overlay catalog (`TURBOPANEL_DL_BASE`):** co-located development Caddy serves
`/run.sh` and `/downloads/daemon/*` from the daemon checkout. Remote servers
installed through that overlay receive `TURBOPANEL_DL_BASE=<origin>/downloads/daemon`
(persisted in `daemon.env`) and must **never** fall back to the public rail.
A configured `TURBOPANEL_DL_BASE` that is not https is refused
(`InsecureOverlayBaseError`); only an absent base selects the public rail. `trunk` has no built-in location (the per-merge CDN drop and the `dl.trbp.nl` host left the rail with it): it is only the channel name this overlay catalog uses, and a host without an overlay that still follows it is refused with `preflight_manifest` and told to pick canary, rc or release.
Catalog URLs in `dist/channels.json` / `dist/manifest.json` are relative so the
same files work behind LAN HTTPS on `:8443` and a Cloudflare tunnel.
`run.sh --insecure-tls` still only relaxes the platform-CA instance legs;
public :443 TLS (tunnel) uses the system store. Rebuild the overlay with
`deno task release:dev` (dev console **Rebuild daemon and upgrade connected servers**).
Each `release:dev` stamps overlay `commit` as `<40-char-sha>+<unix-seconds>`
(baked into the binaries **and** the catalog). `sourceUrl` keeps the full
immutable source commit (the SHA before `+`). Remotes skip reconcile when
`getBuildInfo().commit` already matches the catalog; a plain git SHA would
make **U** a no-op until HEAD moves. Production `release` stores the full
40-character git SHA in `BUILD_INFO.commit`, `BUILD_INFO.sourceUrl`, and
`ChannelManifest.commit` (short SHA is only for `buildId` / logs).

## Scope Summary (Former Root Index Entry)

| Subsystem | Read before editing | Covers |
|---|---|---|
| **Installer script hosting** | this file → *Installer script hosting* | **turbopanel.sh** = a redirect (served outside this repo) to `scripts/run.sh` on `live`; dev overlay catalog notes |
