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
<principalHomeRoot>/<username>/sites/            root:<username>-grp 0750
  <serviceId>/                                   root:<username>-grp 0750
    releases/                                    root:<username>-grp 0750
      <releaseId>/        staging 0750 → published 0550, root:<username>-grp
      <releaseId>/.turbopanel/release.json        per-release manifest
      <releaseId>/shared -> ../../shared              relative convenience link
    current -> releases/<releaseId>
    shared/               <username>:<username>-grp 0750
    .turbopanel-hosting/  root:<username>-grp 0750  (hosting.env / php.json)
```

Every published release carries a relative **`shared` symlink** at its root
(`promoteRelease` → `linkReleaseSharedDir`), so `current/shared` is a stable
writable path for *any* release-backed service. That is generic on purpose: the
site serving path pins PHP `open_basedir` to it, and the
native runtime relies on the same convention rather than inventing a
second one. A build that ships its own `shared` entry is replaced — the link is
part of the layout contract, not payload.

A published release is **read-only to the runtime user** on purpose: an app
process that can rewrite its own code turns any RCE into persistence. That is an
*ownership* rule, not only a mode: `sites/<serviceId>` and `releases/` are
root-owned too, so the principal cannot create, rename, or unlink inside them —
it could otherwise plant a release directory or repoint `current` regardless of
how tight each published release is. `shared/` is the one principal-owned,
principal-writable path, and a staging release is root-writable only until the
seal. Directory creation reuses the single `sudo -n install -d` seam in
`ensure-principal.ts` (`ensureDirectoryWithOwner` for the root-owned side,
`ensureDirectoryOwnedByPrincipal` for `shared/`); sealing (`chown -R root:<grp>`
+ `chmod 0550`) and retention removal go through the same `sudo -n` runner seam,
never a second mkdir helper. The daemon is **not** in `<username>-grp`, so it
cannot traverse the root-owned `0750` site tree: unprivileged `readlink` of
`current`, staging copy, the `shared` link, the per-release manifest, the health
probe, and the atomic `current` swap all fall back to that same `sudo -n` runner
when Deno returns EACCES. Tests that own a temp tree keep the Deno path.
`install -d` repairs an existing directory's owner
and mode, so a tree from the earlier principal-owned layout converges on the
next deploy.

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
— `ensureReleaseTree` in particular would `install -d` the sealed release back
to staging mode and hand the runtime user a writable copy of the code it runs —
and calls `promoteExistingRelease` (verify the tree exists and is sealed at
`0550` → optional health probe → `swapCurrentSymlink`) instead of
`promoteRelease`. Only the `release-promote` phase is emitted; there is no
`fetch` or `build` line, because neither happened. A missing target directory
**fails** rather than skipping: "the release you asked for was pruned on this
host" is exactly what the operator needs told. `commitSha`, `standaloneOutput`,
and `staticExport` in the returned `AppliedRelease` are read back from the
target release's `.turbopanel/release.json` — the payload's `commitSha` is a
placeholder on a rollback, and `staticExport` decides whether the service is
supervised as a unit or served as files, so guessing it would put the service on
the wrong lane.

**Staged build, atomic promote** — the same staged-write / validated-cutover
contract `compose-files.ts` uses for `compose.yaml`. The clone lands in an
ephemeral scratch dir under `<daemonStateDir>/release-build/`, never inside the
release tree. Only after the build succeeds is the output copied into
`releases/<releaseId>/`, the manifest written, and the health probe run (this
phase: "the expected paths exist"; later phases swap in a real runtime probe).
Then the tree is sealed and `current` is swapped by creating
`current.tmp.<releaseId>` as a symlink and `rename()`-ing it over `current` —
atomic on the same filesystem, so a reader sees the old release or the new one,
never a missing link. **Any failure before the rename leaves `current`
untouched** and removes the staged directory; there is no partial publish.

**Sandboxed build, containerless runtime.** `build.ts` is explicitly not
container isolation and does not claim to be. It guarantees: the command runs in
the scratch checkout (never the live tree or the principal home); no daemon
credential material is inherited (`clearEnv` + allow-list; build `env` is
non-secret by contract — build secrets keep riding `variableMaterial[]` /
`secretPlan[]`); and CPU / address-space / file-size caps via `prlimit` where the
host has it, degrading to an unwrapped run with a transcript note where it does
not.

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
- `railpack prepare` writes a build plan; `buildctl` hands that plan to the
  pinned Railpack **BuildKit gateway frontend** against a vendored `buildkitd`
  on a private socket under `<daemonStateDir>/release-build/`.
- The frontend is **vendored, not pulled**. `buildkit-setup` installs it as a
  local OCI image layout at
  `<runtimesDir>/railpack-frontend/<version>/image` (with a `current` symlink,
  like the binaries) and records the layout's manifest digest beside it; the
  build passes `--oci-layout <name>=<dir> --opt source=oci-layout://<name>@<digest>`.
  Naming `ghcr.io/railwayapp/railpack-frontend:<tag>` at build time would put
  live registry egress on the deploy path and let a repointed upstream tag
  change what two releases recorded with the same `railpackFrontendVersion`
  were actually built by.
- Output handoff is a **`type=docker` tarball plus `docker load`**, not a shared
  containerd/moby store. The vendored BuildKit is its own daemon and is not
  wired into Docker's storage, so the tarball is the one handoff that works on
  every host we install on; the cost is one extra copy through the filesystem,
  which is deleted as soon as the load succeeds.
- Build cache is **per project**:
  `<daemonStateDir>/release-build/buildkit-cache/<projectId>/`, passed as
  `--import-cache` / `--export-cache local`. One tenant's build can never warm
  from another's layers.
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
type. Which root holds the target release identifies its lane: the record root
is probed first, and a manifest carrying `imageTag` short-circuits the whole
promote — no checkout, no build, no symlink swap, just that tag written back
into compose. Probing the manifest rather than the payload's `build.kind` is
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
`buildkit-setup.yml` (`runBuildkitSetup`) → direct binary download → re-check →
throw. It is called only when a `railpack` build is actually requested, never
from `daemon-converge` or `instance-dev-install`. `BUILDKIT_VERSION` /
`RAILPACK_VERSION` in `railpack-build.ts` are pinned in step with
`orchestration/roles/buildkit/defaults/main.yml`; bumping one without the other
leaves the daemon looking for a version directory that was never vendored.

