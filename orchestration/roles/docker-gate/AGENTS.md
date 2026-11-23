# Docker gate (`docker-gate`) — AGENTS.md

Root context: `../../../src/permissions/AGENTS.md` → **Managed-host privilege boundary**
("Docker" is the first of the three root-equivalent routes of the daemon
account `tp`). This role is **stage 3 of 5** of closing it.

## Label prefix (`io.turbopanel.`)

The gate reads labels under `io.turbopanel.` only. `platform.ts` `componentOf` reads the component label; for the signed approval, `approvalTokenOf` reads `io.turbopanel.approval`, and the body digest removes that label. A container that carries only labels of another prefix has no TurboPanel identity.

## What exists today (stages 1-4: enforcing, daemon routed, Traefik on a read-only socket)

A root-owned systemd service, `turbopanel-docker-gate.service`, runs the
vendored Deno (`<install>/vendor/deno/current/deno`) over the TypeScript in
`files/` (copied root-owned to `<install>/lib/docker-gate/`). It listens on
`/run/turbopanel-gate/docker.sock` (`root:tp 0660`, directory `root:tp 0750`),
forwards requests to the real `/var/run/docker.sock` and, in the default
`enforce` mode, answers 403 to what the strict profile refuses
(`docker-gate.denied`). **The daemon routes through it** (stage 4): the
`turbopaneld` unit sets `DOCKER_HOST` and `TURBOPANEL_DOCKER_SOCKET` (and
`TURBOPANEL_DOCKER_BUILD_SOCKET`) on managed hosts, orders itself after the
gate service, and waits for the socket (`scripts/wait-docker-gate.sh`) before
any Docker work; with no direct fallback a missing gate fails closed. `tp` is
not in the `docker` group (stage 5): the `docker` role skips it on managed hosts and
`daemon-converge` removes it from hosts provisioned earlier (`gpasswd -d`; the
running daemon loses the group at its next restart). Co-located dev hosts have no gate
and are exempt. Root-run Ansible roles and `postgres-backup.sh` keep the real
socket by design (they are root already).

Installed on managed hosts only (`turbopanel_dev_user` empty), wherever Docker
is: the `docker` role includes it at the end, and `daemon-converge.yml` runs it
for hosts that already have Docker. The gate runs on the vendored Deno, so every
play that runs the `docker` role (`instance-install`, `docker-setup`,
`orchestrator-setup`, `proxysql-setup`, `rabbitmq-setup`) runs `deno-runtime`
first, unconditionally; a native-binary daemon needs it too. A missing Deno is
reported as a `WARNING: Docker gate NOT installed` line in the play output (the
installer recap shows only failure messages, so it is not in the recap), not a
silent skip. The whole install is a block with a `rescue` that only prints a
warning: **in stage 1 nothing depends on the gate, so a failure to install it
must never block a Docker install or a converge.**
A later stage that routes traffic through it flips this to fatal.

## Files (`files/`, dependency-free, no import map, no network)

| File | Job |
| ---- | --- |
| `http.ts` | Strict HTTP/1.1 framing: head parse, `Content-Length` / chunked bodies, refusal of every ambiguity (both lengths, repeated lengths, folding, bare LF, `Transfer-Encoding` other than `chunked`) |
| `body.ts` | Strict JSON parse of create bodies, read the way the engine's Go decoder reads them (see "Paths and bodies as the engine reads them") |
| `proxy.ts` | One client connection: request in, fresh engine connection, response back. Upgrades (`attach`, `exec start`, Compose `/session` + `/grpc`) are spliced raw **only after the engine answers 101** |
| `readonly.ts` | Stage 3: the exact list the read-only listener answers (GET/HEAD `/_ping`, `/version`, `/events`, `/containers/json`, `/containers/{id}/json`); everything else is a 403 |
| `platform.ts` | Ownership classes (`platform` / `tenant` / `unlabeled`) from labels, and the narrow bind allowance of platform containers |
| `approval.ts` | Verifier for the control plane's signed per-deploy approval (Ed25519 via WebCrypto); no signer, no private key |
| `inspect.ts` | Root-side `GET /containers/{id}/json` for the ownership check (labels only, never logged) |
| `review.ts` | Per request: policy findings, allowance hits, approval check, ownership check; logs + counters |
| `build.ts` | Stage 4: BuildKit's `/session` and `/grpc` only on the build listener (`root:tpgatebuild 0660`) |
| `policy.ts` | Route classification and the strict-profile rules (see below); returns findings, secret-free |
| `resolve.ts` | Resolves a bind source by hand, component by component, following symlinks (including dangling ones, which Docker creates the target of) |
| `stats.ts` | Counters for the periodic summary line |
| `main.ts` | Config from `TP_DOCKER_GATE_*`, socket setup, summary timer, SIGTERM handling |

Tests: `src/docker-gate/*.test.ts` (framing, policy over a corpus of real CLI
and Compose request bodies in `src/docker-gate/testdata/corpus.json`,
end-to-end over real Unix sockets) and
`src/orchestration/docker-gate-role.test.ts` (the rendered unit, and the real
gate run under exactly the unit's Deno flags). The source is formatted by
`deno fmt` (the `orchestration/**` exclusion has a negation for `files/`) and
is the only TypeScript allowed in the orchestration release tree
(`tp_verify_release_root`).

## Strict profile (what is logged as `docker-gate.would-deny`)

Deny: `Privileged`; host / `container:` `NetworkMode` `PidMode` `IpcMode`
`UTSMode` `UsernsMode` `CgroupnsMode`; `Devices` `DeviceCgroupRules`
`DeviceRequests`; `CapAdd` outside the allowlist (default none);
`SecurityOpt` other than `no-new-privileges`; `CgroupParent`; `Sysctls`;
`VolumesFrom`; any `MaskedPaths` / `ReadonlyPaths`; a non-`runc` `Runtime`;
privileged `exec`; `exec`/`attach`/`archive`/`export` on a platform container (rules
`platform-exec`, `platform-attach`, `platform-archive`, `platform-export`) except the daemon's own
pairs in `PLATFORM_EXEC_ALLOWLIST` (managed engines; ProxySQL `mysql` only); binds (`Binds`, `Mounts` of type bind, and `local`-driver
volumes that are really `o=bind,device=<path>` or a `device=/dev/...`) whose
resolved source is `/`, the Docker socket, a denied tree (`/etc`, `/run`,
`/proc`, `/sys`, `/dev`, `/root`, `/boot`, `/opt/turbopanel`, `/backup`), or
outside the bind roots (`/srv/users`, `<state>/storage`); non-bridge network
drivers and non-`local` volume drivers; `build` with host network or a cgroup
parent; any `PUT /containers/{id}/archive`; mutating calls on `/plugins`,
`/swarm`, `/nodes`, `/services`, `/tasks`, `/secrets`, `/configs`; paths the
engine would clean (`..`, `//`); an API version prefix other than one
`/v<major>.<minor>` (`path-version-prefix`); a create body the strict parser
refuses (`body-unparseable` with `empty`, `invalid-utf8`, `invalid-json`,
`too-deep`, `duplicate-key` or `non-ascii-key`).

The legacy `/build` refuses a cgroup parent (rule `build-cgroup-parent`), but
`docker buildx build` sends `cgroupparent` over `/grpc`, which the gate cannot
see. The daemon passes each image build's slice that way, so the gate does not
check it.

## Bind sources: allowed places, and the start-time re-check

**Allowed places under the site owners' homes.** A bind source that resolves
(symlinks followed root-side, dangling ones included, `..` refused) under
`/srv/users` must be one of the places the principal home layout gives
containers (`policy.ts` `principalViolation`, config `principalRoots`):
`<user>/tmp`, `<user>/<scope>/volumes/<name>` (path storage),
`<user>/<scope>/services/<name>/shared`, `.../webroot` and the root-owned
`.../releases`. Everything else under a home (`home/`, the home or a scope
as a whole, a site's `.turbopanel-hosting`, `.tp-staging`) is a
`bind-principal-path` finding. Outside `/srv/users` the older rules stand
(root-owned bind roots such as `<state>/storage`, the deny list). The gate does
not know which owner a container belongs to, so `alice/data` for bob's
container is not caught here. An operator-chosen storage path under a home
(`sourcePath`, "explicit operator paths still win") outside those places is
refused too, backup and restore helpers included. `principalRoots` is the
built-in `/srv/users` (it does not follow `TP_DOCKER_GATE_BIND_ROOTS`).

**Allowed places under the storage root.** Below `/var/lib/turbopanel/storage`
(`storageRoots`, built in like `principalRoots`) only
`<org>/<storage>/<location>/data` and what is under it may be bound
(`policy.ts` `storageViolation`, rule `bind-storage-path`): the root, an
organization's folder, a storage's folder and a location's folder are refused.
The gate does not know a container's organization, so another organization's
well-formed location still passes here; the daemon confines a deploy to its own
locations (`stateTree` in `compose-host-paths.ts`).

**State directory rule no approval waives.** A source at `/var/lib/turbopanel`
(`stateDirs`), below it outside the storage root (`deployments/`, secret
records, the spool), or above it (`/var/lib`, `/var`) is `bind-state-dir`
(`policy.ts` `stateDirViolation`, `volume-bind-state-dir` for a volume device).
It is not in `APPROVABLE_RULES`, unlike `bind-outside-roots`, so a signed
`host-paths` approval does not relax it. A source the gate cannot resolve (a
link loop, an untraversable directory) is `bind-unresolvable`, also never
approvable, instead of being judged on its spelling.

**Generated secret and config files.** A tenant container (`ownerOf` is
`tenant`) may bind, read-only, exactly the files the daemon writes for Compose
`secrets:` and `configs:`: `<runDir>/deployments/<projectId>/<environmentId>/(secrets|configs)/<name>`
(`policy.ts` `isGeneratedFileBind`, allowance `generated-file-bind`). Both ids
are UUIDs, `<name>` is one segment of the deploy's plan-name rule
(`[A-Za-z0-9][A-Za-z0-9._-]*`, no `..`, not `.tmp`), and the authored source
must already be the resolved one, so a symlink never qualifies. The two ids must also equal the container's own `io.turbopanel.project` and `io.turbopanel.environment` labels exactly; a container missing either label is refused. The daemon stamps both on every service of a deploy (`buildHostingLabelsFragment`), overriding tenant-written values. Anything else
under `/run` stays `bind-forbidden-path`. `runDir` is the policy config's
`/run/turbopanel` (the layout's `PROD_RUN_DIR_DEFAULT`, repeated because the
gate imports nothing).

**Start / restart re-check.** The engine resolves a bind source again at
`start`, so a clean create can be stale (source swapped for a symlink, a
container made before the gate enforced). `POST /containers/{id}/start|restart`
does one `GET /containers/{id}/json` (the same one the ownership check
needed), then applies the same bind policy to the live `HostConfig.Binds`,
`HostConfig.Mounts` and the live bind `Mounts`. Findings are the create rules
prefixed `start-` (`start-bind-principal-path`...). A container's own signed
approval label still covers its approved features (signature and project only:
expiry, body digest and single use were enforced at create; the digest no
longer pins the exact paths, so an approved feature covers whatever binds the
container has at restart). An inspect that
fails is `owner-unknown`, as before.

Both checks follow the gate's mode: observe logs `docker-gate.would-deny`,
enforce answers 403 before the engine is reached. **Residual race:** a
tenant-writable allowed source (`data/`, `tmp/`, `shared/`) can still be
swapped for a symlink in the window between the gate's inspect and the engine's
own resolution at start; the check narrows that window, it does not close it.
Closing it fully needs the engine to mount by file descriptor or the sources to
be root-owned. The generated-file allowance has the same race:
`/run/turbopanel/deployments` is tp-writable, so before enforcement the
generated files must become root-owned (written through tp-host) or be mounted
by file descriptor. Until then the gate only checks, at inspect time, that the
source is a regular file (lstat) and not a symlink, and it fails closed when
symlink resolution errors.

## Paths and bodies as the engine reads them

Rules only hold if the gate reads a request exactly as the engine does.

- **Version prefix.** The engine's router strips `/v{version:[0-9.]+}`, so
  `/v1/`, `/v1.47.0/` and `/v1.47./` all route. `routePath` strips that same
  prefix, so classification (and the body rules) always run on the engine's
  route. `versionPrefixIsCanonical` accepts only no prefix or exactly one
  `/v<major>.<minor>`: anything else is a `path-version-prefix` finding on the
  main socket and a 403 on the read-only socket.
- **Body field names.** Go's `encoding/json` matches struct fields
  case-insensitively (and through Unicode folding: `ſ` is `s`, the Kelvin sign
  is `k`), and decodes a repeated field into the same struct, so the first
  copy's fields survive. `body.ts` therefore refuses a body whose struct field
  names are not printable ASCII or repeat case-insensitively, and rewrites every
  field the policy reads to its canonical spelling (`CANONICAL_FIELDS`). Keys of
  Go maps (`Labels`, `DriverOpts`, `Options`, ... in `MAP_FIELDS`) are matched
  exactly by the engine and kept exactly. A BOM, invalid UTF-8, trailing data
  or nesting deeper than 64 fails closed. **A new field the policy reads must
  be added to `CANONICAL_FIELDS`** (`body.test.ts` scans the policy source for
  it).

**Expected findings on every host in this stage** (not bugs): the platform's
own containers bind `/etc/turbopanel/...` and `/var/lib/turbopanel/...`
(ProxySQL, orchestrator, managed-engine config and data) and the ingress
Tecnativa proxy container mounts `/var/run/docker.sock` until the stage-3
switch is on for the host (see below). Since stage 2 the platform's own compose containers are allowed (see
below), so what remains on a host is the socket proxy (the daemon's helper
containers are labelled, see below).

## Stage 2 additions (still observe: nothing is refused)

**Platform allowance** (`platform.ts`). A create is `platform` when it carries
`turbopanel.role` in {`turbopanel`, `ingress`} plus a known
`io.turbopanel.system.component` (`hosting-ingress`, `managed-ingress`,
`managed-ha`), or `tp.managed.engine`. Such a container may bind, after symlink
resolution: config trees read-only (`<config>/proxysql`, `<config>/orchestrator`,
`TP_DOCKER_GATE_PLATFORM_RO_ROOTS`) and state trees in any mode
(`<state>/{proxysql,orchestrator,managed}`, `..._RW_ROOTS`). A writable mount of
a config tree is its own finding (`platform-config-writable`). Everything else
still fires: `/`, `/etc` or `/etc/turbopanel` wholesale, the install dir, the
Docker socket. Hits are counted (`allowances`) and logged `docker-gate.allowed`.
A test renders the real ProxySQL / orchestrator emitters and asserts every bind
passes, so a changed emitter fails CI instead of the canary.
**This is a false-positive remover, not a boundary:** the daemon account stamps
these labels itself and the config trees are daemon-writable today. It must
tighten (and the labels stop being trusted) when route 2b makes the config trees
root-owned; the label check can then be replaced by an exact-path list.
Known gaps, left as findings on purpose: the ingress `docker-socket-proxy`
(its own compose project, `turbopanel-docker-proxy`) mounts the Docker socket
until the stage-3 switch is on.

**Helper containers.** Every daemon-started throwaway `docker run` (backup tar,
restore swap, managed-file ownership, engine volume bootstrap) stamps
`turbopanel.role=turbopanel` + `io.turbopanel.system.component=<backup-copy |
backup-restore | managed-files | volume-copy>` through `helperLabelArgs` in
`src/deploy/labels.ts`; `platform.ts` lists those components, and `/backup`
(the restore archive, read-only only) is a platform read-only root. A test in
`platform.test.ts` scans `src` for any `docker run` without the helper. The
same binds with no label, a forged component, or a writable archive stay
findings (corpus `attack` entries).

**Ownership observation.** Every create counts by owner class (`owners`) and an
unlabeled one is `unlabeled-create`. For start / stop / restart / kill / pause /
rename / update / exec-create / attach / archive / remove, the gate inspects the
target as root and logs `unowned-container` when it carries neither a Compose
project, a TurboPanel label nor `tp.managed.engine`. An inspect that fails (gone,
engine error, a non-200 or over-1-MiB answer, no answer within 5 s) fails closed:
an `owner-unknown` finding.

**Signed approvals** (`approval.ts`). Host-level Compose features cannot rest on
the daemon's own `hostLevelApproved` flag (the daemon account sets it). The
control plane signs, the gate verifies with a public key. Token = container
label `io.turbopanel.approval` = `v2.<b64url payload>.<b64url sig>`; the
signature covers `turbopanel-docker-gate-approval-v2\n` + the payload text.
Payload: `deployId`, `project`, `composeDigest` (audit only: the gate never sees
the compose file), `bodyDigest`, `containerName` (the create's `?name=` query, which the body does not hold: another name is `rejected: wrong-name`), `features[]`, `iat`, `exp` (seconds). `bodyDigest`
binds the token to ONE create body: base64url SHA-256 of the RFC 8785 canonical JSON of the body AS THE CLIENT SENT IT
(a plain `JSON.parse` of the payload: field names as written, never the strict parser's canonical spelling, so no gate
version shifts it), with the `io.turbopanel.approval` label removed. A different body is `rejected: wrong-body`; a v1
token (no binding) is `unsupported-version`. `jti` makes a token single-use: an accepted id is remembered until its
`exp` and a second use is `rejected: replayed` (memory is per gate process; at most 10 000 ids, beyond which new tokens
are refused). The signer therefore has to sign the final create body Compose sends; the signer is not built, so that is
its design constraint. The gate checks the
signature (any trusted key: one raw base64url Ed25519 key per line, so rotation
can overlap), `exp` not past, `iat` at most 60 s ahead, a lifetime of at most
900 s, and `project` equal to the container's `com.docker.compose.project`.
Only the rules in `APPROVABLE_RULES` are ever relaxed, each under one feature
(`privileged`, `docker-socket`, `host-paths`, `host-network`, `cap-add`,
`devices`); the host-root bind, denied trees, userns, masked paths and
volumes-from are never approvable. An approved finding is dropped from
`would-deny` and counted (`approvedRules`); every outcome is one
`docker-gate.approval` line (`accepted` / `rejected` + reason + deployId +
project; the token is never logged). **Off by default:** with no key
(`docker_gate_approval_pubkeys` empty, no `TP_DOCKER_GATE_APPROVAL_PUBKEY`)
every token is `rejected: approvals-off` and findings stand. The key lives
root-owned in `<install>/lib/docker-gate/approval.pub`, never under
`/etc/turbopanel` or `/run/turbopanel` (the daemon could swap it there). An
unreadable key file turns approvals off with an error line; the gate keeps
serving. A token covers one create of one body in one project, once. `docker-socket` is approvable
because the owner asked for it; plan finding B wanted socket mounts forbidden
outright, so delete that one line in `APPROVABLE_RULES` to forbid it. The signer
(control plane) is not built yet; tests sign with a key generated at run time.

**Corpus.** `src/docker-gate/testdata/corpus.json` now also holds creates
recorded from a real Engine 29 / Compose 5.5 for the ProxySQL, orchestrator and
managed-engine compose shapes (images swapped, `Env`/`Cmd` scrubbed, paths
rewritten) and the managed-file helper.

**Counters** in the summary line: `allowances`, `approvals`, `approvedRules`,
`owners` (plus the stage-1 `requests`, `upgrades`, `wouldDeny`, `refusals`).

## Stage 3 additions (Traefik on a read-only socket; the main socket still observes)

**Read-only listener** (`readonly.ts`, `TP_DOCKER_GATE_RO_SOCKET`). A second
socket, `/run/turbopanel-gate/ro/docker.sock`, in a directory of its own
(`root:root 0750`, socket `root:root 0660`: root and a container's root reach
it, the daemon account does not). It answers only GET/HEAD `/_ping`,
`/version`, `/events`, `/containers/json` and `/containers/{id}/json` (optional
`/v<major>.<minor>` prefix, no other; id `[A-Za-z\d][A-Za-z\d_.-]*`), with no body and no
upgrade, and refuses anything else, and any path holding `%`, `..`, `//` or
`\`, with a **403** and a `docker-gate.ro-refused` line. It is narrower than
the Tecnativa proxy it replaces (`CONTAINERS=1` there also passed `logs`,
`export`, `archive` reads). These refusals are what this socket is, **not**
strict-profile enforcement: the main socket and `TP_DOCKER_GATE_MODE` stay
observe-only. The listener opens on every gate host (nothing connects to it
until the switch is on). If it cannot open, the gate logs
`docker-gate.ro-socket-unavailable` (level error). With the switch off it keeps
serving the main socket. With the switch on (`TP_DOCKER_GATE_INGRESS_SWITCH`
names the file; the gate checks it at start) the start FAILS and
`Restart=always` retries, because Traefik is rendered against this socket and
would lose every route at its next restart. Flipping the switch restarts the
gate, and a converge with the switch on fails unless the read-only socket
answers `/_ping` (`state: started` alone passes a crash-looping unit); the
block's rescue only warns while the switch is off (and not being turned on).

**Atomic deploy** (`tasks/deploy.yml`, `rollback.yml`; independent of the switch): the new source is staged in
`.next` and load-checked (`TP_DOCKER_GATE_LOAD_CHECK=1` makes `main.ts` exit 0 after importing everything and parsing
its configuration) before anything is replaced; a failure there touches nothing. Then the running gate is probed and
every file a swap can change (sources, unit, approval key, switch) is snapshotted into `.prev`. After the swap the
main socket must answer `/_ping` (and the read-only one while the switch is on). Any failure restores the snapshot
(removing what did not exist), restarts, re-probes, and fails the converge with the original error; with no previous
gate the unit is stopped and disabled. A rollback that itself fails does not hide the swap's error (both are in the
failure message), and the restored gate is only waited for when it answered before the swap. `.next`/`.prev` are
`root:root 0700`. The flow was run in a Linux container against a stub install step: failed swap restores the old files,
a good swap replaces them and drops `.next`, a broken staged `main.ts` is refused by the load check with nothing replaced. A switch value other than
yes/no fails the converge before anything changes (a typo never turns it off).

**The switch** (on by default since 2026-10-21): `docker_gate_ingress_socket: true`
(the default, so every converge) writes the root-owned
`<install>/lib/docker-gate/ingress-socket.on`; `false` removes it and keeps the
socket-proxy container; empty leaves it alone. An existing host gets the switch
file at its next converge and its Traefik moves onto the gate at the next
ingress apply (the next deploy or ingress reconcile). The daemon
(`src/deploy/ingress.ts` `ingressDockerGateEnabled`) uses the gate only when the
switch file AND `/run/turbopanel-gate/ro` exist. Then both Traefiks mount the
DIRECTORY read-only at `/var/run/turbopanel-gate` (a directory, so a gate
restart that recreates the socket does not strand Traefik on a dead inode) and
use `--providers.docker.endpoint=unix:///var/run/turbopanel-gate/docker.sock`.
The `turbopanel-docker-proxy` compose project (the Tecnativa container, no
longer part of the shared Traefik's project) is removed, after the shared
Traefik has switched, once no service Traefik compose file on disk still
names it; until then it stays up. The anonymous shared Traefik (no
`hosting-ingress` descriptor yet, so no `turbopanel.role=ingress` label for the
allowance) keeps the proxy until it has one. Without the switch both compose
documents are byte for byte what they were.

**Policy.** A container labelled `turbopanel.role=ingress` (both Traefiks) may
bind exactly `/run/turbopanel-gate/ro`, read-only (`ingress-socket`
allowance). Its parent (the main socket), a writable mount, a path below it, a
non-ingress container, and the engine socket stay findings (corpus `ro-socket-*`
attacks, `platform.test.ts`). Like the platform allowance this rests on a label
the daemon stamps: a false-positive remover, not a boundary.

## Wire behaviour that is not a pass-through

The gate refuses, even in observe mode: `Expect:` requests (417), create
bodies over 4 MiB (413), framing ambiguities (400), non-HTTP/1.x (505), and
heads over 64 KiB (431). Each request goes to a **fresh** engine connection.
No docker, Compose or daemon client sends any of these today.

## Logs (journald, `SyslogIdentifier=turbopanel-docker-gate`, one JSON per line)

`docker-gate.would-deny` (rule, secret-free detail, method, route, path),
`docker-gate.summary` (every `TP_DOCKER_GATE_SUMMARY_SEC`, and on stop:
route / method / status counts, `upgrades`, `wouldDeny`, `refusals`),
`docker-gate.allowed`, `docker-gate.approval`,
`docker-gate.approval-keys-unusable`, `docker-gate.started`,
`docker-gate.bad-request`,
`docker-gate.upstream-unreachable`, `docker-gate.peer-closed`. **Never
logged:** environment, commands, entrypoints, labels (other than the claims of
a signature-verified approval: deployId, project, composeDigest, features),
registry auth, query strings, request bodies, the approval token itself. An
`unowned-container` line carries the container name or id from the request path.

## Hard rules for this role

- The socket directory is **not** under `/run/turbopanel` (daemon-owned,
  `tp` could swap a directory there). It is `root:tp 0750`, created by
  tmpfiles.d and `ExecStartPre=+`.
- `TP_DOCKER_GATE_MODE` accepts `observe` and `enforce` (anything else fails
  the start); the unit sets it from `docker_gate_mode` (default `enforce`; a
  failed install or swap fails the converge, and `enforce` with Traefik's gate
  socket switched off is refused, because that combination would mount the
  raw socket proxy).
- The read-only listener's directory holds nothing but its socket, and never
  becomes a parent of (or the same as) the main socket's directory: a Traefik
  mounts it.
- The gate source is root-owned in `<install>/lib/docker-gate/`; `tp` can read
  it, never change it.
- `src/permissions/daemon-permissions.ts` grants the daemon read + write on
  `/run/turbopanel-gate` (`DOCKER_GATE_SOCKET_DIR`), which Deno needs to
  `connect()` to the socket once `TURBOPANEL_DOCKER_SOCKET` points at it. The
  directory is root-owned, so the grant cannot create or replace anything.

## Stages (plan: closing the Docker route)

1. Gate service, observe mode, nothing routed through it.
2. Platform allowance, ownership observation, signed approval verifier,
   `/grpc` + `/session` proven end to end, still observe.
3. **This role (added)**: Traefik on a read-only filtered socket behind a
   per-host switch (on by default); with it on, the tp-created Tecnativa
   container is removed.
4. **Done.** `tp` switches to the gate (`DOCKER_HOST`, `TURBOPANEL_DOCKER_SOCKET`),
   **enforce mode**; compose and buildx use a `turbopanel-build` context on the
   build socket (`--context`, buildx `--builder turbopanel-build`); the sudo rungs
   carry `env DOCKER_HOST=...`; `tp` was still in `docker` until stage 5.
5. **Done.** `tp` leaves the `docker` group (role and converge, managed hosts only); the
   real socket is root-only for it, and the daemon's Deno grants no longer name it.

Break-glass: never stop the gate. Since stage 4 the daemon reaches Docker only
through the gate socket, so stopping the gate cuts it off from Docker entirely.
The rollback is `docker_gate_mode: observe` plus a converge: the gate then
relays everything and refuses nothing. `usermod -aG docker tp` does not work as
a rollback: the unit's `ExecStartPre` `gpasswd -d` removes the group again on
every start, the converge removes it too, and the daemon's Deno grants no longer
include `/run/docker.sock`. Only a downgrade to a package from before stage 4
needs the group (`usermod -aG docker tp` and a restart); that package's unit has
no `gpasswd` line.

## What stage 4 needs from stage 3

- Turn the switch on by default (or for every managed host) and prove it on
  canary with `scripts/docker-gate-proof.sh` section 5, before enforcement:
  an enforcing gate refuses the Tecnativa container's socket bind.
- One proof script per claim, all run as root on a canary host with the switch on
  (each leaves only `tpgate-proof-*` throwaways, removed on exit):
  `scripts/docker-gate-proof-udp.sh` (a raw UDP route through a service Traefik on
  the read-only socket, and again after a gate restart),
  `scripts/docker-gate-proof-tls.sh` (an HTTPS route on the shared Traefik's
  `websecure` entrypoint over HTTP/2, and again after a gate restart) and
  `scripts/docker-gate-proof-reconcile.sh [seconds]` (before/after a
  `system.reconcile` restart of the shared ingress, which an operator triggers in
  the panel while the script waits).
- The Tecnativa container stays on a host until every TCP/UDP service with a
  service Traefik has been redeployed once with the switch on: stage 4 cannot
  claim "no socket mounts" before that (re-render them during the switch, or
  check `serviceIngressUsesSocketProxy` is false).
- Turning the switch off again re-renders the shared Traefik on its next
  deploy; service Traefiks already on the gate keep working (the listener is
  always on) until their own redeploy, which first puts the proxy back into
  the shared project. Flipping the switch never re-renders Traefik by itself:
  it takes effect at the next deploy or `system.reconcile`.
- Code rollback (an older daemon package on a host where the switch was on):
  the older gate opens no read-only socket, so every gate-mode Traefik loses
  discovery at its next restart. Turn the switch off and redeploy the ingress
  first.
- `/containers/{id}/json` still hands Traefik every container's `Config.Env`,
  as Tecnativa did: redacting it needs response rewriting (a separate change).
- The `ingress-socket` allowance trusts `turbopanel.role=ingress`, a label the
  daemon (and possibly tenant Compose) can set; enforcement needs tenant
  Compose to be refused `turbopanel.*` / `io.turbopanel.*` labels.

## Lockouts to watch now that enforcement is on (stage 4)

- Approval key missing or rotated without overlap: every host-level deploy is
  denied. Ship the new key alongside the old one, then retire the old one.
- Clock skew between control plane and host beyond 60 s (or a token older than
  its `exp`): approvals read as `expired` / `not-yet-valid`.
- An inspect round trip that fails denies the action in enforce mode
  (`owner-unknown`, fail closed on every route): a container removed in a race,
  or an engine slower than 5 s, refuses the action.
- Renaming a system component label (or an emitter changing a bind path)
  makes platform containers lose the allowance; the emitter test guards the
  paths, the label constants are pinned to `src/deploy/labels.ts`.
- The helper containers (managed-file normalisation, backup copy and restore)
  carry a platform label (`helperLabelArgs` in `src/deploy/labels.ts`); one
  that loses it is denied, and its backup or restore fails. The scheduled
  backup wrapper (`tp-backup-run`) is re-rendered by `daemon-converge`, so
  existing hosts route it through the gate too.
- Environments deployed before the project labels existed (pre-#825 compose
  files, or containers carrying tenant-written labels) must be redeployed once;
  until then a stop or remove of such a container can read as unowned.

## Ownership scope

`unowned-container` / `unowned-volume` / `unowned-network` only say that a target carries none of a Compose project,
a TurboPanel label or `tp.managed.engine`; a target whose labels cannot be read (gone, engine error, odd name) is
`owner-unknown` (fail closed). A tenant deploy may not set the platform's owner labels at all (`turbopanel.role`,
`io.turbopanel.system.*`, `tp.*`, the approval label): `src/deploy/compose-reserved-labels.ts` refuses the deploy
before `compose up`. They are observations, not a boundary: any caller can add a compose-project
label, and the gate cannot tell which tenant or project the daemon is acting for (the daemon account is the only client).
Checked routes: container start/stop/restart/kill/pause/unpause/rename/update/exec/attach/archive/wait/resize/export and
remove, volume and network remove, and network connect/disconnect (one engine inspect each). Polled reads (stats, logs,
top, changes) are not checked on purpose: they would double the engine traffic. Real scoping needs the control plane to
sign a per-project scope on non-create requests too; that is not built.

## Container-create breadth (deny by default)

Besides the earlier rules (privileged, devices, namespaces, security options, binds, mounts), a create now also flags:
`Cgroup` (join another container's cgroup), `Links`, `GroupAdd`, `Annotations`, positive `CpuRealtime*`, negative
`OomScoreAdj`, `Capabilities` (same allowlist as `CapAdd`), a `LogConfig.Type` outside json-file/local/none (syslog,
fluentd, gelf dial an address the author picks), mount types other than bind/volume/tmpfs, and bind propagation other
than private/rprivate (`Binds` options and `BindOptions.Propagation`). Every other `HostConfig` key must be in
`BENIGN_HOSTCONFIG_FIELDS` or `RULED_HOSTCONFIG_FIELDS` in `policy.ts`, else `hostconfig-unknown-field`: a field a newer
engine adds is denied until reviewed. When a real flow trips it, add the field to the benign list with a corpus entry.

## Volume drivers and mount options

`HostConfig.VolumeDriver` and each volume mount's `VolumeOptions.DriverConfig.Name` must be empty or `local`
(`volume-driver`), like `POST /volumes/create`'s `Driver`. A `local` volume's `type`/`o`/`device` options are deny by
default: `o=bind` or `o=rbind` (or `type=none`) with an absolute device is judged as a bind path; a `/` device otherwise
is `volume-device`; tmpfs passes; every other type (nfs, cifs, overlay, ...) or option set without a device is
`volume-mount-type`. Previously `rbind` skipped the path check and overlay/nfs passed. A volume mount's `VolumeOptions.Subpath` must be relative
with no `..` (`volume-subpath`); a tmpfs mount's `TmpfsOptions.Options` may only hold noexec/exec/nosuid/nodev/ro/rw
(`tmpfs-options`). A host that deliberately uses
NFS volumes will see findings until the profile grows an allowance.

## Framing and form parity (Go differential)

The engine parses with Go's `net/http`. `src/testing/docker-gate-diff/main.go` (standard library only) runs
`http.ReadRequest` + `ParseForm` over `src/docker-gate/testdata/parser-cases.json`; its recorded output is
`testdata/go-parser.json` and `src/docker-gate/parser-differential.test.ts` checks the gate against it: the gate may
refuse what Go accepts, but must never pass a request Go reads differently (method, path, body length and framing,
leftover bytes, form fields). `DOCKER_GATE_GO_DIFF=1 deno test` re-runs the harness (local `go`, else
`docker run golang:1.23`) and checks the record is current. Regenerate with
`docker run --rm -v "$PWD":/w -w /w/src/testing/docker-gate-diff golang:1.23 go run . ../../docker-gate/testdata/parser-cases.json > src/docker-gate/testdata/go-parser.json`.
Gaps it found and the gate now closes: Transfer-Encoding on an HTTP/1.0 request is refused (Go ignores it and reads the
chunks as the next request), and a form-encoded body is an `form-encoded-body` finding (Go merges it into the form
ahead of the query, so `networkmode=host` could ride in the body of `POST /build`), and a request target holding
`#` is refused (Go keeps `#` as data: `/build?q=1#&networkmode=host` sets `networkmode`; the gate used to drop it as a
fragment).

## Route parity

`policy.ts` `ROUTES` / `READ_ROUTES` mirror the engine's router (moby `api/server/router`); `ENGINE_ROUTES` in
`src/docker-gate/policy.test.ts` lists every route the engine serves and the gate's class for it, bare and under every
version prefix the engine strips. Container, network and volume names match `.+` because the engine registers them as
`{name:.*}`. Mutating routes no flow uses (`PUT /volumes/{name}`, checkpoints, `/debug`) are `restricted-group`; any path
the table does not know is an `unclassified-route` finding (deny by default).

## Stage 4: build sessions for the daemon's own builds only

BuildKit's `/session` and `/grpc` upgrade to HTTP/2 the gate cannot read: every build choice (entitlements, network,
mounts) rides inside them. They open only on the **build listener** (`build.ts`):

- **Identity.** The client is the daemon account `tp` (`railpack-build.ts` runs `docker buildx build` as tp; Compose
  builds too). The sandboxed build runner (`tp-host build-run`'s per-build throwaway users) never speaks Docker: its unit makes
  `/run/turbopanel-gate` and both Docker sockets inaccessible. Deno cannot read a Unix peer's credentials (no
  SO_PEERCRED), and a header token does not work either: the Docker CLI's `HttpHeaders` are not sent on the hijacked
  `/grpc` request buildx opens (seen on host-a, Engine 29.8 / buildx 0.37: the header was missing on every `/grpc`).
  So the kernel checks the caller at `connect()`: `TP_DOCKER_GATE_BUILD_SOCKET` (`/run/turbopanel-gate/build/docker.sock`)
  is `root:tpgatebuild 0660` in a `root:tpgatebuild 0750` directory of its own. `tpgatebuild`
  (`docker_gate_build_group`, its gid in `TP_DOCKER_GATE_BUILD_GID`) holds only `docker_gate_build_user` (`tp`): the
  role creates it, adds tp, and fails if it holds anyone else. Root owns socket and directory, so tp cannot chmod
  either wider. caddy (in group tp, not tpgatebuild) cannot even traverse; a container never gets it (`/run` is a
  denied, unapprovable bind). The daemon process picks up the new group at its next restart. A missing build user or
  group fails the install task (the block's rescue reports it). With no gid, or when the socket cannot open, the gate
  logs `docker-gate.build-socket-unavailable` and opens no build listener (never a silent root-only socket); the
  other sockets keep serving.
- **Check.** `/session` or `/grpc` anywhere but the build listener is a `build-session` finding. No header lifts it.
  On the build listener every other request is judged exactly as on the main socket.
- **Modes.** Observe logs the finding as `would-deny` and relays. Enforce answers 403 with a `docker-gate.denied`
  line (method, route, rules) **before the engine is reached**, for this finding and every other one left after
  allowances and approvals. The read-only listener refuses both routes as before.
- **Daemon side (wired, stage 4):** every buildx / Compose build call uses a Docker context (`turbopanel-build`)
  whose host is the build socket, written by `src/deploy/docker-cli.ts` and passed as `--context` (and buildx
  `--builder turbopanel-build`). `DOCKER_HOST` alone is not enough: with it set, buildx's `default` builder becomes a
  `docker-container` builder that creates a privileged BuildKit container (refused).
- **Proof (host-a, a separate enforce-mode gate on its own sockets):** buildx as tp through the build socket built
  and loaded an image; through the main socket `/grpc` was refused and the fallback BuildKit container's create too;
  tpbuild and uid 65534 with gid tp could not connect to the build socket; spoofed headers, and a container handed
  the main socket, got 403 on `/session` and `/grpc`; a create binding the build directory was refused
  (`bind-forbidden-path`). In observe mode the same `/session` was relayed (101) and logged.

Tests: `src/docker-gate/build.test.ts`.
