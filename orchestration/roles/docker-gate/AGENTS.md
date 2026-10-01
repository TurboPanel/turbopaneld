# Docker gate (`docker-gate`) — AGENTS.md

Root context: `../../../AGENTS.md` → **Managed-host privilege boundary**
("Docker" is the first of the three root-equivalent routes of the daemon
account `tp`). This role is **stage 2 of 5** of closing it.

## What exists today (stages 1-2: observe mode)

A root-owned systemd service, `turbopanel-docker-gate.service`, runs the
vendored Deno (`<install>/vendor/deno/current/deno`) over the TypeScript in
`files/` (copied root-owned to `<install>/lib/docker-gate/`). It listens on
`/run/turbopanel-gate/docker.sock` (`root:tp 0660`, directory `root:tp 0750`),
forwards every request byte for byte to the real `/var/run/docker.sock`, and
**logs what the strict profile would refuse**. It never refuses a policy
violation. **Nothing routes through it**: the daemon still uses the real
socket (no `DOCKER_HOST`, no `TURBOPANEL_DOCKER_SOCKET`), and `tp` is still in
the `docker` group. The only wire-visible refusals are framing ones (below).

Installed on managed hosts only (`turbopanel_dev_user` empty), wherever Docker
is: the `docker` role includes it at the end, and `daemon-converge.yml` runs it
for hosts that already have Docker. The whole install is a block with a
`rescue` that only prints a warning: **in stage 1 nothing depends on the gate,
so a failure to install it must never block a Docker install or a converge.**
A later stage that routes traffic through it flips this to fatal.

## Files (`files/`, dependency-free, no import map, no network)

| File | Job |
| ---- | --- |
| `http.ts` | Strict HTTP/1.1 framing: head parse, `Content-Length` / chunked bodies, refusal of every ambiguity (both lengths, repeated lengths, folding, bare LF, `Transfer-Encoding` other than `chunked`) |
| `proxy.ts` | One client connection: request in, fresh engine connection, response back. Upgrades (`attach`, `exec start`, Compose `/session` + `/grpc`) are spliced raw **only after the engine answers 101** |
| `platform.ts` | Ownership classes (`platform` / `tenant` / `unlabeled`) from labels, and the narrow bind allowance of platform containers |
| `approval.ts` | Verifier for the control plane's signed per-deploy approval (Ed25519 via WebCrypto); no signer, no private key |
| `inspect.ts` | Root-side `GET /containers/{id}/json` for the ownership check (labels only, never logged) |
| `review.ts` | Per request: policy findings, allowance hits, approval check, ownership check; logs + counters |
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
privileged `exec`; binds (`Binds`, `Mounts` of type bind, and `local`-driver
volumes that are really `o=bind,device=<path>` or a `device=/dev/...`) whose
resolved source is `/`, the Docker socket, a denied tree (`/etc`, `/run`,
`/proc`, `/sys`, `/dev`, `/root`, `/boot`, `/opt/turbopanel`, `/backup`), or
outside the bind roots (`/srv/users`, `<state>/storage`); non-bridge network
drivers and non-`local` volume drivers; `build` with host network or a cgroup
parent; any `PUT /containers/{id}/archive`; mutating calls on `/plugins`,
`/swarm`, `/nodes`, `/services`, `/tasks`, `/secrets`, `/configs`; paths the
engine would clean (`..`, `//`).

**Expected findings on every host in this stage** (not bugs): the platform's
own containers bind `/etc/turbopanel/...` and `/var/lib/turbopanel/...`
(ProxySQL, orchestrator, managed-engine config and data) and the ingress
Tecnativa proxy container mounts `/var/run/docker.sock` until stage 3 deletes
it. Since stage 2 the platform's own compose containers are allowed (see
below), so what remains on a host is the socket proxy and the label-less
managed-file helpers.

## Stage 2 additions (still observe: nothing is refused)

**Platform allowance** (`platform.ts`). A create is `platform` when it carries
`turbopanel.role` in {`turbopanel`, `ingress`} plus a known
`com.turbopanel.system.component` (`hosting-ingress`, `managed-ingress`,
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
service mounts the Docker socket until stage 3 deletes it, and the managed-file
helpers in `src/managed/materialize.ts` are plain `docker run -v <state>/managed`
with no platform label, and so are the backup and restore helpers in
`src/backups/copy-backup.ts` / `copy-restore.ts` (`docker run --rm --mount`):
every backup run logs `unlabeled-create` today. The daemon must stamp a platform
label on all of these before enforcement.

**Ownership observation.** Every create counts by owner class (`owners`) and an
unlabeled one is `unlabeled-create`. For start / stop / restart / kill / pause /
rename / update / exec-create / attach / archive / remove, the gate inspects the
target as root and logs `unowned-container` when it carries neither a Compose
project, a TurboPanel label nor `tp.managed.engine`. An inspect that fails (gone,
engine error) is skipped, never a finding.

**Signed approvals** (`approval.ts`). Host-level Compose features cannot rest on
the daemon's own `hostLevelApproved` flag (the daemon account sets it). The
control plane signs, the gate verifies with a public key. Token = container
label `com.turbopanel.approval` = `v1.<b64url payload>.<b64url sig>`; the
signature covers `turbopanel-docker-gate-approval-v1\n` + the payload text.
Payload: `deployId`, `project`, `composeDigest` (audit only: the gate never sees
the compose file), `features[]`, `iat`, `exp` (seconds). The gate checks the
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
serving. Replay of a still-valid token by the daemon only repeats the same
relaxation for the same project until `exp`. `docker-socket` is approvable
because the owner asked for it; plan finding B wanted socket mounts forbidden
outright, so delete that one line in `APPROVABLE_RULES` to forbid it. The signer
(control plane) is not built yet; tests sign with a key generated at run time.

**Corpus.** `src/docker-gate/testdata/corpus.json` now also holds creates
recorded from a real Engine 29 / Compose 5.5 for the ProxySQL, orchestrator and
managed-engine compose shapes (images swapped, `Env`/`Cmd` scrubbed, paths
rewritten) and the managed-file helper.

**Counters** in the summary line: `allowances`, `approvals`, `approvedRules`,
`owners` (plus the stage-1 `requests`, `upgrades`, `wouldDeny`, `refusals`).

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
- `TP_DOCKER_GATE_MODE` accepts only `observe`; the unit pins it. Enforcement
  is a later stage and must arrive with its own tests.
- The gate source is root-owned in `<install>/lib/docker-gate/`; `tp` can read
  it, never change it.
- `src/permissions/daemon-permissions.ts` grants the daemon read + write on
  `/run/turbopanel-gate` (`DOCKER_GATE_SOCKET_DIR`), which Deno needs to
  `connect()` to the socket once `TURBOPANEL_DOCKER_SOCKET` points at it. The
  directory is root-owned, so the grant cannot create or replace anything.

## Stages (plan: closing the Docker route)

1. Gate service, observe mode, nothing routed through it.
2. **This role (added)**: platform allowance, ownership observation, signed
   approval verifier, `/grpc` + `/session` proven end to end, still observe.
3. Traefik on a read-only filtered socket; the tp-created Tecnativa container
   is removed.
4. `tp` switches to the gate (`DOCKER_HOST`, `TURBOPANEL_DOCKER_SOCKET`), drops
   the `sudo -u self docker` fallback, **enforce mode**; `tp` still in `docker`.
5. `tp` leaves the `docker` group; the real socket is root-only.

Break-glass at every stage: `systemctl stop turbopanel-docker-gate` as root.

## Lockouts to expect when enforcement arrives (stage 4; none bite in stage 2)

- Approval key missing or rotated without overlap: every host-level deploy is
  denied. Ship the new key alongside the old one, then retire the old one.
- Clock skew between control plane and host beyond 60 s (or a token older than
  its `exp`): approvals read as `expired` / `not-yet-valid`.
- An inspect round trip that fails would deny the action once ownership is
  enforced: stage 4 must decide fail-open vs fail-closed per route.
- Renaming a system component label (or an emitter changing a bind path)
  makes platform containers lose the allowance; the emitter test guards the
  paths, the label constants are pinned to `src/deploy/labels.ts`.
- The label-less helpers (managed-file normalisation, **backup and restore**)
  would be denied until the daemon stamps a platform label on them: backups and
  restores stop working. This is the most critical gap to close before stage 4.
