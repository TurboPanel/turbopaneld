# Git-backed releases (`src/deploy/release/`) — AGENTS.md

Parent context: `../AGENTS.md` (tenant deploy & hosting ingress).

`environment.deploy` payloads may carry **`sourceMaterial[]`** — one entry per
compose service declaring `services.<name>.x-turbopanel.source`. Each entry is
`{ sourceId, composeServiceName, provider, cloneUrl, ref, commitSha,
subdirectory?, credential?, releaseId, rollbackToReleaseId?, principal?,
build }`. Deploy-prepare
resolves the ref to a commit and mints the clone credential
(`turbopanel/src/client/environments/deploy-sources.ts`); the daemon never talks
to the control plane's Git provider itself.

**`cloneUrl` is credential-free by contract** — both wire parsers reject a URL
carrying inline `user:pass@`. The credential arrives as a `tpdaemon` envelope in
`credential`, is decrypted through the same `decryptSecrets` seam everything else
uses (so `captureDecryptedSecrets` puts it in the transcript **and** process-wide
deny-set before git runs), and reaches git only through a `0600` file in the
ephemeral scratch dir that `finally` unlinks. **Which** file depends on
`credentialKind`, because the two transports do not share an auth mechanism: a
`token` (HTTPS PAT / installation token) goes to a private `GIT_ASKPASS` helper
script, while an `ssh_key` (a generic `git` source cloning `ssh://…` or
`git@host:path`) is written as an identity file and named via
`GIT_SSH_COMMAND -i … -o IdentitiesOnly=yes -o IdentityAgent=none` with a
scratch `UserKnownHostsFile`. An askpass helper cannot answer publickey auth, so
an SSH source with a token-shaped injection would simply fail to clone. When
`credentialKind` is absent (a payload minted before the field existed) the clone
URL's transport decides.

A `token` payload may also carry **`credentialUsername`** — the basic-auth user
the askpass helper answers git's `Username` prompt with, defaulting to
`x-access-token` when the payload names none. It is opaque here on purpose:
which user an HTTPS credential authenticates as is provider policy (GitLab's
OAuth tokens authenticate only as `oauth2`, GitHub ignores the user for an
installation token), and stating it as payload data is what keeps that knowledge
in the control-plane provider instead of adding an `if provider === …` to the
daemon. `checkout.ts` prints the string and never inspects it. Never argv, never the URL, never an environment
variable the build command can inherit — the env carries only the *paths*, and
`checkout.ts` and `build.ts` both spawn with `clearEnv` and an explicit
allow-list.

**Layout** (path helpers live in `src/paths/layout.ts` — `siteRoot`,
`siteReleasesDir`, `siteCurrentSymlink`, `siteSharedDir` — so the site
serving change in the next phase addresses the same tree without restating it):

```
<principalHomeRoot>/.tp-staging/                 root:tp 0710 (publish-open)
  <username>.<serviceId>.<releaseId>/            tp 0700 until tp-host publish
<principalHomeRoot>/<username>/sites/            root:<username>-grp 0750
  <serviceId>/                                   root:<username>-grp 0750
    releases/                                    root:<username>-grp 0750
      <releaseId>/        root:<username>-grp, top 0550, nothing g/o-writable
      <releaseId>/.turbopanel/release.json        per-release manifest
      <releaseId>/shared -> ../../shared              relative convenience link
    current -> releases/<releaseId>
    shared/               <username>:<username>-grp 0750
    .turbopanel-hosting/  root:<username>-grp 0750  (hosting.env / php.json)
```

Every published release carries a relative **`shared` symlink** at its root
(tp-host `publish`, or `linkReleaseSharedDir` where the daemon owns the
tree), so `current/shared` is a stable
writable path for *any* release-backed service. That is generic on purpose: the
site serving path pins PHP `open_basedir` to it, and the
native runtime relies on the same convention rather than inventing a
second one. A build that ships its own `shared` entry is replaced — the link is
part of the layout contract, not payload.

**No release link may leave the release or reach into `shared`**
(`release-links.ts`). `shared/` is tenant-writable, so a shipped
`public/x -> ../shared/evil` is a second hop the tenant can repoint at another
principal's sealed, root-owned file after publish; the engines' owner-match
rules compare only the first link (root, from the seal) with the final target
(root) and would serve it. `promoteRelease` therefore removes the build's own
`shared` entry, lists every link with `realpath -m` **before** the layout link
exists (so a `shared/…` tail resolves under `<releaseDir>/shared`, never through
the tenant's real directory), and refuses the release if any target is outside
the release or under `shared`. Apps reach `shared/` by path (`current/shared`,
PHP `open_basedir`), not through a link the build ships. nginx additionally
serves a release-backed document root with `disable_symlinks on`; Apache keeps
`SymLinksIfOwnerMatch`, because `.htaccess` `RewriteRule` needs it.

A published release is **read-only to the runtime user** on purpose: an app
process that can rewrite its own code turns any RCE into persistence. That is an
*ownership* rule, not only a mode: `sites/<serviceId>` and `releases/` are
root-owned too, so the principal cannot create, rename, or unlink inside them —
it could otherwise plant a release directory or repoint `current` regardless of
how tight each published release is. `shared/` is the one principal-owned,
principal-writable path. A release directory is never created unsealed under
`releases/`: tp-host refuses `install -d` / `mkdir -p` there, and only
`publish` (below) renames a sealed tree in. Directory creation for the rest
reuses the single `sudo -n install -d` seam in `ensure-principal.ts`
(`ensureDirectoryWithOwner` for the root-owned side,
`ensureDirectoryOwnedByPrincipal` for `shared/`); retention removal goes
through the same `sudo -n` runner seam, never a second mkdir helper. The daemon
is **not** in `<username>-grp`, so it cannot traverse the root-owned `0750`
site tree: unprivileged `readlink` of `current`, the rollback swap and the
probes fall back to that same `sudo -n` runner when Deno returns EACCES. Tests
that own a temp tree keep the Deno path (copy, link, manifest, probe, seal,
link check and swap in place).

**Order per entry** (`apply-source-releases.ts`): ensure tree → `resetReleaseScratchDir`
→ **checkout** (`fetch` phase) → **build** (`build` phase) → **stage / manifest /
probe / seal / cut over** (`release-promote` phase) → **prune**, with the
ephemeral scratch dir removed in `finally` whether or not the release succeeded.
`ensureSystemPrincipals` runs first for every principal the payload implies —
including one named only by `sourceMaterial[].principal` — because the release
publishes into that principal's home. An entry with **no** principal is skipped
with a transcript line rather than failing the deploy: ownership is assigned in
the control plane, not guessed on the host.

**Rollback: promote without rebuilding** — a `sourceMaterial[]` entry carrying
`rollbackToReleaseId` takes a separate branch at the top of `applyOneRelease`
(`rollbackOneRelease`). It is deliberately **not** a new command type: it rides
the ordinary `environment.deploy` payload, so compose apply, ingress, TLS,
retention, `deployment.json`, and the native / site promote hooks all
keep working unchanged, and the generation-supersede rule still applies. That
branch skips `ensureReleaseTree`, the scratch dir, checkout, and build entirely
and calls `promoteExistingRelease` (verify the tree exists — and, where the
daemon account can stat it, that it is sealed at `0550` → optional health probe
→ `swapCurrentSymlink`) instead of `promoteRelease`. Only the `release-promote`
phase is emitted; there is no `fetch` or `build` line, because neither happened.
A missing target directory **fails** rather than skipping: "the release you
asked for was pruned on this host" is exactly what the operator needs told.

**A rollback trusts only the daemon's own release record.** Every successful
promote — native or Railpack — leaves a copy of its manifest under the
daemon-owned `<daemonStateDir>/release-records/` root
(`resolveDaemonReleasePaths`); for the native lane it is written after the seal
and swap succeed, so its existence is this host's statement that the release was
published. `resolveRollbackTarget` reads that record and nothing else: the copy
inside a native release tree sits in the principal's home, which the principal
owns, so neither the lane (`imageTag`), the commit, nor the runtime shape is
ever taken from it, and no privileged read of that tree exists. A release with
no record (published before records were kept) **fails** with "redeploy that
release" rather than falling back to the tree. `commitSha`, `standaloneOutput`,
and `staticExport` in the returned `AppliedRelease` come from that record — the
payload's `commitSha` is a placeholder on a rollback, and `staticExport` decides
whether the service is supervised as a unit or served as files, so guessing it
would put the service on the wrong lane.

**Staged build, atomic promote** — the same staged-write / validated-cutover
contract `compose-files.ts` uses for `compose.yaml`. The clone lands in an
ephemeral scratch dir under `<daemonStateDir>/release-build/`, never inside the
release tree. Only after the build succeeds is the output staged, the manifest
written, and the health probe run against the staged tree (this phase: "the
expected paths exist"; later phases swap in a real runtime probe). Then the
tree is sealed and `current` is swapped by creating `current.tmp.<releaseId>`
as a symlink and `rename()`-ing it over `current` — atomic on the same
filesystem, so a reader sees the old release or the new one, never a missing
link. **Any failure before the rename leaves `current` untouched** and removes
the staged tree; there is no partial publish.

**Sealed publish** (managed hosts). `tp-host publish-open <user> <svc> <id>`
makes a fresh leaf `<principalHomeRoot>/.tp-staging/<user>.<svc>.<id>`, owned by
the daemon (0700) under a `root:tp 0710` parent that no tenant or build can
reach, on the homes' filesystem. The daemon copies the build output into it
(the hand-off below), drops any `shared` entry, writes the manifest and runs
the probe. `tp-host publish <user> <svc> <id>` then, as root and with every
path built from the ids: takes the leaf (`root:root 0700`), refuses hard-linked
files (before any `chown -R`, so no outside inode is re-owned), FIFOs,
sockets, devices and a shipped `shared`, seals it
(`chown -R -h -P root:<user>-grp`, `chmod -R u-s,g-s,go-w,g+rX,o-rwx`) and
re-checks that nothing is left foreign-owned, set-id or group/other-writable,
resolves every symlink physically (`realpath -m`) and refuses one that lands
outside the leaf (so the two-link `s1/s2/up → ../..` + `s1/s2/s3/x → ../up/..`
chain is caught), requires the home, `sites/`, `sites/<svc>/` and `releases/`
to be root-owned and not group/other-writable, the leaf and `releases/` to
share `st_dev`, and `releases/<id>` not to exist, then `mv -T`s the leaf into
place, links `shared → ../../shared`, drops the top to `0550` and swaps
`current`. A directory planted at `current` or `current.tmp.<id>` is refused
(and the generic `ln` uses `-T`, so the rollback swap never links into one).
Any refusal before the rename removes the leaf. tp-host also refuses absolute
link targets (a link to the staging path would dangle or reach another leaf
once renamed) and links resolving to or under the leaf's `shared`, clears the
sticky bit in the seal, holds a per-release `flock` (`/run/tp-publish/`) over
`publish-open` and `publish`, requires the home root itself to be sealed,
sweeps leaves older than an hour, and checks that `releases/<id>` is the
sealed leaf (`dev:ino`) before it links, opens to `0550` or swaps `current`.
When a home's `releases/` is on another filesystem than the staging area, the
sealed, root-owned leaf is copied by root to a root-only name beside the
release and renamed in. The daemon runs `release-links.ts`'s
`assertStagedLinksStayInRelease` on the leaf before `publish` (the in-place
path runs it plus `assertReleaseLinksStayHome` after the seal). A re-sent
deploy of a release this host already published (same id and commit in the
daemon's record, tree present) is cut over to like a rollback instead of
being rebuilt.

**Symlink-safe hand-off** (`safe-copy.ts`). The build controls every name in
its tree, so every copy out of it — the stage into `releases/<releaseId>/` and
the Next fold — goes through `copyContainedTree`, never a plain recursive copy:
the source directory is reached from the checkout one `lstat`ed component at a
time (a symlinked, absolute or `..` `subdirectory` / `outputDirectory` /
`.next/standalone` / `.next/static` / `public` / `out` is refused, and the real
path must stay under the root's); entries are never followed; a regular file is
checked on its opened handle (same inode and device as the `lstat`, so a swap
is refused, not read); a symlink is kept only when it is relative and its `..`
run, all leading, stays within its own depth (`linkStaysInside`), otherwise
dropped; FIFOs, sockets and devices are dropped; set-id, sticky and
group/other-write bits are stripped; nothing is chowned; an entry owned by
anyone but the source root's owner (a hard link to a root file) is refused;
destinations are created one component at a time and files with `O_EXCL`, so a
link planted at a destination is refused; entries (500 000), bytes (16 GiB) and
depth (128) are capped. On a managed host the checked copy lands in the
daemon's staging leaf (`ReleasePaths.stagingDir`, recreated fresh by
`publish-open`, outside the build's tree) and root only ever operates on that
leaf once it has taken it from the daemon: root never walks a tree a build
wrote, and never reads a name another account can still change. (The earlier
`<daemonStateDir>/release-handoff/` copy and the root `cp -a` into the release
are gone.) Deno has no `openat2`, so a directory
swapped and swapped back between two calls is out of reach of these checks; the
unprivileged-builds design closes that by handing the tree back only once the
build unit's processes are gone and the tree belongs to the daemon again.

**Sandboxed build, containerless runtime.** `build.ts` is explicitly not
container isolation and does not claim to be. It guarantees: the command runs in
the scratch checkout (never the live tree or the principal home); no daemon
credential material is inherited (`clearEnv` + allow-list; build `env` is
non-secret by contract — build secrets keep riding `variableMaterial[]` /
`secretPlan[]`); and CPU / address-space / file-size caps via `prlimit` where the
host has it, degrading to an unwrapped run with a transcript note where it does
not. The address-space cap is **64 GiB virtual**, not 4 GiB: V8 pointer
compression reserves a 4 GiB CodeRange per isolate, and Corepack/pnpm workers
each need their own — `RLIMIT_AS=4G` dies with `Failed to reserve virtual
memory for CodeRange`; `16G` lets Node start but pnpm's registry GETs fail
with `error (unknown)` / `ERR_PNPM_META_FETCH_FAIL`. That cap is virtual
size, not RSS.

**Native-app builds run on the tenant runtime.** `ensureNativeAppRuntime`
vendors `vendor/node-app/<series>/current` **before** `applySourceReleases`,
because the install line (`corepack pnpm install`, …) runs in the Git build —
not after promote. When an entry belongs to a `nativeAppServices[]` row,
`buildNativeRelease` hands `runReleaseBuild` a `nativeRuntime`: the vendored
series' `bin/` leads a **curated** `PATH` (`<bin>:/usr/bin:/bin`, never the
daemon's PATH — Deno's `node_compat_bin` would shadow `node`, and an
unreadable `/usr/local/sbin` makes dash report `corepack: Permission denied`
for a missing binary). The child is `sudo -n -u <self> -- env … sh -c` so
`initgroups()` picks up `tpnode<series>` without a daemon re-login and
without exec'ing the passwd shell (`sg` dies on `/usr/sbin/nologin` with
"This account is currently not available" — the managed daemon user `tp`
and tenant principals are both nologin). Corepack still caches under
`<checkout>/.corepack` with its download prompt off — never a host-wide
Corepack install, never the daemon's home. `NODE_ENV` follows the app's
`appMode` (default `production`) in the build exactly as in the generated unit.

A missing `installCommand` is then **derived** rather than skipped
(`deriveNodeInstallCommand`): the operator's `build.packageManager` wins, else
the lockfile decides (`pnpm-lock.yaml` > `yarn.lock` > `package-lock.json` >
bare npm) — `corepack pnpm install --frozen-lockfile --prod=false`,
`corepack yarn install --frozen-lockfile --production=false` for classic yarn,
`npm ci --include=dev` / `npm install --include=dev`; the frozen flag is
dropped when the chosen manager has no lockfile, and Yarn Berry (a
`packageManager: yarn@2+` pin or a `.yarnrc.yml`) gets plain
`corepack yarn install`, because Berry has no `--production` flag and `CI=1`
already makes its install immutable. The dev-deps flags are load-bearing: the
build runs under `NODE_ENV=production`, where npm, pnpm, and classic yarn
silently omit `devDependencies` — which is where every build toolchain lives.
An explicit `installCommand` always wins, no `package.json` derives nothing,
and the transcript records a `derived install command …` line so the operator
can see what ran.

**Retention** — `retention.ts` keeps the newest `DEFAULT_RELEASE_RETENTION` (5)
releases **plus whatever `current` resolves to**, even when that falls outside
the newest N. A rollback re-points `current` at an older release; pruning it for
being old would delete the running application. Removal is best-effort per
entry — retention must never fail a deploy that already promoted.

**Whole-tree reclaim for removed services** — per-service pruning only ever walks
services the current deploy is still publishing, so a service dropped from the
compose (or one that merely lost its `x-turbopanel.source` binding) would leave
its `releases/`, `current`, and `shared/` behind forever. `deployment.json`
`releases[]` is the host's durable record of what the *previous* deploy
published, which is why each row also carries the owning **`username`** — once
the payload stops naming the service there is nothing left to derive its
principal home from. `deploy-environment.ts` diffs those rows against the
`serviceId`s the payload still sources and hands the difference to
`reclaimRemovedReleaseTrees` (`retention.ts`), which `rm -rf`s the whole tree
through the same privileged runner sealing uses. It runs **after**
`applySourceReleases` (so a tree this deploy is publishing into is never a
candidate) and **before** the new manifest is written. Path segments are
re-validated on the way out — the manifest is read back from disk, so it is not
trusted to name a safe path. A service that is still sourced keeps its tree even
if its principal changed: reclaiming it would delete live `shared/` state.
Best-effort per entry, like the rest of retention.

**Sites now serve out of `current`.** `deploy-environment.ts`
builds a `composeServiceName → { serviceId, username }` map from
`sourceMaterial[]` (`deployReleaseBindings`, resolving `serviceId` through the
same {@link resolveReleaseServiceId} rule) and hands it to
`applySites`, which is why `applySourceReleases` runs *before* the
site apply. The map is rebuilt on **every** deploy, not only when a
release was freshly promoted — a redeploy that does not touch the source still
has to point the document root at `current`. Process supervision from
`x-turbopanel.source.startCommand` — now carried on
`EnvironmentDeploySourceBuild` — belongs to the native runtime instead; see the
Native Node/Next runtime section.

**Release-tree cleanup is generic, not site-specific.**
`environment.stop` carries `siteReleases[]` (`{ serviceId, username }`) and
removes `<principalHome>/sites/<serviceId>` recursively through the privileged
runner — the tree is root-owned, so the daemon cannot unlink it itself. Removal
is best-effort per entry and never fails the stop, matching the fabric-network
and tcp/udp reclaim in the same handler. The control plane captures the list
while the `tenancy` rows still exist
(`turbopanel/src/client/environments/site-releases.ts`), because by the time the
daemon runs a delete-triggered stop they are already gone.

That list is a **union of two sources**, for the same reason the daemon keeps
`username` in `deployment.json`: the current merged compose only describes
services that still declare a source, so a service removed from the compose drops
out of it immediately. Each deploy therefore records the trees it published into
`deployment.options.siteReleases` (`resolveSourcedEnvironmentSiteReleases`, wired
in `deploy-routes.ts`), and `resolveEnvironmentSiteReleases` returns the current
set plus that record. The recorded side stays current-only so it cannot grow
without bound — once a redeploy has reclaimed a removed tree on the host, the
record written by that same deploy no longer names it.

## Railpack image releases (`build.kind: railpack`)

A source binding may set `x-turbopanel.source.buildKind: railpack`, which
deploy-prepare passes straight through as `sourceMaterial[].build.kind`. That is
the **fourth deploy pattern** on this host, alongside compose, site,
and native app — and the four differ only in what a release *is*:

| pattern | what a release is | how it runs |
| --- | --- | --- |
| compose | nothing (no source) | `docker compose up` on the authored image/build |
| site | a promoted directory | a host engine vhost serves `current` |
| native app | a promoted directory | a generated systemd unit runs out of `current` |
| **Railpack** | **an OCI image tag** | `docker compose up` on that tag |

Concretely (`release/railpack-build.ts`, branch in `apply-source-releases.ts`):

- Checkout is identical — `checkout.ts` unchanged, same scratch dir, same
  credential handling.
- `railpack prepare` writes a build plan; `docker buildx build` hands that
  plan to the pinned Railpack **BuildKit gateway frontend** on the **Docker
  Engine's own BuildKit** (`--builder default`, `BUILDKIT_SYNTAX=<frontend>`,
  `-f <plan>`, `--load`), through the same `docker` CLI path and sudo ladder as
  compose builds (`runDockerStreamed`). A `docker buildx version` preflight
  names `docker-buildx-plugin` when the plugin is missing; a failed build
  reports the redacted tail of BuildKit's own output.
- **No private `buildkitd`.** The daemon runs as `tp`, and a non-root
  `buildkitd` demands rootless mode (rootlesskit, newuidmap/newgidmap,
  subuid/subgid for `tp`): on adrastea it exited with "rootless mode requires to
  be executed as the mapped root in a user namespace" and the lane only ever saw
  a readiness timeout. A root `buildkitd` socket would be a second privileged
  build API the Docker gate cannot observe. The Engine's builder already exists
  for compose builds, and its `/session` / `/grpc` upgrades already pass through
  the gate. `buildctl` / `buildkitd` are no longer on the daemon's `--allow-run`.
- The docker CLI **never** gets the build environment: tenant `build.env` and
  `HOME=<checkout>` go to `railpack prepare` only. The CLI resolves plugins from
  `$DOCKER_CONFIG` / `$HOME/.docker/cli-plugins`, so a checkout shipping
  `.docker/cli-plugins/docker-buildx` would otherwise run as the daemon user.
- The frontend is **pinned by digest**. `buildkit-setup` vendors it as a local
  OCI layout at `<runtimesDir>/railpack-frontend/<version>/image` (with a
  `current` symlink) plus its manifest digest, and its `docker pull` leaves the
  same image in Docker's store. The build names
  `ghcr.io/railwayapp/railpack-frontend@<digest>`, so a repointed upstream tag
  cannot change what two releases recorded with the same
  `railpackFrontendVersion` were built by. If the store lost the image, the
  vendored layout is `docker load`ed back first; if even that fails the Engine
  can only fetch exactly that digest.
- Output goes straight into the image store (`--load`): no tarball handoff.
- **Tenant isolation is `cache-key=<projectId>`**, which Railpack prefixes to
  every mount cache id (package-manager stores, `node_modules`). Mount caches
  are writable and shared by id, so without it one tenant could read or poison
  another's. The Engine's layer cache is per host, as it is for compose builds
  (and as it was for the old private `buildkitd`).
- Build env is **not** passed to the frontend: it reads only `cache-key`,
  `secrets-hash` and `github-token` build args, so the old `--opt env:K=V` never
  reached a build. Build secrets need `railpack prepare --env` plus `--secret`
  (follow-up), never values on argv.
- Everything the native lane does *after* the build is skipped. Nothing is
  staged, sealed, or linked, and `current` never moves. There is no promoted
  tree, so a Railpack release needs **no project principal** — the guard that
  skips a principal-less entry is relaxed for this branch only, because there is
  no filesystem tree for a Unix account to own. The image runs as an ordinary
  container under whatever service-level limits already apply.
- The per-release manifest is still written, to
  `releases/<releaseId>/.turbopanel/release.json` under the daemon-owned
  `<daemonStateDir>/release-records/` root (`resolveDaemonReleasePaths`), so both
  lanes keep release history in one place and one shape. It carries `imageTag`,
  `imageDigest`, `railpackFrontendVersion`, and `railpackPlanVersion`.

**Feeding the image into compose.** `deploy-environment.ts` builds a
`composeServiceName → imageTag` map from the returned `AppliedRelease[]` and
`applyRailpackImagesToComposeYaml` sets `services.<name>.image` (dropping any
authored `build:`) on the compiled runtime document **before**
`docker compose config` validates it. This is a pre-processing pass on the same
compose document, deliberately not a second orchestration path: Traefik labels,
hosting Caddy, storage mounts, and `docker compose ps` container reporting all
go on treating the service as the ordinary container it is. A Railpack service
is **not** host-native and never appears in `hostNativeComposeServiceNames()` /
`resolveHostNativeLanes` — it stays `serviceKind: container` and never enters
`sites[]` / `nativeAppServices[]`.

**Rollback** rides the existing `rollbackToReleaseId` field with no new command
type. The daemon record identifies the lane: a record carrying `imageTag`
short-circuits the whole promote — no checkout, no build, no symlink swap, just that tag written back
into compose. Reading the record rather than the payload's `build.kind` is
what lets a service that switched build modes still roll back to a release built
the old way.

**Retention.** `pruneReleases` walks `releases/` by directory listing and is
unchanged. A Railpack release directory contains only
`.turbopanel/release.json`, so pruning one removes **its manifest, not a running
container** — the container keeps running under the still-tagged image until a
later deploy supersedes it. Pruning it does mean that release id can no longer
be rolled back to, which is the same guarantee the native lane gives.

**Provisioning is on demand.** `ensureBuildkitRailpack` follows the
`ensureDocker` / `ensureHostingCaddy` pattern exactly: check the vendor tree →
`buildkit-setup.yml` (`runBuildkitSetup`) → direct download of railpack and the
frontend → re-check → throw. It is called only when a `railpack` build is
actually requested, never from `daemon-converge` or `instance-dev-install`.
`RAILPACK_VERSION` in `railpack-build.ts` is pinned in step with
`orchestration/roles/buildkit/defaults/main.yml`; bumping one without the other
leaves the daemon looking for a version directory that was never vendored. The
role still vendors `buildctl` / `buildkitd`; the daemon no longer runs them.

