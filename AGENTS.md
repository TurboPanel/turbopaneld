# AGENTS.md

Managed-server daemon: the **constant** installed on every TurboPanel-managed host. It connects to a TurboPanel **instance** over WSS and runs local orchestration (Ansible, Docker, Cloudflare tunnels). It is the only party that installs/updates everything else via Ansible — including, in co-located dev, the instance + UI + Caddy. It **does not self-update**; updates are operator-driven.

## Speed doctrine (turbo)

TurboPanel is named for speed; keep the daemon fast.

- **Cache runtimes & deps.** Deno/Node/Caddy/cloudflared live under `/opt/turbopanel/runtimes/<tool>/current`; roles install only when the pinned version is missing.
- **Idempotent bootstrap.** `initOrchestration()` and every role short-circuit when already satisfied, so restarts are cheap and work offline.
- **No background polling.** The 60s version poll and self-update were removed; updates come via the developer upgrade button or a `dev-sync` push.
- **Don't clobber dev work.** `instance-repo`/`ui-repo` clone only when missing and never force-reset a live working tree.

## Users & privileges

- **`turbopanel`** (UID/GID **9999**): the daemon user; has passwordless sudo; owns `/opt/turbopanel` and is the **git identity** on co-located dev hosts (not necessarily the human developer).
- **Developer** (whoever invokes `./console`): identity captured as `TURBOPANEL_DEV_USER` / `TURBOPANEL_DEV_UID` / `TURBOPANEL_DEV_GID` in the daemon `.env` (never hardcoded). The `dev-permissions` role adds this user to the `turbopanel` group as a supplementary group so they can edit source files via group ACL write.
- **`instance`** (UID **9998**): runs the instance/Caddy/UI in group `turbopanel`, **no own group, no broad sudo** (created by the `instance-user` role). Reads checkouts via group; does not own source files. Scoped passwordless sudo via `/etc/sudoers.d/turbopanel-instance-upgrade` (`instance-launch` `upgrade-sudoers.yml`): restart instance/caddy/ui units, `git` as `turbopanel`, normalize script, and **`/usr/bin/pamtester login * authenticate`** (host install gate — root or sudo users via PAM from the instance process).
- **`redis`** (UID **9997**): runs `turbopanel-redis.service` in group `turbopanel` (created by the `redis` role; self-sufficient — does not require `instance-user` to run first).
- Co-located dev checkouts (`daemon`, `turbopanel`, `ui`) are **`2770 turbopanel:turbopanel`** with default ACL **`g:turbopanel:rwx`** so files created by git, pnpm, or the editor remain group-writable. **Why default ACLs?** setgid propagates group ownership of new files but not the write bit — without a default ACL, files created by `turbopanel` (e.g. after `git pull`) are `640` and the dev user cannot write them. `dist`/release dirs are owned by `instance` and excluded from the dev-editable ACL. Clones and `pnpm install` run as **9999**; systemd services run as **9998**. Per-service runtime state for the instance user lives in **gitignored** checkout dirs: **`turbopanel/.local`** (instance + Caddy), **`ui/.local`** (Expo), plus matching **`.config`** trees. The **daemon** (`9999`) keeps its own state under **`/opt/turbopanel`** (passwd `HOME`). The normalizer skips checkout `.cache`/`.config`/`.local` when reclaiming source files to `turbopanel` and re-applies default ACLs on the source tree; use `--prepare-reset` before Upgrade System `git reset` and `--ensure-runtime-dirs` after.
- **`acl` / `setfacl` is dev-only.** Production managed servers never install the `acl` package and never apply ACLs — production hosts should not natively enable ACL management. Co-located dev installs the package in `instance-dev-install.yml` `pre_tasks` (gated on `turbopanel_dev_user`) before `runtime-sockets` and `dev-permissions` apply ACLs. The turbopanel-dev console helpers (`tp_apply_dev_host_acls`, `tp_fix_deno_runtime_access`) fall back to `chmod` when `setfacl` is absent until the daemon installs `acl`.
- `/run/turbopanel` is `2770 turbopanel:turbopanel` (setgid) so `instance` can bind the socket; see `../turbopanel/AGENTS.md`.

## Documentation discipline

**Keep this file current.** When you learn something durable about managed server daemons — install prerequisites, orchestration playbooks, connectivity, slim-Debian gotchas — add or update a note here alongside code changes. Future agents read `AGENTS.md` first.

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
| `url` | `TURBOPANEL_INSTANCE_URL` set (remote managed servers) | `https://<host>:<port>` / `wss://…/ws/daemon/v1` through Caddy |
| `socket` | No URL (co-located dev on the instance host) | `unix:///run/turbopanel/instance.sock` (Tilt dev: `dev/.run/turbopanel/instance.sock`) |

On connect the daemon sends a `hello` with `hostname`, optional persisted `serverId`, and `machineId` (`/etc/machine-id`) for first-time registration. Managed installs store the server id at `/etc/turbopanel/platform/daemon/server.id` (`TURBOPANEL_DAEMON_STATE_DIR` overrides the directory); local Tilt dev (`TURBOPANEL_SKIP_ORCHESTRATION=1`) stores it as `./server.id` in the daemon checkout so the restricted dev permissions can write it. The instance resolves a canonical **`servers.id`** (uuidv7), replies with `serverId` in `hello`, and dedupes reconnects by `serverId` / `X-Real-IP` / `hostname`. The daemon dials **`/ws/daemon/v1`** and may read `GET /api/daemon/v1/version` (informational only) and `GET /api/daemon/v1/instance/ca`.

Install flow: official installer (separate CDN repo) → `scripts/bootstrap-orchestration.sh` (uv, Python, ansible, **Galaxy roles**) → `orchestration/playbooks/daemon-install.yml`. Docker is installed in that playbook and again at daemon startup via `initOrchestration()` in `src/orchestration/setup.ts`.

Daemon runtime is managed by systemd (`turbopanel-daemon.service`): `flock` enforces a single process, `deno run` without `--watch`, and the official installer / `daemon-install.yml` reconcile the unit on every run. **No self-update** — `updater.ts` was removed. A `dev-sync` push (see below) is the fast dev path; the developer upgrade button is the operator path.

## Ansible owns all installs (incl. co-located dev instance)

The daemon bootstraps uv/Python/ansible, then runs playbooks. Roles (in `orchestration/roles/`):

| Role | Purpose |
|---|---|
| `daemon-prereqs` | apt prerequisites (`xz-utils` for Node, `tar`, `unzip`, `pamtester`, Redis build deps) |
| `turbopanel-user` / `instance-user` | the 9999 / 9998 users |
| `runtime-sockets` | `/run/turbopanel` as `2770` setgid |
| `deno-runtime` / `node-runtime` / `caddy` | vendored runtimes under `runtimes/<tool>/current` |
| `redis` | Native Redis binary under `runtimes/redis/current`; dedicated **`redis`** system user (UID 9997, group `turbopanel`); Unix socket at `/run/turbopanel/redis.sock` (mode 0660, group `turbopanel`); **`port 0`** in `redis.conf` (socket-only, no TCP listener) |
| `rabbitmq` | RabbitMQ `4-management` in Docker container **`turbopanel-q`**; generated password in `/etc/turbopanel/rabbitmq/.rabbitmq_pass`; AMQP on `127.0.0.1:5672`; management UI on `127.0.0.1:15672`; **`turbopanel-rabbitmq.service`** wraps the container for systemd ordering |
| `instance-dev-prereqs` | dev-only apt libs for React Native devtools (GTK/NSS/GBM stack; probes `*t64` renames on Debian 13+) |
| `instance-repo` / `ui-repo` | clone-if-missing checkouts (never force-reset), `pnpm install` |
| `instance-build` | Compiles `src/deno.ts` → `dist/turbopanel-instance` single binary (when `turbopanel_instance_run_mode=compiled`); no-op in `source` mode |
| `ui-build` | Runs `pnpm export` → `ui/dist` (dev) or downloads CDN artifact (prod) when `turbopanel_ui_mode=static`; no-op in `dev` mode |
| `instance-certs` | platform CA + leaf via the instance cert script |
| `instance-launch` | `turbopanel-instance` / `turbopanel-caddy` / `turbopanel-ui` / `turbopanel-mailer` units (run as `instance:turbopanel`). Injects `TURBOPANEL_DATABASE_URL` into the instance unit (Unix-socket URL for Deno; TCP URL in `instance-workers.env` for Workers). **`turbopanel-ui` must invoke `node_modules/.bin/expo` directly** — `pnpm exec expo` runs an implicit install that prompts to purge `node_modules` (installed by `turbopanel` with a different `HOME`), which blocks Expo and yields Caddy 502s on restart. |
| `dev-permissions` | add invoking dev user to `turbopanel` group; apply setgid + default ACLs on checkouts (no-op on managed servers without dev user) |
| `postgres` | PostgreSQL 18 in Docker; data under `/var/lib/turbopanel/postgres`, Unix socket at `/var/run/turbopanel/postgres` |
| `docker` / `daemon-repo` / `daemon-config` / `daemon-logs` / `daemon-launch` | managed-server daemon provisioning |

- Co-located **dev** install: `orchestration/playbooks/instance-dev-install.yml` (single converge playbook), run by `initOrchestration()` when co-located (socket mode) **and** `TURBOPANEL_DEV_INSTANCE=1`. The [turbopanel-dev](https://github.com/turbopanel/turbopanel-dev) console (`./console` → **Start dev stack**) writes developer identity into the daemon `.env`, bootstraps orchestration, and installs `turbopanel-daemon.service`, which then installs the rest via Ansible. **Local Tilt dev** (`../dev/Tiltfile`) runs the daemon via `scripts/daemon-serve.sh` with `TURBOPANEL_SKIP_ORCHESTRATION=1` instead — Tilt already manages instance/Caddy/Postgres; Workers mode sets `TURBOPANEL_INSTANCE_URL` to Caddy HTTPS, Deno mode dials the dev socket dir. Dev converge includes Postgres via the shared `postgres` role (not the legacy `postgres-setup.yml` playbook). The Docker container always publishes a Unix socket; the instance and drizzle-kit connect via `TURBOPANEL_DATABASE_URL` (a Unix-socket postgres URL set by `instance-launch`; TCP port exposure is optional via `postgres_expose_port`, off in dev).

### Build modes

| Variable | Values | Effect |
|---|---|---|
| `turbopanel_instance_run_mode` | `source` (default) \| `compiled` | `source`: `deno run src/deno.ts` via systemd; `compiled`: single binary at `dist/turbopanel-instance` |
| `turbopanel_ui_mode` | `dev` (default) \| `static` | `dev`: Expo dev server via `turbopanel-ui.service`; `static`: Caddy serves `ui/dist`, `turbopanel-ui.service` stopped |
| `turbopanel_ui_artifact_url` | empty (default) \| CDN URL | empty: local `pnpm export`; non-empty: download tarball from CDN (production seam) |

Toggle via the dev console **Switch to production build** / **Switch to dev build** — persists `TURBOPANEL_UI_MODE` and `TURBOPANEL_INSTANCE_RUN_MODE` to the daemon `.env`, then re-runs `instance-build-toggle.yml` (roles: `ui-build` → `instance-build` → `instance-launch`).

## Orchestration

- Playbooks: `orchestration/playbooks/`
- Galaxy roles: `orchestration/requirements.yml` (pinned, installed into `orchestration/roles/`, gitignored)
- Docker: thin `roles/docker` wrapper around **`geerlingguy.docker`** (Debian Trixie/Raspbian). Skips install when Docker is already running but **always** adds `turbopanel` to the `docker` group (needed on co-located dev hosts where Docker predates the daemon).
- Bootstrap also runs on every daemon start (idempotent; failures are logged, daemon keeps running). `initOrchestration()` runs one convergence playbook per mode: `daemon-converge.yml` (daemon-only) or `instance-dev-install.yml` (co-located dev), gathering facts once and running shared roles without overlapping docker/redis/rabbitmq/postgres invocations. Bootstrap stamps (`orchestration/runtime/bootstrap.stamp`) skip redundant Galaxy installs and the localhost smoke test when pinned requirements are unchanged.
- Logs are written to both journald and `/var/log/turbopanel/daemon/{daemon.log,daemon.err.log}` when running under systemd (`StandardOutput`/`StandardError` in the unit template). Logrotate policy lives at `/etc/logrotate.d/turbopanel-daemon` (daily, 14 rotations, compress). The log directory is recreated on boot via `/etc/tmpfiles.d/turbopanel-daemon-logs.conf`. The `daemon-logs` role provisions all of this; the official installer runs it via `daemon-launch`, and `initOrchestration()` re-runs `daemon-logs-setup.yml` on every daemon start so existing daemons pick it up without a full reinstall.

### Runtime (systemd + Tilt)

Managed server daemons and co-located dev hosts run **`turbopanel-daemon.service`** (systemd). The official installer / `daemon-install.yml` install the unit; co-located instance hosts use `scripts/install-daemon-systemd.sh` (which also ensures the user, prereqs, and Deno so a fresh dev host is self-sufficient). **Local Tilt dev** runs the same process from `../dev/scripts/daemon-serve.sh` (Tilt `daemon` resource) with `TURBOPANEL_SKIP_ORCHESTRATION=1` so Ansible bootstrap is skipped. `scripts/ensure-single-daemon.sh` (ExecStartPre) ensures `/run/turbopanel` exists with correct permissions and clears any stale `daemon.lock` left by an unclean shutdown.

### Services

| Unit / container | Purpose | Ordering |
|---|---|---|
| `turbopanel-redis.service` | Redis Unix socket at `/run/turbopanel/redis.sock` (runs as **`redis:turbopanel`**) | After `network.target` |
| `turbopanel-rabbitmq.service` | RabbitMQ Docker container (AMQP + management UI on loopback) | After `docker.service` |
| `turbopanel-mailer.service` | RabbitMQ email consumer → SMTP | After `turbopanel-instance` and `turbopanel-rabbitmq` |

### Legacy Docker container names (one-time cleanup)

Older dev installs used container names **`turbopanel-postgres`** and **`turbopanel-rabbitmq`**. Current roles use **`turbopanel-db`** and **`turbopanel-q`**. If a host still has the old containers after upgrade, remove them manually before re-converging:

```bash
docker rm -f turbopanel-postgres turbopanel-rabbitmq
```

Then re-run the daemon playbook or restart the dev stack so the roles recreate **`turbopanel-db`** / **`turbopanel-q`**.

### Dev sync & instance tunnel (WS messages)

- **Dev sync**: the instance streams a tarball of `../daemon` as `dev-sync-begin`/`dev-sync-chunk`/`dev-sync-end`; the daemon (`src/dev-sync-apply.ts`) unpacks over its checkout (excluding `.git`, `orchestration/runtime`, `orchestration/roles`, `cloudflared/tunnels`, `node_modules`), runs `deno cache`, replies `dev-sync-result`, then `systemctl restart`s.
- **Instance tunnel**: a `tunnel-token` message makes the co-located daemon write `cloudflared/tunnels/instance.token` and (re)launch the supervisor in `src/tunnels.ts` (`writeInstanceTunnelToken`), exposing the instance to external nodes.
- Both reply with a result message the instance correlates by id.

### Slim Debian prerequisites

Minimal Debian images often lack packages full installs have. Daemon bootstrap and `roles/daemon-prereqs` must include anything Ansible/Docker need before playbooks run:

| Package | Why |
|---|---|
| `unzip` | Deno install script |
| `xz-utils` | Node tarball extraction (`tar -J`) |
| `tar` | dev-sync archive + runtime extraction |
| `gnupg` | Legacy apt paths; still useful on slim hosts |
| `python3-debian` | `deb822_repository` in `geerlingguy.docker` |
| `iptables` | Docker networking |
| `build-essential` | Redis compile (`make`, `gcc`) |
| `libssl-dev` | Redis TLS/OpenSSL headers at compile time |
| `pkg-config` | Redis build dependency resolution |

Co-located dev (`instance-dev-prereqs` role, not `daemon-prereqs`) installs the Chromium/GTK runtime stack (`libatk*`, `libnss3`, `libgbm1`, `libgtk-3-0`, …) so `@react-native/debugger-shell` passes its `--version` prep check. Debian 13+ `*t64` renames are probed at install time. A headless server may still log DISPLAY warnings when opening the GUI debugger; that is separate from the shared-library install.

## Layout

- `main.ts` — entry; orchestration bootstrap, tunnels, instance client (no self-update)
- `install.sh` has been removed — the official node installer lives in [turbopanel/turbopanel-cdn](https://github.com/turbopanel/turbopanel-cdn) (see `README.md` for the curl workflow)
- `src/instance/client.ts` — WSS client; command/address + dev-sync/tunnel-token handlers
- `src/dev-sync-apply.ts` — unpack + cache a synced daemon build
- `src/tunnels.ts` — cloudflared supervisor + `writeInstanceTunnelToken`
- `src/orchestration/` — uv/Python/ansible bootstrap, playbook runners (incl. `runInstanceDevInstall`)
- `orchestration/playbooks/instance-dev-install.yml` — co-located dev instance/UI/Caddy install
- `orchestration/roles/{instance-user,instance-dev-prereqs,node-runtime,caddy,instance-repo,ui-repo,instance-certs,instance-launch}` — instance-side install roles
- `orchestration/roles/daemon-launch/templates/turbopanel-daemon.service.j2` — daemon systemd unit template
- `scripts/install-daemon-systemd.sh` — install `turbopanel-daemon.service` on co-located dev (after `turbopanel-instance.service`)
