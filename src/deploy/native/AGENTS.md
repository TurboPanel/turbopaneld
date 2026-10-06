# Native Node/Next runtime (`src/deploy/native/`) — AGENTS.md

Parent context: `../AGENTS.md` (tenant deploy & hosting ingress).

When `environment.deploy` carries **`nativeAppServices[]`** (compose services
with `x-turbopanel.serviceKind: node`), those services are in neither Docker
Compose nor a document root. Each entry is
`{ composeServiceName, serviceId, listenPort, framework, nodeVersion?,
appMode?, enabled?, startupFile?, resources?, accountLimits? }`; the *release*
itself rides the ordinary
`sourceMaterial[]` lane, so checkout, build, promote, retention, and
`siteReleases[]` reclaim are all unchanged and kind-agnostic. This module only
decides how a promoted `current` is **run**.

**Why a third kind rather than a container.** A release tree is already an
atomically promoted, root-owned `0550` directory owned by a real Linux
principal. Running it directly buys the tenant a start with no image build, no
registry, and no per-service daemon, and buys the platform one supervision
mechanism it already trusts on the host. What it does not buy is container
isolation, and the unit is written so that difference is honest rather than
nominal — see the hardening set below.

`applyNativeAppServices` runs after `applySourceReleases` and after the
site apply, because a unit's `WorkingDirectory` must resolve before
the unit starts. Per app:

1. Vendor the tenant Node runtimes on first use —
   `playbooks/node-app-runtime-apply.yml` (`node-app-runtime` role) installs
   `vendor/node-app/<series>/current`. `handleEnvironmentDeploy` calls
   `ensureNativeAppRuntime` **before** `applySourceReleases` so the Git build
   can exec that tree; `applyNativeAppServices` calls it again (idempotent)
   before units are installed. The role also appends the daemon account
   (`tp` / dest user) to `tpnode<series>` so a build child can
   `sudo -n -u <self>` into that group without a daemon re-login (`sg` execs
   nologin and cannot). It is **separate from the
   `node-runtime` role**, which vendors the instance's own Node under
   `vendor/node/current`: bumping what tenants execute must never move the
   panel's toolchain, and vice versa. A missing playbook is a warning, not a
   deploy failure (same rule the web engines use). See "Per-app Node version"
   below.
2. Add every principal in the deploy to the **`tpnodeapp`** group
   (`ensureSupplementaryGroupMembership`). systemd `execve()`s `ExecStart`
   *after* dropping to `User=`, so the principal itself needs read + traverse on
   the vendored Node tree; see "Reaching the vendored Node" below. Best-effort
   per principal for the same reason step 1 is: a host whose orchestration
   assets were not shipped may legitimately have no such group, and the health
   probe in step 7 is what catches a genuinely unreachable runtime.
3. Install/refresh the per-principal slice
   `/etc/systemd/system/turbopanel-<username>.slice` from `accountLimits`
   (`CPUQuota` / `MemoryHigh` / `MemoryMax` / `TasksMax`).
4. Install/refresh **every** unit
   `/etc/systemd/system/turbopanel-app-<serviceId>.service`. The
   `turbopanel-app-` prefix follows the existing `turbopanel-*` convention
   (`turbopanel-nginx`, `turbopanel-apache`, …), so a generated tenant unit can
   never collide with a distro unit.
5. `systemctl daemon-reload` — **once per apply, after every changed file is on
   disk, and only if at least one slice or unit changed**. Steps 3–5 are ordered
   against each other on purpose: a reload issued the moment a *slice* changed
   would run before the units were installed, and the restart in step 6 would
   then start the app from the unit contents systemd loaded before this deploy.
   Writing everything first and reloading once is the only sequence in which
   systemd is guaranteed to have read every file the apply touched.
6. `enable --now` on first deploy, `restart` when the unit is already active,
   nothing when neither is needed — unless the operator set `enabled: false`,
   which issues `disable --now` instead (see "Operator disable" below).
7. Probe `127.0.0.1:<listenPort>` until it answers. Start, the probe
   verdict, and a failed unit's `journalctl` tail are written to the
   command transcript (`health` phase).
8. On probe failure, dump the unit journal **first**, then — only when the
   previous release once answered on this host — repoint `current` back at
   it, re-render the unit for that release's recorded start, reload if it
   changed and restart; otherwise stop the unit. Then fail the command.

**Render → diff → install-if-changed** is the same discipline the vhost path
uses, and the same reasoning: a candidate is staged under
`<configDir>/node-apps/tp-<environmentId>-<serviceId>.service`, compared against
the installed unit through a privileged `cmp -s` (the daemon is not root and
`/etc/systemd/system` is, so a direct read would report "changed" every deploy),
and installed only on a real difference. `WorkingDirectory` points at the
`current` **symlink**, never at a release directory — which is exactly what
makes the unit text byte-identical across promotes, so an ordinary redeploy
writes nothing, reloads nothing, and only restarts.

**The staged directory is the per-environment index.** `environment.lifecycle`
and `environment.stop` find this environment's units by listing
`<configDir>/node-apps/` for the `tp-<environmentId>-` prefix, exactly as the
site remove path does — no second bookkeeping file that could drift
from what is actually installed.

**Hardening.** Each unit runs as the principal (`User=<username>`,
`Group=<username>-grp`) under its account slice, with `NoNewPrivileges=yes`,
`PrivateTmp=yes`, `ProtectSystem=strict`, `ProtectHome=yes`,
`ProtectKernelTunables=yes`, `ProtectKernelModules=yes`,
`ProtectControlGroups=yes`, `RestrictSUIDSGID=yes`, `RestrictRealtime=yes`,
`LockPersonality=yes`, and an **empty** `CapabilityBoundingSet=` /
`AmbientCapabilities=`. The only writable path is the site's own `shared/`
(`ReadWritePaths=<shared>`): a Node app writes only its own site folder, never
the principal's `home/`, `data/` or `tmp/` (an owner decision; cron jobs, by
contrast, get those three through `principalReadWritePaths`). `HOME=<home>/home`
stays read-only to the app, and `TMPDIR=/tmp` is the unit's private `/tmp`.
The home root, `sites/` and the release tree stay read-only to the runtime
user, so a compromised app cannot rewrite the code it is running. No supplementary-group dance is needed
here (unlike the web engines): the app *is* the principal that already has group
read on its own tree.

**Entrypoint.** Most specific first (`resolveExecStart` in `unit.ts`): an
explicit `build.startCommand` runs through `/bin/sh -c` untouched;
`startupFile` (a validated relative path — `isSafeSourceSubdirectory` at the
contract boundary) runs as `<vendored node> <startupFile>`; otherwise the unit
runs the start the **build detected** and recorded with the release
(`nativeStart`, `start-entry.ts`); a release recorded before that existed runs
`<vendored node> server.js`. A blank `startupFile` counts as unset.

When the author typed neither, `prepareNativeAppBuildOutput` (`build.ts`) picks
the start from the built tree in the usual Node convention, after the Next
cases: a Next standalone build → `node server.js`; else the `package.json`
`start` script → `node --run start` (a script that is just `next start …` is
run as Next's CLI instead, see below); else a Next app (`framework: next`, or a
`.next/` build) → `node node_modules/next/dist/bin/next start --hostname
127.0.0.1 --port <listenPort>`; else the `package.json` `main` file (when it
exists and is one safe argument: no spaces, `%`, `$`, leading `/` or `-`, or
`..`); else `index.js`, then `server.js`. Nothing found fails the **build**,
before promote, with "no start command: … Add a start script to package.json,
or set a start command for this service." — never a unit that can only
crash-loop. The decision is detected at build time because the daemon cannot
read a published release (it is not in the site owner's group), and it is
recorded in the daemon's release record (`ReleaseManifestV1.nativeStart`) so a
rollback restarts the old release the way it ran. Every detected start execs
the vendored Node directly: no shell, and no Corepack at runtime.

**Loopback bind.** The unit exports `HOST=127.0.0.1` **and**
`HOSTNAME=127.0.0.1`: Next's standalone `server.js` reads `HOSTNAME` and binds
every interface without it. `next start` reads neither (only `--hostname`), so
the Next entry passes `--hostname` and `--port` on argv. An author's own start
command or start script must bind `HOST`/`HOSTNAME` itself.

**Application mode.** `appMode` renders as `Environment=NODE_ENV=<mode>` in the
unit (default `production`) and rides into the release build as the same value
(see `../release/AGENTS.md`, native-app builds), so a `development` app builds
and runs under one mode instead of two.

**Operator disable.** An app with `enabled: false` still gets its unit
installed (step 4) and its release promoted — step 6 issues
`systemctl disable --now` instead of a start/restart, with no loopback probe
and no rollback: a unit that is *supposed* to be down answering nothing is the
desired state, not a failed deploy. The service still counts in `applied`, the
transcript records the disable, and re-enabling is an instant start of what is
already on disk, not a re-render or rebuild. `disable --now` on an
already-stopped unit is a no-op, so repeat deploys of a disabled app stay
quiet.

**Per-app vs per-account limits.** `resources` (clamped service options) becomes
the unit's `CPUQuota` / `MemoryMax`; `accountLimits` (the effective org ∩ server
ceiling, repeated on every app of a principal) becomes the slice. Because every
unit sets `Slice=`, three generous per-app quotas still cannot add up past what
the account is entitled to.

**Supervision.** `nativeAppServices[].restartPolicy` arrives in the **Compose**
vocabulary — the control plane never decides what a unit says — and `unit.ts` is
the single place it becomes systemd's: `condition` → `Restart=` (`any` is
`always`, `none` is `no`, `on-failure` spells the same in both), `delay` →
`RestartSec=`, `max_attempts` → `StartLimitBurst=`, `window` →
`StartLimitIntervalSec=`. The two rate-limit directives are `[Unit]`, not
`[Service]`, so they are emitted apart from `Restart=`; systemd would ignore
them under `[Service]`. A payload carrying no policy renders the historical
`Restart=on-failure` / `RestartSec=2` verbatim — the install path is a byte
diff, so any other default would rewrite every existing unit and restart every
tenant app on the next deploy. Values outside the honourable subset never
arrive: the control-plane linter refuses them at save and at deploy, and
`parseNativeAppService` refuses them again here, because the payload is
untrusted input to this process and each value becomes a directive.

**Service labels.** `nativeAppServices[].serviceLabels` is the author's
`deploy.labels` — *service* metadata, never container labels, and never
behaviour. It is recorded as one sorted `X-TurboPanel-Labels=<json>` line in
`[Unit]`, so `systemctl show` answers on this lane what `docker inspect`
answers on the container one. One JSON object rather than a directive per
label: a Compose label key is free-form (`com.example.team`) where a systemd
directive name is not, and `JSON.stringify` escapes every control character, so
a label value containing a newline cannot break out into a directive of its
own. Keys are sorted so the rendered text is a function of the label set alone.

**Variables.** `nativeAppServices[].variables[]` carries the app's environment
variables, resolved by the control plane (all scopes merged, secrets already
filtered to the ones the author referenced): `{ name, value }` for a plain
value, `{ name, secretKey }` for a secret, where `secretKey` points at the
daemon-sealed `variableMaterial[]` entry for the same compose service. The
`node` service is not in the compose document the host runs, so this is the only
lane that reaches the process. `variables-runtime.ts` decrypts the referenced
secrets (the same `decryptSecrets` the compose secret files use, so transcript
redaction applies), then **stages** one `0600` file per app,
`<configDir>/node-apps/envs/<serviceId>.env` (directory `0700`, inside the
daemon-owned `node-apps` leaf), via temp file + rename, and runs
`sudo tp-host app-env-install <serviceId>`: `tp-host` checks the staged file and
copies it to `<configDir>/node-app-env/<serviceId>.env`, a root-owned folder
(`0700`, files `0600`), and the daemon deletes the staged file. The unit loads
the **root copy** with `EnvironmentFile=` — and only when the app has variables,
so a unit without them is byte-identical to before. systemd reads that file as
root, so it must never name a path the daemon can write (the daemon could swap
it for a link to any root-only file; the text of the path cannot prove what it
points to). Rules that are not obvious:

- **A file, never `Environment=` lines.** Unit text is `0644`, shows in
  `systemctl show`, and has `%` expanded; the file is root-read and private.
- **`EnvironmentFile=` overrides `Environment=` whatever the line order**, so
  the platform's own names (`NATIVE_APP_PLATFORM_ENV_NAMES` in `unit.ts`:
  `PATH`, `NODE_ENV`, `PORT`, `HOST`, `HOSTNAME`, `HOME`, `TMPDIR`, `XDG_CACHE_HOME`,
  `COREPACK_*`) are dropped from the file, and the transcript says which. A
  unit test keeps that set equal to the `Environment=` keys the unit renders.
- **Quoting.** Values are single-quoted (literal: no `$`, no backslash
  handling); a value containing `'` is double-quoted with `\ " ` $` escaped.
- **Line endings.** `tp-host` refuses any carriage return (systemd and its
  checker could read one differently), so `normalizeNativeAppEnvValue` turns
  every CR LF in a value, plain or decrypted, into LF (a PEM pasted from a
  Windows editor). A CR that is not half of a CR LF, or a NUL, fails the deploy
  naming the app and the variable, never the value.
- **Lifecycle.** Staged and copied on every deploy before the unit is installed
  (the restart that follows is what delivers a changed value). An app left with
  no variables loses its root copy (`app-env-remove`) only after its new unit
  (no `EnvironmentFile=`) is installed, reloaded and restarted, so a
  crash-restart in between never finds the file gone; a refused removal is a
  warning, retried by the next deploy. `removeNativeAppServices` removes the
  copy with the unit. A secret that has no sealed material or will not decrypt
  fails the deploy, naming the variable and never the value. A file over
  `NATIVE_APP_ENV_MAX_BYTES` (1 MiB, equal to `TP_APPENV_MAX` in `tp-host`)
  fails the deploy naming the app.
- **`tp-host`** accepts `EnvironmentFile=` in a tenant unit only for
  `turbopanel-app-<id>.service`, only equal to the root copy's path for the same
  `<id>`, and only `app-env-install` / `app-env-remove` (a service id, never a
  path) touch that folder; no generic verb accepts a path in it (see the
  `tp-host` bullet in `../../../AGENTS.md`). A new `tp-host` is needed before the
  daemon that calls the verbs (the update playbooks install it first).
- Unlike the compose secret files (tmpfs `/run`, rehydrated after a reboot),
  the copy lives on disk under `/etc` so the unit can start at boot before the
  daemon is up. The daemon cannot read it back.

**Health probe.** Any completed HTTP response counts as started — a 404 or a 500
is a running app, and this gate answers "did the release come up", not "is the
application logically correct". `Type=simple` reports active the moment the
process forks, long before a listener exists, so `systemctl` alone is not
evidence. The probe is bounded by attempts rather than wall-clock so the sleep
seam fully controls timing in tests.

**Rollback.** `promoteRelease` already guarantees a failed *build* leaves
`current` untouched; a release that builds and promotes cleanly can still fail
to start, and that is what step 7 covers. `applySourceReleases` reports
`previousReleaseId` (read before the swap) precisely so the native apply has
something to roll back to. **Only a release that once answered is a target**
(`../release/release-health.ts`): when a probe answers, the apply writes a
`.healthy` mark into that release's daemon-owned record, and a rollback needs
the mark on a finalized (not `.pending`) record. Restoring a release that never
came up would only swap one crash loop for another while the error claimed a
recovery. With no healthy previous release (a first deploy, a release recorded
before marks existed, or one that never answered) the unit is **stopped** and
the error says which case it was; the next deploy starts it again. The unit is
re-rendered for the restored release's own recorded start (`nativeStart`), so
a `next start` release that fails rolls back to a `node server.js` one
correctly.

**Next.js.** `build.ts`'s `prepareNativeAppBuildOutput` runs after the build
commands: when `.next/standalone` exists it folds `.next/static` and `public/`
into it (the layout Next documents) and publishes that subtree, so `server.js`
lands at the release root and the unit runs `node server.js`. Without
`output: "standalone"` the whole build tree ships (with a warning) and the app
runs `next start` on 127.0.0.1. A standalone build with an author start command
that needs package scripts or `next` (`pnpm start`, `next start`) gets a build
warning: the standalone tree has neither. An operator-declared
`outputDirectory` always wins (no fold, no export detection; only the start is
looked for inside it).

**A statically exported build leaves this lane.** When the build emitted
`output: 'export'` instead — an `out/` tree with an `index.html` and no
standalone server — there is no process to supervise, and a systemd unit for it
would be a unit that can never answer its health probe. So `out/` is published
as the release payload and the build reports `staticExport`;
`deploy-environment.ts`'s `resolveHostNativeLanes` then moves that service onto
the **site static lane** (nginx, document root `current`, same
loopback port) and generates **no** unit for it. The hostname routing, the port,
and the release tree are unchanged — only the thing serving them differs. The
payload itself is never rewritten and the operator is not asked to re-declare
`serviceKind` to get a working deploy. Detection is deliberately narrow: an
`out/` directory alone is a name many toolchains use, so an `index.html` inside
it is required as corroboration, and a build that also emitted
`.next/standalone` is always treated as a server build.

**Per-app Node version.** `nativeAppServices[].nodeVersion` is a **series**
("24", "24.17", "24.17.0"), not necessarily a patch pin. `apply-native-apps.ts`
collects the distinct series this deploy needs (an app that declared none
contributes `DEFAULT_NATIVE_APP_NODE_VERSION`) and passes them to the vendoring
playbook as `-e {"node_app_versions": [...]}`; the role resolves the newest
upstream release inside each series and points
`vendor/node-app/<series>/current` at it. The unit's `ExecStart` is
`<runtimesDir>/node-app/<series>/current/bin/node`
(`nativeAppNodeBinary` in `native/unit.ts`), so two apps on different series run
genuinely different binaries while a patch bump inside a series moves nothing in
the unit text. The tenant tree stays under `node-app/` rather than `node/`
because `vendor/node/current` is the panel's own toolchain.

**Reaching the vendored Node.** The tree is `root:tpnodeapp 0750` — **not**
world-readable. Tenant principals have only their own `<username>-grp` and are
deliberately never added to `tp` (the panel's own group), so `tpnodeapp` (gid
**9988**, group with no user) exists purely to mean "may execute the vendored
tenant Node". Its two parents, `/opt/turbopanel` and `vendor/`, stay `tp:tp
0750` and grant the group **traverse-only** through a POSIX ACL
(`ansible.posix.acl`, `node-app-runtime` role) rather than an `o+x` mode bit, so
a principal can reach `node-app/` without being able to list either parent. Two
consequences worth knowing:

- `turbopanel-user` recursively fixes ownership only under `vendor/uv`,
  `vendor/python`, and `vendor/ansible` — the three subtrees bootstrap
  populates. A blanket recurse over `vendor/` would hand `node-app/` back to
  `tp:tp` on every converge and leave tenant units failing `203/EXEC`.
- The vendoring shell `chown -R root:tpnodeapp` + `chmod -R u=rwX,g=rX,o=` each
  extracted release: `cp -a` otherwise preserves the upstream tarball's
  world-readable `0755`.

**Container-only paths must never see a host-native hosting.** Neither lane has
a service in the runtime compose, so a hosting that names one has no compose
service to attach a Traefik label to — passing it to the overlay builder aborts
the deploy with `Compose service not found` before anything starts.
`hostNativeComposeServiceNames()` is the single definition of that set
(`sites[]` ∪ `nativeAppServices[]`), and `containerHostings` is its
complement; shared/per-service Traefik ingress, `buildHostingLabelsFragment`,
and deployed-container collection all take the complement.

**Hosting Caddy is the deliberate exception** — it treats the two host-native
lanes identically, because a site vhost and a native app are both a
process on `127.0.0.1:<port>`, so `buildCaddyHostnameRoutes` builds one loopback
map from `sites[]` **and** `nativeAppServices[]` straight off the
payload. Both lanes also allocate
out of **one** shared port ledger on the instance side, or a site and an app
could be handed the same port and whichever bound second would die with no
diagnostic near the cause.

`environment.lifecycle` applies `start` / `stop` / `restart` to this
environment's app units alongside the compose action (best-effort per unit, like
the ingress step). `environment.stop` disables and removes them, then removes
the unit files and `daemon-reload`s — **before** `siteReleases[]` reclaim, so
systemd never restarts a unit whose `WorkingDirectory` has just been deleted.
The per-principal **slice is deliberately left behind**: other environments of
the same account still reference it, and an unreferenced slice costs nothing.

Transcript: fetch / build / release-promote still bracket the Git release.
Native start, the loopback probe, and (on probe failure) a `journalctl`
dump of the unit land under **`health`**, so an operator opening Deploy
output sees why the app exited rather than only the 30s timeout.
A source with no `installCommand` / `buildCommand` still ships the
checkout as-is, but the build phase records that — an empty Build section
used to look like the engine skipped the step.

