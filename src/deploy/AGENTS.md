# Tenant deploy & hosting ingress — AGENTS.md

The `environment.deploy` / `environment.lifecycle` / `environment.stop` command handlers: Docker Compose bring-up with Traefik labels, hosting Caddy (`:80`/`:443`, distinct from control-plane Caddy), org TLS materialization from `tpdaemon` envelopes, non-destructive start/stop/restart, and best-effort container reporting.

**Managed engines are a separate path** (`../managed/AGENTS.md`): platform-owned
compose + config under `<stateDir>/managed/<managedId>/`, native ports only, no
hosting Caddy, no tenant Traefik/`turbopanel-ingress`, no user compose merge,
shared ProxySQL frontend (`turbopanel-proxysql` / `managed-ingress`). Do not
route `managed.*` commands through this deploy stack.

Root context: `../../AGENTS.md`. Instance-side command pipeline: `../../../turbopanel/src/lib/commands/AGENTS.md`. Cross-repo `../<repo>/…` links are relative to the repo root.

## Tenant Docker Compose deploy + hosting ingress

`environment.deploy` (command router →
`src/instance/commands/deploy-environment.ts`):

1. Ensure Docker engine (`ensureDocker` → `runDockerSetup` when the binary is
   missing or the Engine API is unreachable). Docker CLI calls fall back to
   `sudo -n -u <self> -- docker …` when the socket is permission-denied so the
   first deploy after group membership still works without a daemon restart
   (`sg docker` fails for `/usr/sbin/nologin` service accounts with "This
   account is currently not available"). If that still cannot open the socket,
   `runDocker` tries `sudo -n -- docker …` (`tp` has `NOPASSWD:ALL`).
   `resolveDockerInvocation()` probes the **same ladder** up front (direct →
   `sudo -n -u <self>` → `sudo -n --`) so the streamed path has identical
   Docker access.
2. Bootstrap Traefik on Docker network `turbopanel-ingress` **only when the
   deploy has at least one container HTTP hosting with hostnames** (shared
   loopback entrypoints `127.0.0.1:7080` / `127.0.0.1:7443`, PROXY protocol,
   …). Bare container deploys (no hostnames / no HTTP hosting rows) never start
   the platform `-in` Traefik or declare the external ingress network on
   compose. When
   `<stateDir>/system/hosting-ingress.json` is present,
   `ensureHostingIngress` passes that descriptor into `traefikCompose()` so
   the shared container gets allocated `container_name` /
   `x-turbopanel` / labels. Tenant HTTP `environment.deploy` may write that
   descriptor first from payload `hostingIngress` (`persistHostingIngressIdentity`)
   so the first hostname deploy is not anonymous `turbopanel-ingress-traefik-1`.
   When absent (or corrupt — logged and ignored),
   the anonymous pre-identity shape is written for older payloads that omit
   `hostingIngress` and have not yet run `system.reconcile`, so tenant deploys
   cannot orphan an allocated inventory row by rewriting anonymous compose
   over an identity-bearing Traefik.
3. Ensure vendored hosting Caddy (`ensureHostingCaddy` — Ansible `caddy-setup`
   then direct GitHub download) when
   `/opt/turbopanel/vendor/caddy/current/caddy` is missing. On-demand like
   Docker; daemon-converge does not install it. Required for hostname ingress.
4. When `principalMaterial[]` is present, ensure Linux users/groups on the host
   (`ensureSystemPrincipals` in `src/deploy/ensure-principal.ts`). Homes live
   under `layout.principalHomeRoot` (default `/srv/users/<username>`):
   home `0750`, `.ssh` `0700` (reserved for `authorized_keys`), and `volumes`
   `0750`, all owned `username:<username>-grp`. UID/GID are host-assigned
   unless an explicit operator override arrives on the payload. Username max
   length is **28** so `<username>-grp` fits the Linux 32-char group-name
   limit (keep in sync with instance `MAX_PRINCIPAL_USERNAME_LENGTH`). When a GID
   override is supplied and `<username>-grp` already exists with a different
   numeric GID, ensure fails (conflict) instead of silently attaching the
   principal to that group. Shell comes from `principalMaterial[].shell`
   (default `/usr/sbin/nologin`) via `useradd -s` / `usermod -s`. Existing
   accounts are adopted only when the passwd **home** matches the expected
   path — a username collision with a foreign home fails the deploy instead
   of mutating that account. Shell is still reconciled via `usermod -s`;
   never `usermod -m` / `-d`. Directory creation uses `sudo -n install -d`
   so a non-root daemon can write under `/srv`.
5. When `storageMaterial[]` is present, materialize each **location** under
   `<stateDir>/storage/<organizationId>/<storageId>/<locationId>/data`
   (`materializeLocation` in `materialize-storage.ts`); `docker volume create`
   for `kind=volume` + `provider=docker` using instance-supplied **`volumeName`**
   (the storage UUID; else legacy `tp-<org8>-<name>`). Optional `chown` when a
   principal is linked. The instance owns Docker volume naming. Path-provider
   directory/file entries arrive with `sourcePath` — principal-owned defaults
   are `/srv/users/<username>/volumes/<storageId>` (explicit operator paths
   still win). Never write under `/var/lib/docker/volumes`.
6. Decrypt `variableMaterial[]` via `POST /api/daemon/v1/secrets/decrypt` and
   write Compose standalone secret files under
   `<runDir>/deployments/<projectId>/<environmentId>/secrets/` (`secret-runtime.ts`,
   mode `0600`, dir `0700`). Write the payload `.env` (non-secrets only, `0640`)
   next to staged `compose.yaml`. Overlay mounts from each entry's **`mounts[]`**
   (`apply-storage-volumes.ts`) — docker volumes emit
   `volumes.<name> = { name, external: true }` so Compose mounts the
   pre-created volume (not a `<project>_<name>` orphan); entries may have an
   empty `mounts[]` when the volume is only compose-declared.
7. Write compiled `compose.yaml` plus `.env` plus `deployment.json` under
   `<stateDir>/deployments/<projectId>/<environmentId>/` (see **Compiled
   compose publish** below). Daemon overlay fragments (storage,
   site reachability, Traefik labels) are merged into that single
   file before publish — **not** secrets. HTTP hostings that share a hostname are merged into one
   Caddy site with `handle` / path matchers (`pathPrefix`); Traefik routers
   already used `pathPrefix` via compose labels.
8. Ensure payload `fabricNetworks[]` as routed bridges with the given subnet/MTU
   (`ensureFabricDockerNetworks` in `src/instance/commands/fabric.ts`, default
   MTU 1420) **before** compose up. This reuses the fabric creation path, **not**
   `ensure-docker-networks.ts` (which creates plain bridges).
9. Run pre-deploy hooks (`serviceHooks[]`: optional `build --no-cache`, shell
   preDeployCommand). When the payload sets `noCache: true`, run
   `docker compose build --no-cache --pull` for the whole project, then
   `docker compose up -d --remove-orphans`, then post-deploy hooks
   (`run-deploy-hooks.ts`).
10. When the payload includes `tlsMaterial[]`, materialize org certs under
   `layout.tlsDir` (`/etc/turbopanel/tls/<tlsId>/fullchain.pem` + `privkey.pem`,
   modes `0640`/`0600`) via `materializeTlsCertificates`
   (`src/deploy/materialize-tls.ts`). Private keys arrive as `tpdaemon`
   envelopes — decrypt only through `POST /api/daemon/v1/secrets/decrypt`
   (daemon JWT); never log plaintext.
11. Refresh hosting Caddy config under `/etc/turbopanel/hosting/`
   (`auto_https off` always). Per-hostname site blocks use
   `tls <fullchain> <privkey>` when a resolved `tlsId` was materialized;
   otherwise `tls internal`. When `hostings[].bindAddress` is set, both the
   HTTPS site block and the `forceHttps` HTTP redirect block emit a Caddy
   `bind <address>` directive (IPv4/IPv6 literal validated before interpolation)
   so neither listener attaches to all interfaces — sourced at deploy-prepare
   time from hosting `bind` scope: **public** pinned `ip` row, **datacenter**
   private `ip` (`scope = 'datacenter'` on the target server), or **local**
   loopback `127.0.0.1`. Unit `turbopanel-hosting-caddy.service` when sudo
   allows. **Distinct** from control-plane Caddy (`:8443`).
12. Best-effort `docker compose ps --format json` — per-container identity/status
   (`containerId`, `containerName`, `composeServiceName`, `status`, optional
   `serviceId` from `payload.hostings`) is included in the command result when
   collection succeeds; a `ps`/parse failure never fails an otherwise-successful
   deploy.

## Git-backed releases (`src/deploy/release/`)

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
never a second mkdir helper. `install -d` repairs an existing directory's owner
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
while the `service` / `steward` / `principal` rows still exist
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

### Railpack image releases (`build.kind: railpack`)

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

## Streamed transcript capture (execution logs)

Deploy / lifecycle / stop / `managed.apply` stream their Docker + hook output
line-by-line to the control plane while the command is still running. The
buffered `DockerCliResult` and the bounded WS `command-outcome` `result` are
unchanged — the transcript is a **separate, never load-bearing** channel.

- **Streaming seam** — `runDockerStreamed(args, { onLine })`
  (`src/deploy/docker-cli.ts`) tees stdout/stderr per line while still buffering
  both into the same `DockerCliResult` `runDocker` returns. It resolves the
  docker invocation once via `resolveDockerInvocation()` (a streaming spawn
  cannot buffer-then-retry the sudo fallback mid-stream, so the probe walks the
  full direct → `sudo -n -u <self>` → `sudo -n --` ladder). `createStreamedRunner(runDockerOverride?)`
  picks it, or replays a buffered test seam through `onLine`, so host-free
  suites exercise the transcript path without spawning docker. Deploy shell
  hooks (`run-deploy-hooks.ts`) stream their own stdout/stderr the same way.
- **Sink** — handlers take an optional `logSink?: CommandOutputSink` in their
  existing deps object (`EnvironmentDeployDeps`,
  `EnvironmentLifecycleHandlerDeps`, `EnvironmentStopHandlerDeps`,
  `ManagedApplyHandlerDeps`); the default is a **no-op sink**, so every existing
  caller and test is unchanged. `command-router.ts` builds the real sink once
  per command execution from the dispatch envelope's own `id` and calls
  `logSink.finalize()` in a `finally` beside the `command-outcome` send.
- **Redaction before spool** — the deny-set is built from values this command
  actually decrypted: the `decryptSecrets` seam is wrapped by
  `captureDecryptedSecrets` (`src/logs/capture.ts`), so variable material,
  principal passwords, and TLS private keys all join it; `managed.apply` also
  adds its credential plaintexts. Every line is `replaceAll`-scrubbed to `***`
  and stripped of log-injection control characters **before** it is written to
  disk — plaintext never reaches the spool file. Never a generic
  secret-scanning heuristic. Deny-set construction (`normalizeDenySet`) keeps
  each plaintext **exactly** as decrypted *and* expands multiline material into
  its individual lines, so a PEM private key is scrubbed even though the sink
  sees one line at a time. `managed/apply.ts`'s error `redactSecrets` shares
  the same deny-set construction via `redactPlaintexts`
  (`src/logs/redactor.ts`).
- **Failure summaries** — a thrown error message is usually raw process
  stdout/stderr and lands in persisted command history, which the per-line
  transcript redaction never reaches. Every handler runs it through
  `logSink.redactSummary(...)` (`CommandOutputSink`, `src/logs/contracts.ts`)
  before throwing, and `command-router.ts` redacts once more when building
  `command-outcome.error`. The no-op sink redacts too — a daemon without an
  upload transport must not be the configuration that leaks plaintext — and
  `run-deploy-hooks.ts` falls back to the process-wide deny-set when no
  redactor is passed.
- **Spool path** — `<stateDir>/spool/execution-logs/<commandId>.log`
  (`commandLogSpoolDir(layout)` in `src/paths/layout.ts`), file mode `0600`
  under a `0700` dir, NDJSON `CommandOutputEvent` per line with a monotonic
  `sequence`. The file is the durability source of truth; the in-memory buffer
  is only a batching cache.
- **Phases** — lines are tagged with the deploy step they belong to: `prepare`,
  `pull`, `fetch`, `build`, `release-promote`, `pre-deploy`, `compose-up`,
  `health`, `post-deploy`, plus `hooks`, `managed-apply`, `lifecycle-start` /
  `lifecycle-stop` / `lifecycle-restart`, and `stop` (`COMMAND_LOG_PHASES` in
  `src/logs/contracts.ts`). `fetch` / `release-promote` bracket the Git-backed
  release engine; its build output shares the existing `build` phase.
- **Wire format** — the ingest contract counts **chunks**, not lines: `seq` is
  zero-based and gap-free per command (the first upload is always `seq = 0`),
  and `bytes` is standard base64 of the chunk's raw UTF-8 transcript bytes.
  `MAX_COMMAND_LOG_CHUNK_BYTES` is enforced against the **decoded** size, the
  same value `turbopanel/src/daemon/execution-log-ingest.ts` measures. The
  NDJSON `sequence` stays a per-line spool-file concern and never goes on the
  wire.
- **Upload cadence** — batched to `POST /api/daemon/v1/commands/:commandId/log`
  (`DaemonApiClient.sendCommandLogChunk`) when the buffer reaches ~64 KB or
  ~750 ms, and once more on `finalize()`. Retry uses capped backoff; a chunk
  that still cannot be delivered is warned and dropped — an upload failure must
  never change a command outcome.
- **Truncation** — past `MAX_COMMAND_LOG_BYTES` (2 MiB per command) a single
  `... transcript truncated ...` marker line is uploaded and no further chunks
  are sent for that command; spooling stops too, so the on-disk file cannot
  grow past the cap. The transcript counts as sealed **only when the marker was
  acked** — a marker that could not be delivered is unacked work, so the spool
  file is kept for the orphan sweep.
- **Orphan sweep** — a fully-acked spool file is deleted by `finalize()`; one
  left behind by a crash or a failed upload is best-effort re-uploaded and
  deleted (`src/logs/orphan-sweep.ts`, called from `src/instance/client.ts`).
  It runs **once per daemon process**, not on every reconnect, and skips any
  spool file a live sink still owns (`isActiveSpoolPath` in
  `src/logs/spool.ts`) — handlers outlive socket lifetime, so a sweep must
  never touch an in-flight transcript. A leftover file is replayed whole as
  chunk `seq = 0`: the control plane treats a seq below its `nextSeq` as an
  idempotent no-op, while a higher one would be rejected as a gap.

## Compiled compose publish

`environment.deploy` publishes a **single compiled** `compose.yaml` (overlay
already merged) plus `.env` (non-secrets) plus `deployment.json` under
`<stateDir>/deployments/<projectId>/<environmentId>/`. Lifecycle/stop resolve
that tree. `src/deploy/compose-files.ts` owns the path/argv/manifest helpers;
`resolveDeployComposeFiles` (`deploy-environment.ts`) takes the payload's
`composeFiles[]` — the instance compiler emits a single
`{ filename: 'compose.yaml', role: 'runtime', source: 'inline', content }`
entry. There is no `composeYaml` fallback on `environment.deploy`.

- **Staged write + validated cutover:** each deploy resets
  `<deploymentDir>/.staging/`, writes the compiled YAML there, resolves the
  merged Docker Compose model, merges the daemon overlay fragment into that
  one document (`mergeOverlayIntoComposeYaml` in `compose-overlay.ts`), then
  runs `docker compose config` against the staged file. Only after validation
  succeeds does `publishStagedRuntimeCompose` copy `compose.yaml` into the live
  deployment dir, write `deployment.json`, and prune leftover layered
  `*.yml`/`*.yaml`. A failed
  redeploy therefore leaves the previous live files intact.
- **Deployment-dir layout:**
  `<stateDir>/deployments/<projectId>/<environmentId>/compose.yaml` +
  `.env` (non-secrets, `0640`) +
  `deployment.json` (`DEPLOYMENT_MANIFEST_FILENAME`, version 2: project /
  environment / server ids, generation, project name, compose sha256, replica
  counts, optional `secrets[]` plan, optional `serviceIds` map — compose service
  name → service UUID, which is what lets the container-log collector resolve
  identity from deployment state instead of live container labels — and optional
  `releases[]`, one row per applied `sourceMaterial[]` entry
  (`composeServiceName`, `serviceId`, `releaseId`, `sourceId`, `commitSha`,
  optional `ref`, optional `username`) so the reboot / reconnect paths that
  already read this file know **which release and commit** each Git-backed
  service is on without asking the control plane, and so the *next* deploy can
  still address the release tree of a service that has since been removed from
  the compose (that is what `username` is for — see "Whole-tree reclaim for
  removed services"); `.turbopanel/release.json` answers the release/commit
  question per release directory, this one answers it per environment. Both
  `serviceIds` and `releases` are optional on read — an older manifest that lacks
  them parses exactly as before). All compose/manifest files are written mode `0640`
  (`writeComposeFileSecure` force-chmods after write since truncate-in-place
  does not narrow an existing more-permissive mode).
- **Daemon overlay:** `buildDaemonOverlayFragment` merges, in this fixed
  order, the storage bind/volume-mount fragment,
  site ⇄ Docker reachability fragment (`extra_hosts` +
  `TURBOPANEL_SITE_*` env), and hosting Traefik-label fragment
  (`mergeComposeOverlayFragments` in `compose-overlay.ts`). The merged
  fragment is folded into the compiled YAML before publish — not a separate
  `docker-compose.turbopanel.daemon.yml` layer. Secrets are **not** overlay
  fragments. Because that fold is an in-process record merge (**not**
  `docker compose -f a -f b`), a list value over a mapping value is a type
  mismatch where the later fragment wins outright: the hosting/managed
  network union emits **mapping** form whenever the compiled service declares
  per-network options, or it would delete the instance's friendly-name
  `aliases` (see `unionServiceNetworks`).
- **Secrets:** durable `compose.yaml` must not be the long-term secret store.
  Compiled YAML references Compose standalone `secrets.file` paths under
  `/run/turbopanel/deployments/<projectId>/<environmentId>/secrets/` (mode
  `0600`). Values arrive as `tpdaemon` envelopes in `variableMaterial[]`.
  After JWT session, `rehydrateLocalDeployments` (`rehydrate-deployments.ts`)
  calls `POST /api/daemon/v1/deployments/secrets/rehydrate`, decrypts via
  `/secrets/decrypt`, rewrites files, then `docker compose up -d` (first
  connect always; reconnect only if planned files are missing). The instance
  omits material when the daemon's `deployment.json` generation does not match
  `deployment.desiredGeneration`; the daemon also refuses to materialize or
  `compose up` when the returned generation differs from the local manifest.
  Lifecycle `start`/`restart` rehydrate first when files are absent.
  `environment.stop` deletes the `/run` tree. Build secrets belong on Compose
  `build.secrets`, not `build.args`.
- **`-f` argv:** `composeFileArgs(projectName, paths)` builds
  `compose -p <project> -f <p1> …` — today a single compiled `compose.yaml`.
  Every `docker compose` invocation (`config` validation, `build`, `up`,
  lifecycle start/stop/restart, stop's `down`) uses this helper.
- **Lifecycle / stop:** `lifecycle-environment.ts` and `stop-environment.ts`
  call `resolveEnvironmentDeploymentDir` then `resolveDeployedComposePaths`,
  which reads the compiled `compose.yaml`.
  Lifecycle `start`/`restart` call `ensureDeploymentSecretFiles` when
  `deployment.json` lists `secrets[]`. Stop also `rm -rf`s the matching
  `/run/.../secrets` tree.
- **Local service preflight is tag-aware:** `composeHasContainerServices` /
  `composeFilesHaveContainerServices` parse `!reset` / `!override` so the
  container-services gate before Docker does not fail solely because of
  Compose Spec tags; parse failures are treated as "may have services"
  (docker compose `config` remains authoritative).

## Raw TCP/UDP port hosting (non-HTTP docker services)

`hostings[].protocol` (`http` default/omitted, or `tcp`/`udp`) lets a Docker
service (Postgres, a game server, a UDP relay, …) publish raw port(s) straight
through a **per-service Traefik** instead of routing hostnames through hosting
Caddy — **no** hostname/TLS/path routing for those hostings;
`hostings[].ports[]` (required, non-empty for `tcp`/`udp`) is a
`{ published, target }` list.

**Managed engines do not use this path** — they enter via the shared ProxySQL
project (`turbopanel-proxysql` / `managed-ingress`). This section applies only
to **tenant** docker-compose hostings.

**HTTP hostings are excluded** from this path: they stay on the shared
loopback Traefik (`turbopanel-ingress` / `traefikCompose()` — `web` /
`websecure` only, no published public ports) via Docker labels. They never
get a per-service Traefik project or an `ingressServices[]` entry.

- **Compose labels** (`compose-labels.ts` `applyTcpUdpHostingLabels`): one
  `traefik.tcp.routers.<hostingId>-<published>` / `traefik.udp.routers…` pair
  per published port, plus `com.turbopanel.service=<serviceId>` (from
  `injectHostingLabels`). TCP routers get a catch-all `HostSNI(\`*\`)` rule;
  UDP routers take no rule label. Both get a `…loadbalancer.server.port`
  label targeting the container port.
- **Per-service Traefik** (`serviceTraefikCompose` / `ensureServiceIngress`):
  every service in `payload.ingressServices[]` gets its own compose project
  `turbopanel-ingress-<serviceId>` under
  `<stateDir>/ingress/services/<serviceId>/`, with
  `container_name: <serviceId>-in`,
  `x-turbopanel: { kind: ingress, serviceId, containerName }`, joined to
  `turbopanel-ingress`, and
  ``--providers.docker.constraints=Label(`com.turbopanel.service`,`<serviceId>`)``.
  Static config is regenerated (not hot-reloaded): one quoted
  ``--entrypoints.<protocol><port>.address=:<port>[/udp]`` arg and one quoted
  ``"<bind>:<port>:<port>/<protocol>"`` `ports:` line per entry (bind defaults
  `0.0.0.0`; IPv6 bracketed; `assertValidBindAddress`). Entries are deduped
  and sorted for a stable diff.
- **Cross-service port uniqueness**: claim files live at
  `<stateDir>/ingress/tcp-udp/<serviceId>.json`
  (`syncTcpUdpIngressEntries`). Sync reads every *other* service's file
  (`collectTcpUdpIngressEntries`), rejects with `TcpUdpPortConflictError`
  when another service already claims the same `protocol`+`publishedPort`
  (**no partial write** on conflict), then writes this service's file (or
  deletes it when empty) and returns **this service's own entries** for
  `ensureServiceIngress`. Deploy syncs ingress **before** app `compose up`.
- **Stop**: `removeEnvironmentTcpUdpServiceIngress` unions payload
  `ingressServices[]` with the daemon-persisted environment index
  (`ingress/by-environment/<environmentId>.json`), then
  `removeServiceIngress` + `removeTcpUdpIngressEntries` for each and clears
  the index. Payload alone is not teardown truth — a hosting deleted or
  flipped to HTTP before stop still cleans stale Traefik. Shared HTTP
  Traefik is left alone here (tcp/udp no longer live there); the control
  plane retires it separately with `system.reconcile` `action: 'stop'` once
  the last hostname hosting leaves the server (project / environment delete).
- **Docker seam**: every ingress helper takes `{ runDocker }` and the deploy /
  stop handlers thread their injected `runDocker` into `ensureHostingIngress`,
  `ensureServiceIngress`, `cleanupStaleTcpUdpServiceIngress` and
  `removeEnvironmentTcpUdpServiceIngress`. Leaving one unthreaded makes the
  default CLI run for real — tests with a fake `runDocker` then start actual
  Traefik containers on the host and leave them behind.
- Extraction: `buildTcpUdpIngressEntries` maps each `tcp`/`udp` hosting's
  `ports[]` to one `TcpUdpIngressEntry` (with that hosting's `bindAddress`).

`environment.stop` (command router →
`src/instance/commands/stop-environment.ts`):

1. `docker compose -p <projectName> -f compose.yaml down --remove-orphans --volumes`
   against `resolveDeployedComposePaths` (compiled `compose.yaml`, else v1
   manifest, else legacy `docker-compose.yml`) — idempotent no-op when no
   compose file exists.
2. Best-effort `docker network rm` for payload `fabricNetworks[]` (`tpn_*`)
   then prune those names from `state.json` so boot re-reconcile does not
   recreate them. Missing / active-endpoint errors must not fail the stop.
3. Remove `/etc/turbopanel/hosting/sites/<environmentId>.caddy` via
   `removeHostingCaddySite` and best-effort reload hosting Caddy; remove
   sites.
4. Tear down per-service tcp/udp ingress via
   `removeEnvironmentTcpUdpServiceIngress` (payload ∪ environment index).
5. Delete the deployment directory.
6. Return authoritative `containers: []` so the instance clears Postgres
   container pins.

`environment.lifecycle` (command router →
`src/instance/commands/lifecycle-environment.ts`):

1. Require a compiled or legacy-resolved compose file
   (`resolveEnvironmentDeploymentDir` + `resolveDeployedComposePaths`) —
   missing compose **fails** with a deploy-first message (unlike idempotent
   stop).
2. `docker compose -p <projectName> -f compose.yaml <start|stop|restart>` —
   never `down`, `--volumes`, or `--remove-orphans`.
3. Best-effort apply the same action to each per-service Traefik project for
   this environment (`readEnvironmentTcpUdpServiceIds` →
   `serviceIngressComposePath` / `serviceIngressProject`); log and continue
   on failure. Read-only w.r.t. claim files.
4. Best-effort `docker compose … ps -a --format json` (include stopped
   containers); omit `containers` from the result when collection fails so
   the instance skips reconcile.
5. **Never** removes volumes, the deployment dir, hosting Caddy sites, or
   tcp/udp claim files.

Helpers: `src/deploy/ensure-docker.ts`, `src/deploy/ingress.ts`,
`src/deploy/labels.ts`, `src/deploy/ingress-identity.ts`,
`src/deploy/system-component.ts`, `src/deploy/materialize-tls.ts`,
`src/deploy/ensure-hosting-caddy.ts`,
`src/deploy/materialize-storage.ts`, `src/deploy/apply-storage-volumes.ts`,
`src/deploy/run-deploy-hooks.ts`, `src/deploy/ensure-principal.ts`,
`src/deploy/site.ts`, `src/deploy/site-docker.ts`,
`src/deploy/ensure-docker-networks.ts`, `src/deploy/compose-ps.ts`,
`src/deploy/compose-files.ts` (compiled `compose.yaml` + `.env` + `deployment.json`
publish; legacy layered-chain read fallback),
`src/deploy/secret-runtime.ts` (host `/run` secret files),
`src/deploy/rehydrate-deployments.ts` (boot/reconnect/lifecycle rehydrate),
`src/deploy/compose-overlay.ts` (daemon overlay fragment merge into the
compiled YAML — storage / Traefik / site only).

## Shared HTTP ingress identity

The shared loopback Traefik (compose project `turbopanel-ingress`, service key
`traefik`) is **platform inventory**, distinct from per-service tenant TCP/UDP
Traefik and from managed-engine ProxySQL:

| Pattern | Ownership | Compose project |
| --- | --- | --- |
| Shared HTTP ingress | Platform (`system/hosting-ingress.json`) | `turbopanel-ingress` |
| Tenant TCP/UDP ingress | Tenant service (`ingress/services/<serviceId>/`) | `turbopanel-ingress-<serviceId>` |
| Managed-engine ingress | Platform system component (`managed-ingress` → ProxySQL under `configDir/proxysql/`) | `turbopanel-proxysql` |
| System stack (database/queue/analytics) | Ansible/Ops (`system-compose` role), inspected via `system/<component>.json` | `turbopanel-system` |

**Keep these four patterns distinct:**

1. **Shared HTTP Traefik** (`hosting-ingress`) — self-heals via
   `ensureHostingIngress` when demand exists; loopback only to hosting Caddy.
2. **Tenant raw TCP/UDP Traefik** — still **per tenant service** under
   `ingress/services/<serviceId>/` for docker-compose hostings with
   `protocol: tcp|udp`. **Do not** fold tenant raw ports into ProxySQL.
   Ports `15432` / `13306` are always reserved for the shared ProxySQL
   platform-default listeners (`PROXYSQL_RESERVED_PUBLISHED_PORTS`); when
   `environment.deploy` carries the server-owner org's effective
   `listenerPorts`, tenant claims on those overrides are rejected too.
   Tenant claims colliding on any reserved published port are rejected
   daemon-side.
3. **Managed-engine ProxySQL** (`managed-ingress`) — one per server,
   `proxysql/proxysql:3.0.9`, project `turbopanel-proxysql`. Desired state is
   whole-server `managed.ingress.reconcile` (not embedded on `managed.apply`).
   System self-heal dispatches to ProxySQL compose start/restart when the
   inventory component is present. Engine containers never publish host ports
   and never get a per-managed Traefik project.
4. **System stack (`turbopanel-system`)** — inspect-only, never self-healed.
   PostgreSQL/RabbitMQ/ClickHouse are provisioned by the `system-compose`
   Ansible role. `system.reconcile` only inspects (`selfHeal: none`).

Adoption for hosting-ingress and system-stack rows requires the documented
labels (`turbopanel.role`, `com.turbopanel.system.component`, …) — see below.
ProxySQL uses `role: ingress` + `com.turbopanel.system.component=managed-ingress`
when identity is stamped. Shared HTTP Traefik and ProxySQL now stamp the **same**
`turbopanel.role` value, so the distinguishing adoption key is
`com.turbopanel.system.component` (`hosting-ingress` vs `managed-ingress`) —
never the role label alone.

Descriptor path: `<stateDir>/system/hosting-ingress.json`
(`SystemComponentDescriptor`: `component`, `serviceId`, `composeServiceName`
must stay `traefik`, `containerName` = `<serviceId>-in`). When present,
`traefikCompose(identity)` emits `container_name`,
`x-turbopanel: { kind: system, component: hosting-ingress, … }`, and labels
`turbopanel.role=ingress`, `com.turbopanel.system.component=hosting-ingress`,
`com.turbopanel.service=<serviceId>` — **never** `traefik.enable`, HTTP router
labels, or `com.turbopanel.raw-port` (so tenant Traefik providers stay blind to
it). `ensureHostingIngress` reads the descriptor on every deploy. HTTP tenant
deploys write it from `hostingIngress` before that call when the payload
includes identity; a missing file remains the fallback for older payloads
(before `system.reconcile` writes identity). A corrupt file logs a warning
and falls back to the anonymous YAML so tenant deploys still succeed. `inspectHostingIngressContainer` best-effort
returns the observed container in `EnvironmentDeployContainer` shape
(`role: ingress`); compose-ps failure returns `undefined` (omit `containers`),
absence returns `null`. A missing compose file is authoritative absence
(`null`), not a collection failure. Observed rows must match the allocated
`container_name` **and** compose service **and** carry allowlisted platform
labels (`turbopanel.role=ingress`,
`com.turbopanel.system.component=hosting-ingress`,
`com.turbopanel.service=<serviceId>`) — anonymous pre-provision
`turbopanel-ingress-traefik-1` rows (no platform labels) are ignored.
Production writer: the `system.reconcile` handler always calls
`writeSystemComponentDescriptor`, then self-heals via `ensureDocker` +
`ensureHostingIngress` when `desired: 'present'` (plus compose `restart` when
`action: 'restart'`), intentionally stops the shared project when
`action: 'stop'` (hosting-disable PATCH — `compose stop`, then `ps -a`
inspect), or report-only inspect when `desired: 'absent'` with
`action: 'reconcile'` — ordinary disabled-state drift must not silently tear
down a running proxy. **`desired: 'present'` is demand-driven**: hosting
enabled alone leaves the inventory pending until an HTTP hostname hosting
exists on the server (or the ingress was already observed after first start)
— bare enroll / enable-hosting must not pull Traefik.

For ProxySQL / `managed-ingress`, the descriptor + compose identity live with
`SYSTEM_COMPONENT_CONTRACTS.managed-ingress` (`selfHeal: "proxysql"`);
`containerName` = `<serviceId>-in`. `readSystemComponentDescriptor` migrates
on-disk `role: turbopanel` rows that still use `<serviceId>-sql` or bare
`serviceId` to `role: ingress` / `<serviceId>-in` and rewrites the file.
`managed.ingress.reconcile` does the same recovery from an existing ProxySQL
compose file when the payload has no identity. Self-host stack components
(`database` / `queue` / `analytics`) stay bare-`serviceId`. `managed-ha`
keeps `-ha`.
Runtime files under `configDir/proxysql/` are written by
`managed.ingress.reconcile` and optionally re-started by `system.reconcile`.
Host dirs and the `turbopanel-proxysql-stack` unit are Ansible-owned
(`proxysql` role).

**System stack (`turbopanel-system`) is inspect-only:**
`inspectSystemStackContainer` (`src/deploy/system-stack.ts`) reports
`docker compose ps` identity/status (`selfHealAllowed: false` for
`database` / `queue` / `analytics`). Adoption requires labels
`turbopanel.role=turbopanel` + `com.turbopanel.system.component=<database|queue|analytics>`
— **never** `com.turbopanel.service` (tenant/system Traefik identity) and
**never** `traefik.enable`. A missing `turbopanel-system` compose file is
authoritative absence (`null`).

## Native Node/Next runtime (`src/deploy/native/`)

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
7. Probe `127.0.0.1:<listenPort>` until it answers.
8. On probe failure, repoint `current` back at the previous release and
   restart, then fail the command.

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

Transcript phases are unchanged — `fetch` / `build` / `release-promote` already
bracket this the way they bracket a site release.

## Sites (nginx, Apache, OpenLiteSpeed)

When `environment.deploy` carries `sites[]` (compose services with
`x-turbopanel.serviceKind: site`), those services are **not** in
Docker Compose. The daemon:

1. Runs `playbooks/site-nginx-apply.yml` (vendor `nginx` role +
   `web-service-user` for `tpnginx`) when any site uses `engine: nginx`. When
   an nginx site carries hosting `web.php` hints the same playbook also vendors
   **php-fpm** (`turbopanel_php_fpm_install=true`) — the Apache playbook never
   runs on an nginx-only host, so the install cannot live there. The vhost gets a
   `location ~ \.php$` with `fastcgi_pass unix:<socket>`, guarded by
   `try_files $uri =404` so a request for a missing `.php` is never handed to
   FPM, and `include <configDir>/nginx/fastcgi_params` (installed by the nginx
   role) with `SCRIPT_FILENAME` set after it.
2. Runs `playbooks/site-apache-apply.yml` (vendor `apache` role +
   `tpapache`) when any site uses `engine: apache`, likewise vendoring
   **php-fpm** on `turbopanel_php_fpm_install=true` (installed from sury, not
   vendored — see the end of this section). Apache vhosts
   `SetHandler "proxy:unix:…|fcgi://localhost/"` (mod_proxy_fcgi — **never**
   mod_php).

   Both engines share the pool layout: per-site FPM pools under
   `<configDir>/php/pools/tp-<environmentId>-<service>.conf` honoring
   validated `php.settings` via `php_admin_value[…]`. A pool is keyed
   by environment + compose service, so it belongs to exactly one site and
   therefore one engine — which is why `listen.owner`/`listen.group` simply
   follow `site.engine` (`tpapache` or `tpnginx`) with no shared-socket
   ownership to negotiate. Metadata still lands in `.turbopanel/php.json`.
3. Runs `playbooks/site-openlitespeed-apply.yml` (vendor
   `openlitespeed` + `tpols`) when any site uses `engine: openlitespeed`, plus
   vendored **lsphp** on `turbopanel_lsphp_install=true` when an OLS site wants
   PHP. OpenLiteSpeed does not use php-fpm: `openlitespeedVhostConfig` gives the
   vhost its own LSAPI `extprocessor` (`path` → `<runtimesDir>/lsphp/<series>/current/bin/lsphp`,
   `address uds://tmp/lshttpd/<name>.sock`, on-demand via `runOnStartUp 0` +
   `autoStart 2`) under **suEXEC** — `extUser`/`extGroup` resolved from the site
   principal exactly the way a pool's `user`/`group` are, falling back to
   `tpols`. Hosting hints render into the vhost's `phpIniOverride{}` as
   `php_admin_value <key> <value>`, and the site fragment flips
   `enableScript 1`.

   **Several PHP series can run side by side.** `resolveSitePhpSeries` picks per
   site (`web.php.version`, else `DEFAULT_PHP_SERIES`), and
   `phpSeriesForDeploy` collects the distinct set a deploy needs. A php-fpm
   master is one binary, so each series is a separate systemd instance —
   `turbopanel-php-fpm@<series>` — owning its own config, pool glob, pidfile,
   and socket directory:

   ```
   /etc/turbopanel/php/<series>/{php-fpm.conf,pools/,conf.d/}
   /var/log/turbopanel/php/<series>/
   /run/turbopanel/php/<series>/{php-fpm.pid,<poolId>.sock}
   ```

   A site on 8.3 therefore never touches the 8.4 master serving everything
   else: `SiteStagedConfigs.phpFpm` is keyed by series and only the masters that
   actually changed get rolled out. Moving a site between series changes its
   socket path, which is correct and free — the engine's unchanged-content check
   notices and reloads only that engine.

   **The install path is additive.** `installSiteEngines` passes
   `php_fpm_versions` (and `openlitespeed_lsphp_versions`) the way native apps
   pass `node_app_versions`, and the roles install what they are handed and
   never remove a series they were not asked about — the payload describes one
   environment, but the host serves many. Retiring a series belongs to the
   *removal* path: `removeSites` sweeps every installed series' pools and
   `disableIdlePhpSeries` disables a master whose pool directory holds nothing
   but the bootstrap `default.conf`. Packages stay installed; uninstalling is a
   fleet decision.

   `php-fpm` and `lsphp` remain different binaries from different sources, but a
   series string means the same thing to both, so one value still selects both.
   OLS has no per-series reload granularity — per-vhost series selection works,
   but the server restarts as a whole.
4. Materializes document roots under
   `<stateDir>/sites/<environmentId>/<composeServiceName>/<root>/` (default
   `public`; writes a placeholder `index.html` when empty) — **unless the
   service is release-backed**, see below. Merged hosting
   `webEnv` / `php` hints land in `<site>/.turbopanel/hosting.env` and
   `php.json`. When `sites[].principal` is set (from a project
   principal ↔ service steward), the site tree is `chown`ed to
   `principal:engineGroup` (`site_user:tpnginx` / `tpapache` / `tpols`) with
   `u=rwX,g=rX` + setgid dirs so the engine can read while the principal owns
   writes. Without a pin, ownership stays the engine user (previous default).
   nginx/Apache php-fpm pools run workers as the principal when pinned (`user` /
   `group = ${username}-grp` from `ensureSystemPrincipals`); the listen socket is
   owned by the serving engine (`tpnginx` / `tpapache`). An OpenLiteSpeed vhost
   carries the same identity twice: as LSAPI `extUser`/`extGroup` on the vhost's
   `extprocessor`, **and** as the vhost's own `user`/`group` (`setUIDMode 0`) in
   the aggregated `httpd_config.conf`, so suEXEC covers everything the vhost
   runs rather than the external processor alone. Multiple principals on one
   site service are rejected at deploy-prepare
   (`site_principal_ambiguous`).
5. Installs loopback-only vhosts under FHS config — nginx
   `<configDir>/nginx/sites/tp-<environmentId>-<service>.conf`, Apache
   `<configDir>/apache/sites/…`, OpenLiteSpeed fragments +
   regenerated `httpd_config.conf` — listening on `127.0.0.1:<listenPort>`
   (and optionally the docker bridge). **Every managed file is installed only
   when its bytes actually change** (staged to `<path>.tmp`, compared with
   `sudo -n cmp -s`, staged further only on a difference — the daemon does not
   run as root, so a plain read of a `root:<engineGroup>` `0640` file would
   report "changed" every time). Reloads `turbopanel-php-fpm` when a pool
   changed, then `turbopanel-nginx` / `turbopanel-apache` /
   `turbopanel-openlitespeed` — each only when **that engine's** own config
   changed or its group membership newly requires a restart (never distro
   `nginx`/`apache2`/`php*-fpm` units). An apply that changed nothing runs no
   config-test and no reload at all.

   That whole sequence — render, stage-if-changed, swap, config-test, reload,
   validate — lives behind one interface in
   **`site/engine-driver.ts`**, which is the single place a new
   engine plugs in. Per-engine differences are data on the driver, not branches
   at the call site: `stageSiteConfig` (privileged `sudo -n install` for
   nginx/Apache; a daemon-owned write for OpenLiteSpeed fragments, which have to
   be **read back** to regenerate `httpd_config.conf`), `configTest` (`nginx -t`
   as `tpnginx`, `httpd -t` as root, `openlitespeed -t` as `tpols`), and
   `reload`. php-fpm is expressed as a driver too (`PHP_FPM_DRIVER`) but is
   reloaded explicitly first, since the engines' config-tests reference sockets
   it owns.

   **Safe rollout.** A rendered config never lands on its live path
   unvalidated. `rolloutSiteConfigs` stages each candidate at
   `<path>.tpnew` (same directory, so the swap is an atomic same-filesystem
   rename; not matching the `*.conf` glob the engines include, so the engine
   cannot see it yet) and snapshots the bytes currently live to `<path>.tpprev`.
   The whole engine's candidate set is then swapped in at once, config-tested,
   reloaded, and probed over HTTP on each site's `127.0.0.1:<listenPort>`
   (any status below 500 counts — the point is that the engine came back
   answering). A failed config-test, a failed reload, or an engine that stops
   answering restores `<path>.tpprev` — or deletes `<path>` for a brand new
   site — and re-tests/reloads the restored config. A deploy therefore cannot
   strand config on disk the engine refuses, which would otherwise break the
   *next* reload or restart long after the deploy that caused it.

   All three engines test a **main** config plus its includes, never a lone
   fragment, so the earliest instant an engine-native test can see a candidate
   is right after the swap. The `<path>.tpprev` snapshot is what makes that
   swap safe; regression coverage for both failure paths lives in
   `site-apply.test.ts`.
6. Rewrites hosting Caddy so hostnames for those services
   `reverse_proxy 127.0.0.1:<listenPort>` instead of Traefik.
7. Skips Docker/Traefik entirely when the payload has **no** container services
   (`compose.yaml` is `services: {}`) — still ensures hosting Caddy via
   `ensureHostingCaddyRuntime`.

All three engines — plus `lsphp` for OpenLiteSpeed PHP — are vendored under
`/opt/turbopanel/vendor/<tool>/<version>/` with a `current` symlink (`lsphp`
adds a series level: `vendor/lsphp/<series>/<version>/`) — **never** distro apt
packages.

**php-fpm is the deliberate exception.** It is installed from Ondřej Surý's
Debian repo (`packages.sury.org/php`) rather than vendored, because tracking CVE
fixes across two dozen extension libraries by hand is not a burden worth taking
on for an interpreter. TurboPanel still owns its runtime: sury's own
`php8.4-fpm.service` is masked and `turbopanel-php-fpm.service` runs the
packaged binary against `/etc/turbopanel/php/php-fpm.conf` and the same
`pools/` directory as before, so nothing in this file's paths changed. See
`../../orchestration/AGENTS.md` (Tenant/daemon-host web servers).

**Release-backed sites (`sourceMaterial[]`).** When the deploy carries a Git
source for a site compose service, that site's document root resolves
to `<principalHome>/sites/<serviceId>/current/<root>` instead of the daemon-owned
state dir. `current` is a stable *name*, so the generated vhost content is
byte-identical across releases — only the (already atomic) promote changes what
it points at. That stability is **enforced, not just intended**: the
unchanged-content check above means an ordinary promote reinstalls nothing,
config-tests nothing, and reloads nothing, so a redeploy of a Git-backed site is
a `current` symlink swap and no more. (Change the listen port, the `webEnv`, or the PHP
hints and the affected engine reloads exactly as before — the skip is content
based, not "release-backed sites never reload".) Because the release tree is
root-owned `0550` by design:

- **Nothing is created or seeded.** A missing `current`, or a missing `<root>`
  inside the release, fails the deploy with a clear error rather than silently
  publishing a placeholder `index.html` over what the operator believes is their
  application.
- **`chownWebTree` is skipped entirely.** Re-chowning the tree to the principal
  would hand a compromised app process write access to the code it runs — the
  exact property the release layout exists to prevent. Read access instead comes
  from `usermod -aG <username>-grp <engineUser>`
  (`ensureEngineGroupMembership`), giving the engine service account group `r-x`
  and nothing more. Supplementary groups are resolved when a process **starts**,
  so the first time an engine joins a group that engine is `systemctl restart`ed
  rather than reloaded; later deploys see the membership already present and go
  back to an ordinary reload. php-fpm is never restarted for this — its workers
  run as the principal, which owns the group already.
- **Hosting metadata moves out of the release.** `hosting.env` / `php.json` land
  in `<siteRoot>/.turbopanel-hosting/` (root-owned, group-readable), installed
  through the same `sudo -n install` seam as every other managed config file.
- **PHP is confined.** A release-backed nginx/Apache PHP pool gets
  `php_admin_value[open_basedir] = <documentRoot>:<siteRoot>/shared:/tmp`, so
  scripts read the release and write through `shared/` — reachable as
  `current/shared` — and nothing else on the filesystem. Legacy daemon-owned
  sites keep their previous (unrestricted) behavior.
- **PHP is told the symlink moved.** PHP is the one runtime that would keep
  serving the old release after a promote even though the document-root *string*
  never changed, because two caches hide the swap: the realpath cache still
  resolves `…/current/<root>/…` to the previous release directory for
  `realpath_cache_ttl` (120s by default), and opcache with the default
  `opcache.revalidate_path = 0` reuses the cached resolution of the unresolved
  include path, so it never re-stats at all. Since an ordinary promote
  deliberately does **not** reload php-fpm, the mitigation is per-pool config:
  `RELEASE_SYMLINK_SWAP_PHP_DIRECTIVES` in `site.ts` emits
  `php_admin_value[realpath_cache_ttl] = 0`,
  `php_admin_value[opcache.revalidate_path] = 1`,
  `php_admin_value[opcache.validate_timestamps] = 1`, and
  `php_admin_value[opcache.revalidate_freq] = 0` on release-backed pools only.
  It costs a stat per include — the price of an atomic cutover with no reload —
  which is why the vendored baseline
  (`orchestration/roles/php-fpm/templates/php.ini.j2`) keeps opcache enabled with
  `revalidate_freq = 2` for legacy daemon-owned roots, where nothing moves under
  a running worker. Both sides carry a pointer to the other.

Sites with no `sourceMaterial[]` entry are untouched by all of the above.

**Mixed Docker + site:** when an environment deploy includes both
container services and `sites[]`, the daemon (1) binds each
site vhost on loopback (for hosting Caddy) and on the docker bridge
address (`docker0`, override `TURBOPANEL_DOCKER_HOST_GATEWAY`), (2) applies
site **before** `docker compose up`, and (3) patches compose with
`extra_hosts: host.docker.internal:host-gateway` plus
`TURBOPANEL_SITE_<SERVICE>_URL` and
`TURBOPANEL_SITE_ENDPOINTS` JSON env on every container service.

**External Docker networks:** compose `networks.*.external: true` names must be
registered in the org network table (`kind: docker`, `options.dockerNetworkName`)
for the deploy server. Payload `dockerExternalNetworks[]` is ensured with
`docker network create` before compose up (`ensure-docker-networks.ts`).
**`fabricNetworks[]` is a disjoint set:** platform-owned `tpn_*` routed bridges
derived from `segment` rows (`{ name, subnet, gateway?, mtu? }`), never
operator-registered. Requiring a registry row would make every spanning deploy
fail — `tpn_*` is allocated by the compiler. The daemon ensures them via
`ensureFabricDockerNetworks` (fabric.ts routed-bridge path) as a belt-and-braces
path if `server.fabric.reconcile` lands stale.

`environment.stop` removes nginx, Apache, php-fpm pools (both engines share the
`pools/` directory and the `tp-<environmentId>-` prefix, so whichever pass runs
first sweeps them all and the second finds none), and OpenLiteSpeed site
fragments/vhost dirs (best-effort reload/regenerate) in addition to compose
down + hosting Caddy site removal. It also reclaims `siteReleases[]` — the
per-service release trees — but that step is **generic**, not a site
concern: it is the same tree the Git release engine publishes into and native
apps run out of. See the Git-backed releases section.

**OpenLiteSpeed** regenerates a whole `httpd_config.conf` from every fragment
under `<configDir>/openlitespeed/sites/` on each apply/remove (no
`sites-enabled` convention). PHP context lives inside the per-site
`vhosts/<name>/vhconf.conf` and fragment that removal already deletes, so
`removeOpenLiteSpeedSites` needs no PHP-specific step. `web.env`
hints remain unapplied for OLS (Apache-only `SetEnv`) — PHP parity did not
change that.

Future seams (not MVP): multi-version PHP side-by-side, OLS/nginx `web.env`,
swarm-style replicas, ACME issuance on the daemon. TurboFabric **is** the
single org mesh (`server.fabric.reconcile` — see `src/instance/commands/fabric.ts`
and `../../orchestration/AGENTS.md`). `{ enabled: false }` is a teardown; the
daemon owns apply (no Ansible apply playbook).

## Managed-directory sites

A site's content comes from one of two lanes, named by `sourceKind` on the wire
and never inferred:

- **`release`** (the default, and every site's behavior before this existed) —
  a Git-backed immutable tree the release engine publishes into
  `sites/<serviceId>/current`. `applyOneSite` **asserts** it and never creates
  it: silently seeding a placeholder would publish "TurboPanel site is ready"
  over what the operator believes is their application.
- **`managed-directory`** — a principal-writable `sites/<serviceId>/webroot/`
  the tenant fills over SFTP. Created here, because there is no release engine
  on this lane and the directory has to exist before the vhost that serves it.

`webroot/` is a deliberate **sibling** of `releases/` and `current`, and both
lanes resolve `serviceId` through the same `resolveReleaseServiceId`. That is
what makes connecting a repository to an existing site a field flip rather than
a move.

**Names the concession.** A managed directory gives up the immutable-release
property: the tree the engine executes is writable by the account running it,
which is exactly what release confinement exists to prevent. Correct for a
WordPress site (the application writes to itself by design), wrong for a built
application — which is why it is an explicit field and not an inference from
whether `source` is set. `open_basedir` still confines it to its own tree;
`releaseSymlinkSwap` does not apply, because nothing moves under a worker here
and telling PHP otherwise would disable realpath caching for nothing.

**A release wins over the flag.** A site carrying both takes the release branch,
because a promoted tree is what the release engine actually published and
serving the directory instead would ignore a build the operator asked for.
`deployManagedDirectoryBindings` drops the entry so the two can never disagree;
the branch order in `applyOneSite` is the backstop.

**Never recursively chowned.** `ensureManagedDirectory` creates the tree with
the right owner once; a recursive `chmod u=rwX,g=rX` every deploy would fight
whatever modes the tenant set on their own files. The placeholder `index.html`
is written **only into an empty document root**, for the same reason the release
lane asserts rather than creates.

**A principal is required, not optional.** "A directory and an account" needs
both; without an owner there is no account to upload as, and the fallback would
be the daemon-owned tree — which serves fine and is unreachable over SFTP
forever. Refused at three layers: deploy-prepare
(`site_managed_directory_unowned`, with a sentence naming the service), the
wire parser, and the daemon's own contract parser.

## The PHP shell dispatcher

`/usr/local/bin/php` resolves which co-installed series a bare `php` means for
the calling account and execs the real binary.

**It grants nothing.** The enforcement is the kernel's at `execve`, against
`/usr/bin/php<series>` being `root:tpphp<SS> 0750` (the `dpkg-statoverride` the
php-fpm role applies). A tenant who ignores the wrapper and runs
`/usr/bin/php8.3` directly gets `EACCES` unless entitled, exactly as if it did
not exist. No sudo, no setuid — `src/orchestration/php-dispatcher.test.ts`
asserts both.

**It is not a diversion.** `/usr/local/bin` precedes `/usr/bin` in Debian's
default PATH, so the dispatcher shadows sury's `update-alternatives` link
without removing it — removing it would break every other package that expects
`php` to exist. That link was never a privilege leak either: it resolves to
`/usr/bin/php<series>`, whose mode the kernel checks. What it actually is, is a
*usability* problem — which series a bare `php` resolves to would otherwise be
decided by host-global alternatives priority, so two tenants entitled to
different series would both land on whichever apt installed last.

Resolution order: `$TURBOPANEL_PHP`, then a root-owned per-account pin under
`<configDir>/php/pins/<username>`, then the highest entitled series. Only ever
selected from what the account already holds — passing a request straight
through would reach `execve` and come back as a bare `EACCES` with nothing
explaining why. The group→series table is **rendered from the registry**, not
parsed out of the group name (`tpphp810` cannot be read back unambiguously as
8.10 rather than 81.0), and ordering uses `sort -V` for that same reason.

## SSH access (`ssh/`)

Tenant SSH is three files: a pure `authorized_keys` renderer, a pure `sshd`
drop-in renderer, and `apply.ts`, which owns every host write. Nothing here
touches a host outside `apply.ts`, so the bytes deciding who can log in are
assertable in CI.

**Key files are root-owned and live outside the home.**
`/etc/ssh/turbopanel/authorized_keys/<username>`, `root:root 0644`, with every
parent `root:root 0755` because `sshd` with `StrictModes` refuses a
group-writable path. The obvious location — `~/.ssh/authorized_keys` — is
principal-*writable*, so a tenant could add keys the panel cannot see and
panel-side revocation would stop meaning anything. The trade-off (a tenant
manages keys in the panel, not over SSH) is stated in the product copy.

**Two gates, one definition of canonical.** The control plane fully decodes a
pasted key, compares its embedded algorithm name against its label, and
re-renders it. The daemon then checks only that nothing *structural* — a second
line, an options field, a trailing comment — can reach the file.
`isCanonicalSshPublicKey` (`ssh/key-types.ts`) is that check; `contracts.ts`
mirrors the same regex because it is a zero-import leaf, and
`ssh/apply.test.ts` asserts the two cannot drift.

**The drop-in ends with `Match all`, and that line is load-bearing.** Debian puts
`Include /etc/ssh/sshd_config.d/*.conf` at the *top* of `sshd_config` and
processes it inline, so a `Match` block running to end-of-file swallows every
global directive below the include in the administrator's own file. The drop-in
also sets **no global directive before its first `Match`**, for the mirror-image
reason: `sshd` takes the first occurrence of most keywords, so a global here
would override the administrator's value for the whole host.

**Never repaired, only reported.** A missing `Include` line fails the reconcile
with the line to add — editing someone's `sshd_config` so our own file starts
taking effect is not a move a hosting panel makes silently. `AllowUsers` /
`AllowGroups` / `Deny*` outrank any `Match` and cannot be worked around from a
drop-in, so they become a transcript warning and the reconcile continues.

**Rollout**: stage → swap → `sshd -t` → reload, rolling back to the previous
bytes (or deleting a first-ever file) if the test fails. `reload`, never
`restart`, so established sessions survive a config that passes `-t` and then
rejects every key. The unchanged-content rule means a routine deploy touches
`sshd` not at all.

**`prune` is not a tuning knob.** `applySshAccess` removes key files only when
the caller holds the **complete** managed set for the host. `environment.deploy`
describes one environment and a host serves many, so it passes `prune: false`;
`server.principals.reconcile` carries the whole server and passes `true`.
Pruning from a deploy payload would revoke every other environment's access.
Containment for removal comes from the directory — `/etc/ssh/turbopanel/` is
ours by construction — so `root`'s keys and an administrator's own
`~/.ssh/authorized_keys` are unreachable from here whatever the payload says.

**Access is a group, not a shell test**, because `sshd` matches on groups:
`tpsftp` (files only, `ForceCommand internal-sftp`) and `tpshell`. Membership is
reconciled by `ensurePrincipalManagedGroups` in the same pass as runtime
entitlements — one containment set (`allManagedGroups`), or a principal
downgraded from shell to files-only would keep `tpshell` because the entitlement
pass did not recognize it.
