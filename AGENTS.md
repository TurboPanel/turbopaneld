# AGENTS.md

Agent-node daemon: the **constant** installed on every TurboPanel-managed host. It connects to a TurboPanel **instance** over WSS and runs local orchestration (Ansible, Docker, Cloudflare tunnels). It is the only party that installs/updates everything else via Ansible — including, in co-located dev, the instance + UI + Caddy. It **does not self-update**; updates are operator-driven.

## Speed doctrine (turbo)

TurboPanel is named for speed; keep the daemon fast.

- **Cache runtimes & deps.** Deno/Node/Caddy/cloudflared live under `/opt/turbopanel/runtimes/<tool>/current`; roles install only when the pinned version is missing.
- **Idempotent bootstrap.** `initOrchestration()` and every role short-circuit when already satisfied, so restarts are cheap and work offline.
- **No background polling.** The 60s version poll and self-update were removed; updates come via the developer upgrade button or a `dev-sync` push.
- **Don't clobber dev work.** `instance-repo`/`ui-repo` clone only when missing and never force-reset a live working tree.

## Users & privileges

- **`turbopanel`** (UID/GID **9999**): the daemon user; has passwordless sudo; owns `/opt/turbopanel`.
- **`turbopanel`** (UID/GID **9999**): the daemon user; has passwordless sudo; owns the install tree and **all git** on co-located dev hosts.
- **`instance`** (UID **9998**): runs the instance/Caddy/UI in group `turbopanel`, **no own group, no sudo** (created by the `instance-user` role). Reads checkouts via group; does not own source files.
- Co-located dev checkouts are **`2770 turbopanel:turbopanel`** (`instance-user` role). Clones and `pnpm install` run as **9999**; systemd services run as **9998**. `scripts/normalize-dev-checkout.sh` (also `/usr/local/bin/turbopanel-normalize-dev-checkout`) re-homes any stray `instance`-owned source files after git; it skips instance `$HOME` dirs `.cache`, `.config`, `.local`. Upgrade System calls it automatically after each `git reset`.
- `/run/turbopanel` is `2770 turbopanel:turbopanel` (setgid) so `instance` can bind the socket; see `../turbopanel/AGENTS.md`.

## Documentation discipline

**Keep this file current.** When you learn something durable about agent nodes — install prerequisites, orchestration playbooks, connectivity, slim-Debian gotchas — add or update a note here alongside code changes. Future agents read `AGENTS.md` first.

- Prefer extending an existing section over orphan bullets.
- Record **why** when non-obvious (missing packages, ordering constraints, idempotency traps).
- Cross-link the instance repo (`../turbopanel/AGENTS.md`) for Caddy, `/ws/*`, and platform CA details.
- Do not record secrets, tokens, or machine-specific credentials.
- Remove or correct notes that prove wrong.

`README.md` is for humans installing nodes; `AGENTS.md` is for agents maintaining the daemon.

## Instance connectivity

Two modes in `src/instance/paths.ts`:

| Mode | When | Target |
|---|---|---|
| `url` | `TURBOPANEL_INSTANCE_URL` set (installed agents) | `https://<host>:<port>` / `wss://…/ws/daemon/v1` through Caddy |
| `socket` | No URL (co-located dev on the instance host) | `unix:///run/turbopanel/turbopanel.sock` |

On connect the daemon sends a `hello` with `hostname` (`Deno.hostname()`) and `nodeId` (`/etc/machine-id`). The instance uses these (and `X-Real-IP` from Caddy) to dedupe reconnects. The daemon dials the versioned WS path **`/ws/daemon/v1`** and reads `GET /api/daemon/v1/version` / `GET /api/daemon/v1/instance/ca`.

Install flow: official installer (separate CDN repo) → `scripts/bootstrap-orchestration.sh` (uv, Python, ansible, **Galaxy roles**) → `orchestration/playbooks/agent-install.yml`. Docker is installed in that playbook and again at daemon startup via `initOrchestration()` in `src/orchestration/setup.ts`.

Daemon runtime is managed by systemd (`turbopanel-daemon.service`): `flock` enforces a single process, `deno run` without `--watch`, and the official installer / `agent-install.yml` reconcile the unit on every run. **No self-update** — `updater.ts` was removed. A `dev-sync` push (see below) is the fast dev path; the developer upgrade button is the operator path.

## Ansible owns all installs (incl. co-located dev instance)

The daemon bootstraps uv/Python/ansible, then runs playbooks. Roles (in `orchestration/roles/`):

| Role | Purpose |
|---|---|
| `agent-prereqs` | apt prerequisites (incl. `xz-utils` for Node, `tar`, `unzip`) |
| `turbopanel-user` / `instance-user` | the 9999 / 9998 users |
| `runtime-sockets` | `/run/turbopanel` as `2770` setgid |
| `deno-runtime` / `node-runtime` / `caddy` | vendored runtimes under `runtimes/<tool>/current` |
| `instance-repo` / `ui-repo` | clone-if-missing checkouts (never force-reset), `pnpm install` |
| `instance-certs` | platform CA + leaf via the instance cert script |
| `instance-launch` | `turbopanel-instance` / `turbopanel-caddy` / `turbopanel-ui` units (run as `instance:turbopanel`) |
| `postgres` | PostgreSQL 18 in Docker; data under `/var/lib/turbopanel/postgres`, Unix socket at `/var/run/turbopanel/postgres` |
| `docker` / `daemon-repo` / `daemon-config` / `daemon-logs` / `daemon-launch` | agent-node provisioning |

- Co-located **dev** install: `orchestration/playbooks/instance-dev-install.yml`, run by `initOrchestration()` when co-located (socket mode) **and** `TURBOPANEL_DEV_INSTANCE=1`. `develop.sh` in `../turbopanel` sets the flag and installs the daemon unit, which then installs the rest.
- Production prebuilt instance/UI artifacts and static UI hosting are **out of scope** (seams/comments only).

## Orchestration

- Playbooks: `orchestration/playbooks/`
- Galaxy roles: `orchestration/requirements.yml` (pinned, installed into `orchestration/roles/`, gitignored)
- Docker: thin `roles/docker` wrapper around **`geerlingguy.docker`** (Debian Trixie/Raspbian). Skips install when Docker is already running but **always** adds `turbopanel` to the `docker` group (needed on co-located dev hosts where Docker predates the daemon).
- Bootstrap also runs on every daemon start (idempotent; failures are logged, daemon keeps running). After Docker, `postgres-setup.yml` starts `turbopanel-postgres` (`postgres:18`) with the data volume at `/var/lib/turbopanel/postgres` → `/var/lib/postgresql` (PG 18+ layout) and the socket dir bind-mounted to `/var/run/turbopanel/postgres`.
- Logs are written to both journald and `/var/log/turbopanel/daemon/{daemon.log,daemon.err.log}` when running under systemd (`StandardOutput`/`StandardError` in the unit template). Logrotate policy lives at `/etc/logrotate.d/turbopanel-daemon` (daily, 14 rotations, compress). The log directory is recreated on boot via `/etc/tmpfiles.d/turbopanel-daemon-logs.conf`. The `daemon-logs` role provisions all of this; the official installer runs it via `daemon-launch`, and `initOrchestration()` re-runs `daemon-logs-setup.yml` on every daemon start so existing agents pick it up without a full reinstall.

### Runtime (systemd only)

Agent nodes and co-located dev hosts run **`turbopanel-daemon.service`** — there is no Tilt entrypoint in this repo. The official installer / `agent-install.yml` install the unit; co-located instance hosts use `scripts/install-daemon-systemd.sh` (which also ensures the user, prereqs, and Deno so a fresh dev host is self-sufficient). `scripts/ensure-single-daemon.sh` (ExecStartPre) is a one-time legacy cleanup: it stops any leftover Tilt and removes obsolete pre-systemd dev units, then guards the flock lock.

### Dev sync & instance tunnel (WS messages)

- **Dev sync**: the instance streams a tarball of `../daemon` as `dev-sync-begin`/`dev-sync-chunk`/`dev-sync-end`; the daemon (`src/dev-sync-apply.ts`) unpacks over its checkout (excluding `.git`, `orchestration/runtime`, `orchestration/roles`, `cloudflared/tunnels`, `node_modules`), runs `deno cache`, replies `dev-sync-result`, then `systemctl restart`s.
- **Instance tunnel**: a `tunnel-token` message makes the co-located daemon write `cloudflared/tunnels/instance.token` and (re)launch the supervisor in `src/tunnels.ts` (`writeInstanceTunnelToken`), exposing the instance to external nodes.
- Both reply with a result message the instance correlates by id.

### Slim Debian prerequisites

Minimal Debian images often lack packages full installs have. Agent bootstrap and `roles/agent-prereqs` must include anything Ansible/Docker need before playbooks run:

| Package | Why |
|---|---|
| `unzip` | Deno install script |
| `xz-utils` | Node tarball extraction (`tar -J`) |
| `tar` | dev-sync archive + runtime extraction |
| `gnupg` | Legacy apt paths; still useful on slim hosts |
| `python3-debian` | `deb822_repository` in `geerlingguy.docker` |
| `iptables` | Docker networking |

## Layout

- `main.ts` — entry; orchestration bootstrap, tunnels, instance client (no self-update)
- `install.sh` has been removed — the official node installer lives in [turbopanel/turbopanel-cdn](https://github.com/turbopanel/turbopanel-cdn) (see `README.md` for the curl workflow)
- `src/instance/client.ts` — WSS client; command/address + dev-sync/tunnel-token handlers
- `src/dev-sync-apply.ts` — unpack + cache a synced daemon build
- `src/tunnels.ts` — cloudflared supervisor + `writeInstanceTunnelToken`
- `src/orchestration/` — uv/Python/ansible bootstrap, playbook runners (incl. `runInstanceDevInstall`)
- `orchestration/playbooks/instance-dev-install.yml` — co-located dev instance/UI/Caddy install
- `orchestration/roles/{instance-user,node-runtime,caddy,instance-repo,ui-repo,instance-certs,instance-launch}` — instance-side install roles
- `orchestration/roles/daemon-launch/templates/turbopanel-daemon.service.j2` — daemon systemd unit template
- `scripts/install-daemon-systemd.sh` — install `turbopanel-daemon.service` on co-located dev (after `turbopanel-instance.service`)
