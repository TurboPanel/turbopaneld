# Native Node/Next runtime (`src/deploy/native/`) — AGENTS.md

Parent context: `../AGENTS.md` (tenant deploy & hosting ingress).

When `environment.deploy` carries **`nativeAppServices[]`** (compose services
with `x-turbopanel.serviceKind: node`), those services are in neither Docker
Compose nor a document root. Each entry is
`{ composeServiceName, serviceId, listenPort, framework, nodeVersion?,
resources?, accountLimits? }`; the *release* itself rides the ordinary
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
   `vendor/node-app/<series>/current`. It is **separate from the `node-runtime`
   role**, which vendors the instance's own Node under `vendor/node/current`:
   bumping what tenants execute must never move the panel's toolchain, and vice
   versa. A missing playbook is a warning, not a deploy failure (same rule the
   web engines use). See "Per-app Node version" below.
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
   nothing when neither is needed.
7. Probe `127.0.0.1:<listenPort>` until it answers. Start, the probe
   verdict, and a failed unit's `journalctl` tail are written to the
   command transcript (`health` phase).
8. On probe failure, dump the unit journal **first**, then repoint
   `current` back at the previous release and restart, then fail the
   command.

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
`AmbientCapabilities=`. The single writable path is `ReadWritePaths=<siteShared>`
— the release tree stays read-only to the runtime user, so a compromised app
cannot rewrite the code it is running. No supplementary-group dance is needed
here (unlike the web engines): the app *is* the principal that already has group
read on its own tree.

**Per-app vs per-account limits.** `resources` (clamped service options) becomes
the unit's `CPUQuota` / `MemoryMax`; `accountLimits` (the effective org ∩ server
ceiling, repeated on every app of a principal) becomes the slice. Because every
unit sets `Slice=`, three generous per-app quotas still cannot add up past what
the account is entitled to.

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
something to roll back to. A first deploy has none, and says so in the error
rather than pretending it recovered.

**Next.js.** `build.ts`'s `prepareNativeAppBuildOutput` runs after the build
commands: when `.next/standalone` exists it folds `.next/static` and `public/`
into it (the layout Next documents) and publishes that subtree, so `server.js`
lands at the release root — where the unit's default `ExecStart` looks. An
operator-declared `outputDirectory` always wins.

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
output sees why `node server.js` exited rather than only the 30s timeout.
A source with no `installCommand` / `buildCommand` still ships the
checkout as-is, but the build phase records that — an empty Build section
used to look like the engine skipped the step.

