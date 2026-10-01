# Docker gate (`docker-gate`) — AGENTS.md

Root context: `../../../AGENTS.md` → **Managed-host privilege boundary**
("Docker" is the first of the three root-equivalent routes of the daemon
account `tp`). This role is **stage 1 of 5** of closing it.

## What exists today (stage 1: observe mode)

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
it. Stage 2 turns those into an ownership rule; this stage's logs are the
exact list.

## Wire behaviour that is not a pass-through

The gate refuses, even in observe mode: `Expect:` requests (417), create
bodies over 4 MiB (413), framing ambiguities (400), non-HTTP/1.x (505), and
heads over 64 KiB (431). Each request goes to a **fresh** engine connection.
No docker, Compose or daemon client sends any of these today.

## Logs (journald, `SyslogIdentifier=turbopanel-docker-gate`, one JSON per line)

`docker-gate.would-deny` (rule, secret-free detail, method, route, path),
`docker-gate.summary` (every `TP_DOCKER_GATE_SUMMARY_SEC`, and on stop:
route / method / status counts, `upgrades`, `wouldDeny`, `refusals`),
`docker-gate.started`, `docker-gate.bad-request`,
`docker-gate.upstream-unreachable`, `docker-gate.peer-closed`. **Never
logged:** environment, commands, entrypoints, labels, registry auth, query
strings, request bodies.

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

1. **This role**: gate service, observe mode, nothing routed through it.
2. Policy engine hardening: ownership labels, platform allowance, `/grpc` +
   `/session` proven, still observe.
3. Traefik on a read-only filtered socket; the tp-created Tecnativa container
   is removed.
4. `tp` switches to the gate (`DOCKER_HOST`, `TURBOPANEL_DOCKER_SOCKET`), drops
   the `sudo -u self docker` fallback, **enforce mode**; `tp` still in `docker`.
5. `tp` leaves the `docker` group; the real socket is root-only.

Break-glass at every stage: `systemctl stop turbopanel-docker-gate` as root.
