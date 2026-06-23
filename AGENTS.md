# AGENTS.md

Managed-server daemon: the **constant** installed on every TurboPanel-managed
host. It connects to a TurboPanel **instance** over WSS and runs local
orchestration (Ansible, Docker, Cloudflare tunnels). It is the only party that
installs/updates everything else via Ansible — including, in co-located dev, the
instance + UI + Caddy. It **does not self-update**; updates are operator-driven.

## Speed doctrine (turbo)

TurboPanel is named for speed; keep the daemon fast.

- **Cache runtimes & deps.** Deno/Node/Caddy/cloudflared are installed under
  `/opt/turbopanel/runtimes/<tool>/<version>/` with a `current` symlink; roles
  install only when the pinned version is missing.
- **Idempotent bootstrap.** `initOrchestration()` and every role short-circuit
  when already satisfied, so restarts are cheap and work offline.
- **No background polling.** The 60s version poll and self-update were removed;
  updates come via the developer upgrade button or a `dev-sync` push.
- **Don't clobber dev work.** `instance-repo`/`ui-repo` clone only when missing
  and never force-reset a live working tree.

## Users & privileges

- **`turbopanel`** (UID/GID **9999**): the daemon user; has passwordless sudo;
  owns `/opt/turbopanel` and is the **git identity** on co-located dev hosts
  (not necessarily the human developer).
- **Developer** (whoever invokes `./console`): identity captured as
  `TURBOPANEL_DEV_USER` / `TURBOPANEL_DEV_UID` / `TURBOPANEL_DEV_GID` in the
  daemon `.env` (never hardcoded). The `dev-permissions` role adds this user to
  the `turbopanel` group as a supplementary group so they can edit source files
  via group ACL write. The `docker` role (and `dev-permissions`) also add the
  dev user to the `docker` group when `turbopanel_dev_user` is set.
- **`turbopaneli`** (UID **9998**): runs the instance/Caddy/UI with primary
  group **`turbopaneli`** (GID **9998**) and supplementary group
  **`turbopanel`** (GID 9999), **no broad sudo** (created by the `instance-user`
  role). Reads checkouts via group; does not own source files. Scoped
  passwordless sudo via `/etc/sudoers.d/turbopanel-instance-upgrade`
  (`instance-launch` `upgrade-sudoers.yml`): restart instance/caddy/ui units,
  `git` as `turbopanel`, normalize script, and
  **`/usr/bin/pamtester login * authenticate`** (host install gate — root or
  sudo users via PAM from the instance process).
- **`turbopanelc`** (UID **9997**): runs `turbopanel-redis.service` with primary
  group **`turbopanelc`** (GID **9997**) and supplementary group
  **`turbopanel`** (GID 9999) (created by the `redis` role; self-sufficient —
  does not require `instance-user` to run first).
- Co-located dev checkouts (`daemon`, `turbopanel`, `ui`) are
  **`2770 turbopanel:turbopanel`** with default ACL **`g:turbopanel:rwx`** so
  files created by git, pnpm, or the editor remain group-writable. **Why default
  ACLs?** setgid propagates group ownership of new files but not the write bit —
  without a default ACL, files created by `turbopanel` (e.g. after `git pull`)
  are `640` and the dev user cannot write them. `dist`/release dirs are owned by
  `turbopaneli` and excluded from the dev-editable ACL. Clones and
  `pnpm install` run as **9999**; systemd services run as **9998**
  (`turbopaneli`). Per-service runtime state for the instance stack lives in
  **gitignored** checkout dirs: **`turbopanel/.local`** (instance + Caddy),
  **`ui/.local`** + **`ui/.expo`** (Expo), plus matching **`.config`** trees.
  The **daemon** (`9999`) keeps its own state under **`/opt/turbopanel`**
  (passwd `HOME`). The normalizer skips checkout
  `.cache`/`.config`/`.local`/`.expo` when reclaiming source files to
  `turbopanel` and re-applies default ACLs on the source tree; use
  `--prepare-reset` before Upgrade System `git reset` and
  `--ensure-runtime-dirs` after.
- **`acl` / `setfacl` is dev-only.** Production managed servers never install
  the `acl` package and never apply ACLs — production hosts should not natively
  enable ACL management. Co-located dev installs the package in
  `instance-dev-install.yml` `pre_tasks` (gated on `turbopanel_dev_user`) before
  `runtime-sockets` and `dev-permissions` apply ACLs. The turbopanel-dev console
  helpers (`tp_apply_dev_host_acls`, `tp_fix_deno_runtime_access`) fall back to
  `chmod` when `setfacl` is absent until the daemon installs `acl`.
- `/run/turbopanel` is `2770 turbopanel:turbopanel` (setgid) so `turbopaneli`
  can bind the socket; see `../turbopanel/AGENTS.md`.

## Documentation discipline

**Keep this file current.** When you learn something durable about managed
server daemons — install prerequisites, orchestration playbooks, connectivity,
slim-Debian gotchas — add or update a note here alongside code changes. Future
agents read `AGENTS.md` first.

- Prefer extending an existing section over orphan bullets.
- Record **why** when non-obvious (missing packages, ordering constraints,
  idempotency traps).
- Cross-link the instance repo (`../turbopanel/AGENTS.md`) for Caddy, `/ws/*`,
  and platform CA details.
- Do not record secrets, tokens, or machine-specific credentials.
- Remove or correct notes that prove wrong.

`README.md` is for humans installing nodes; `AGENTS.md` is for agents
maintaining the daemon.

## Instance connectivity

Two modes in `src/instance/paths.ts`:

| Mode     | When                                                   | Target                                                                                 |
| -------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `url`    | `TURBOPANEL_INSTANCE_URL` set (remote managed servers) | `https://<host>:<port>` / `wss://…/ws/daemon/v1` through Caddy                         |
| `socket` | No URL (co-located dev on the instance host)           | `unix:///run/turbopanel/instance.sock` (Tilt dev: `dev/.run/turbopanel/instance.sock`) |

Managed installs store the server id at
`/opt/turbopanel/platform/daemon/state/server.id` (`TURBOPANEL_DAEMON_STATE_DIR`
overrides the directory); local Tilt dev (`TURBOPANEL_SKIP_ORCHESTRATION=1`)
stores it as `./server.id` in the daemon checkout so the restricted dev
permissions can write it. The daemon dials **`/ws/daemon/v1`** and may read
`GET /api/daemon/v1/version` (informational only) and
`GET /api/daemon/v1/instance/ca`.

### Daemon key authentication

daemons authenticate with an Ed25519 keypair (WebCrypto, not SSH) using an
HTTP-first flow before opening the daemon WebSocket:

- **Enrollment (first run or `TURBOPANEL_FORCE_ENROLL=1`)**:
  `POST /api/daemon/v1/auth/challenge` (no credentials) then
  `POST /api/daemon/v1/enroll` (license + signed proof-of-possession). The
  daemon persists `server-key.json` (0600), `server.id`, and `server-key-id`
  (stores `server.daemon.key.id` returned by enrollment) under
  `TURBOPANEL_DAEMON_STATE_DIR`. The license token is never sent again after
  enrollment.
- **Auth/session (normal connects)**: `POST /api/daemon/v1/auth/challenge` with
  `{ serverId, keyId }`, sign `buildAuthPayload`, then
  `POST /api/daemon/v1/auth/session` for a 15-minute JWT. The instance verifies
  the Ed25519 signature against `server.daemon.key.publicJwk`.
- **WS upgrade**: daemon opens `/ws/daemon/v1` with
  `Authorization: Bearer <token>` (no post-upgrade handshake messages).

**Daemon Cell:** connection state, presence, snapshots, outbox, request records,
challenges, and event buffers are owned by the instance-side **Daemon Cell** —
not by in-process Maps. On self-hosted Deno the cell backend is Redis (Unix
socket `/run/turbopanel/redis.sock`, provisioned by the `redis` Ansible role).
On Cloudflare Workers it is a per-server SQLite-backed Durable Object. The
daemon client (`src/instance/client.ts`) is unaffected — it still dials
`/ws/daemon/v1` with `Authorization: Bearer <token>` and reconnects on `4401`.

- **Monitoring transport (new):** after a successful WS connection, the daemon sends monitoring envelopes over the WebSocket — a full `monitor.sync` immediately on (re)connect, then `monitor.heartbeat` at a **60s** cadence (host summary + changed resources since the last acked sequence), and `monitor.transition` for focused single-resource changes. The cell responds with `monitor.ack` (accepted sequence + optional `resyncNeeded`). The old 30s `POST /api/daemon/v1/heartbeat` hot path is **removed**; an HTTP fallback seam remains only when the WebSocket is unavailable.
- **Token lifecycle**: `DaemonTokenManager` stores JWTs in memory only and
  refreshes lazily when less than 60 seconds remain (or immediately after a
  `4401` close).
- **Token manager retry**: `DaemonTokenManager` retries a failed refresh once
  after a 2-second delay before throwing. Concurrent `getToken()` calls share a
  single in-flight refresh promise.
- **No daemon session table**: JWT is stateless. `jti` is for
  logging/correlation only and is not stored.

Canonical payload formats:

- `turbopanel-daemon-enroll-v1` (7 lines): `challengeId`, `nonce`, `licenseId`,
  `machineId`, `hostname`, `publicKeyFingerprint`.
- `turbopanel-daemon-auth-v1` (7 lines): `challengeId`, `nonce`, `serverId`,
  `keyId`, `machineId`, `hostname`.
- `buildCanonicalPayload` is deprecated and aliases `buildAuthPayload`.

The co-located socket path uses the same auth model — there is no
unauthenticated bypass. Never log the license token or private key material.

Install flow: official installer (separate CDN repo) →
`scripts/bootstrap-orchestration.ts` (compiled to `dist/turbopanel-bootstrap-orchestration`
for production installs — `ensureUv` → `ensurePython` →
`bootstrapOrchestrationRuntime`; installs uv, Python, and Ansible into the
**shared** `/opt/turbopanel/runtimes/{uv,python,ansible}` tree) →
`orchestration/playbooks/daemon-install.yml`. **Docker is NOT installed at base
install or routine converge** — a managed node may only ever run native web
services (apache/nginx/openlitespeed) and never need a container runtime. The
`docker` role (which also installs its own `iptables` networking prereq) is run
on demand once a node is assigned a container workload.

Daemon runtime is managed by systemd (`turbopanel-daemon.service`): `flock`
enforces a single process, `deno run` without `--watch`, and the official
installer / `daemon-install.yml` reconcile the unit on every run. **No
self-update** — `updater.ts` was removed. A `dev-sync` push (see below) is the
fast dev path; the developer upgrade button is the operator path.

## Ansible owns all installs (incl. co-located dev instance)

The daemon bootstraps uv/Python/ansible, then runs playbooks. Roles (in
`orchestration/roles/`):

| Role                                                                         | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `daemon-prereqs`                                                             | apt prerequisites (`xz-utils` for Node, `tar`, `unzip`, `pamtester`, Redis build deps)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `turbopanel-user` / `instance-user`                                          | the 9999 / 9998 (`turbopaneli`) users                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `runtime-sockets`                                                            | `/run/turbopanel` as `2770` setgid                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `deno-runtime` / `node-runtime` / `caddy`                                    | vendored runtimes under `runtimes/<tool>/<version>/` + `current` symlink for **instance** stack services; **no `/usr/local/bin` links** — all consumers resolve via `runtimes/<tool>/current`. The **daemon** runs as compiled `dist/turbopaneld` and does not install or require Deno.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `redis`                                                                      | Native Redis binary under `runtimes/redis/current`; dedicated **`turbopanelc`** system user (UID 9997, primary group **`turbopanelc`** GID 9997, supplementary **`turbopanel`**); Unix socket at `/run/turbopanel/redis.sock` (mode 0660, group `turbopanel`); **`port 0`** in `redis.conf` (socket-only, no TCP listener); sets **`vm.overcommit_memory=1`** via `/etc/sysctl.d/99-turbopanel-redis.conf` (silences Redis background-save warning on default Linux kernels)                                                                                                                                                                                                                                                                                                                                                               |
| `rabbitmq`                                                                   | RabbitMQ `4-management` in Docker container **`turbopanelq`**; data in named volume **`turbopanelq`**; attached to Docker network **`turbopanel`**; generated password in `/opt/turbopanel/platform/config/rabbitmq/.rabbitmq_pass`; broker config at **`rabbitmq.conf`** disables deprecated management metrics collection (management UI remains for queue/connection inspection); AMQP on `127.0.0.1:5672`; management UI on `127.0.0.1:15672`; **`turbopanel-rabbitmq.service`** wraps the container for systemd ordering                                                                                                                                                                                                                                                                                                              |
| `mailpit`                                                                    | Dev-only Mailpit in Docker container **`turbopanelmailpit`** on network **`turbopanel`**; web UI on `127.0.0.1:8025`, SMTP on `127.0.0.1:1025`; **`turbopanel-mailpit.service`** wraps the container (co-located dev converge only — not routed through Caddy)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `instance-dev-prereqs`                                                       | dev-only apt libs for React Native devtools (GTK/NSS/GBM stack; probes `*t64` renames on Debian 13+)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `instance-repo` / `ui-repo` / `website-repo`                                 | clone-if-missing checkouts (never force-reset), `pnpm install` (`website-repo` runs in Workers co-located dev only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `instance-build`                                                             | Compiles `src/deno.ts` → `dist/turbopanel-instance` single binary (when `turbopanel_instance_run_mode=compiled`); no-op in `source` mode                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `ui-build`                                                                   | Runs `pnpm export` → `ui/dist` (dev) or downloads CDN artifact (prod) when `turbopanel_ui_mode=static`; no-op in `dev` mode                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `instance-certs`                                                             | platform CA + leaf via the instance cert script                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `instance-launch`                                                            | `turbopanel-instance` / `turbopanel-caddy` / `turbopanel-ui` / `turbopanel-mailer` units (run as `turbopaneli:turbopanel`). Co-located dev also installs `turbopanel-website.service` (Next.js docs on port **19820**). Injects `TURBOPANEL_DATABASE_URL` into the instance unit (Unix-socket URL for Deno; TCP URL in `instance-workers.env` for Workers). **`turbopanel-ui` must invoke `node_modules/.bin/expo` directly** — `pnpm exec expo` runs an implicit install that prompts to purge `node_modules` (installed by `turbopanel` with a different `HOME`), which blocks Expo and yields Caddy 502s on restart. **`turbopanel-website` runs `next dev` as `turbopaneli`** — `normalize-dev-checkout.sh` skips `.next`; `platform-runtime-dirs.yml` pre-creates `.next` / `.source` as `turbopaneli:turbopanel` before first start. |
| `dev-permissions`                                                            | add invoking dev user to `turbopanel` and `docker` groups; apply setgid + default ACLs on checkouts (no-op on managed servers without dev user)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `dev-host-access`                                                            | Installs `/etc/sudoers.d/turbopanel-dev-console` (NOPASSWD rules for the dev user, Deno path `runtimes/deno/*/deno`); applies ACLs on the shared runtimes dir; wired into `instance-dev-install.yml` after `dev-permissions`. Supersedes the removed `dev-host-access.sh` console script.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `postgres`                                                                   | PostgreSQL 18 in Docker; data in named volume **`turbopaneldb`**, Unix socket at `/var/run/turbopanel/postgres`; attached to Docker network **`turbopanel`**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `docker` / `daemon-repo` / `daemon-config` / `daemon-logs` / `daemon-launch` | managed-server daemon provisioning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

- Co-located **dev** install: `orchestration/playbooks/instance-dev-install.yml`
  (single converge playbook), run by `initOrchestration()` when co-located
  (socket mode) **and** `TURBOPANEL_DEV_INSTANCE=1`. The
  [turbopanel-dev](https://github.com/turbopanel/turbopanel-dev) console
  (`./console` → **Start dev stack**) writes developer identity into the daemon
  `.env`, bootstraps orchestration, and installs `turbopanel-daemon.service`,
  which then installs the rest via Ansible. **Local Tilt dev**
  (`../dev/Tiltfile`) runs the daemon via `scripts/daemon-serve.sh` with
  `TURBOPANEL_SKIP_ORCHESTRATION=1` instead — Tilt already manages
  instance/Caddy/Postgres; Workers mode sets `TURBOPANEL_INSTANCE_URL` to Caddy
  HTTPS, Deno mode dials the dev socket dir. Dev converge includes Postgres via
  the shared `postgres` role (not the legacy `postgres-setup.yml` playbook). The
  Docker container always publishes a Unix socket; the instance and drizzle-kit
  connect via `TURBOPANEL_DATABASE_URL` (a Unix-socket postgres URL set by
  `instance-launch`; TCP port exposure is optional via `postgres_expose_port`,
  off in dev).

### Build modes

| Variable                       | Values                           | Effect                                                                                                                |
| ------------------------------ | -------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `turbopanel_instance_run_mode` | `source` (default) \| `compiled` | `source`: `deno run src/deno.ts` via systemd; `compiled`: single binary at `dist/turbopanel-instance`                 |
| `turbopanel_ui_mode`           | `dev` (default) \| `static`      | `dev`: Expo dev server via `turbopanel-ui.service`; `static`: Caddy serves `ui/dist`, `turbopanel-ui.service` stopped |
| `turbopanel_ui_artifact_url`   | empty (default) \| CDN URL       | empty: local `pnpm export`; non-empty: download tarball from CDN (production seam)                                    |

Toggle via the dev console **Switch to production build** / **Switch to dev
build** — persists `TURBOPANEL_UI_MODE` and `TURBOPANEL_INSTANCE_RUN_MODE` to
the daemon `.env`, then re-runs `instance-build-toggle.yml` (roles: `ui-build` →
`instance-build` → `instance-launch`).

## Orchestration

- Playbooks: `orchestration/playbooks/`
- Galaxy roles: `orchestration/requirements.yml` (pinned, installed into
  `orchestration/roles/`, gitignored)
- Docker: thin `roles/docker` wrapper around **`geerlingguy.docker`** (Debian
  Trixie/Raspbian). Skips install when Docker is already running but **always**
  adds `turbopanel` and the co-located dev user (`turbopanel_dev_user`) to the
  `docker` group (needed on co-located dev hosts where Docker predates the
  daemon).
- Bootstrap also runs on every daemon start (idempotent; failures are logged,
  daemon keeps running). `initOrchestration()` runs one convergence playbook per
  mode: `daemon-converge.yml` (daemon-only) or `instance-dev-install.yml`
  (co-located dev), gathering facts once and running shared roles without
  overlapping docker/redis/rabbitmq/postgres invocations. **Co-located dev
  restarts skip the full `instance-dev-install` playbook when a converge stamp
  matches** (`/opt/turbopanel/runtimes/ansible/dev-converge.stamp` — playbook +
  role trees + dev extra-vars); set `TURBOPANEL_FORCE_CONVERGE=1` to force a
  full converge. Explicit console actions (**Start dev stack**, repair) always
  run the playbook via `run-orchestration-action.ts`. Bootstrap stamps (under
  `/opt/turbopanel/runtimes/ansible/bootstrap.stamp`) skip redundant Galaxy
  installs and the localhost smoke test when pinned requirements are unchanged.
- **Shared orchestration runtime.** uv, Python, and Ansible are installed into
  `/opt/turbopanel/runtimes/{uv/<ver>/,python/,ansible/<ver>/}` with `current`
  symlinks — **not** inside the daemon checkout. The `orchestration/runtime/`
  directory no longer exists; `bootstrap-orchestration.sh` has been replaced by
  `scripts/bootstrap-orchestration.ts` (compiled to `dist/turbopanel-bootstrap-orchestration`
  in release artifacts). The Deno orchestration functions
  (`ensureUv`, `ensurePython`, `ensureAnsible`, `ensureGalaxyRoles` in
  `src/orchestration/`) are the single canonical installer for all three tools.
- **Structured Ansible output (`src/orchestration/ansible-events.ts`).** Daemon
  playbook runners in `src/orchestration/ansible.ts` go through
  `runLocalPlaybook(playbook, extraArgs, onEvent?)`, which calls
  `runPlaybookStreaming(ansiblePlaybookBin, args, { cwd, env, onEvent })` when
  `onEvent` is supplied; otherwise they use human-oriented stdout logging.
  `runPlaybookStreaming` spawns `ansible-playbook` with a JSONL stdout callback
  and emits typed events (`play-start`, `task-start`,
  `task-ok|changed|failed|skipped`, `recap`, `error`). The event types are
  exported from a stable path so the console can dynamically import the wrapper.
  A doc comment in the module marks the **API/WS streaming seam** where events
  will later be forwarded to the control surface.
- Logs are written to checkout `logs/` files when running under systemd: daemon
  `{daemon.log,daemon.err.log}` (`daemon-logs` role), co-located dev instance
  `{instance.log,instance.err.log}`, UI `{ui.log,ui.err.log}` in dev mode, and
  website `{website.log,website.err.log}` for the local Next.js docs dev server
  (`instance-launch` `instance-logs` / `ui-logs` / `website-logs` tasks).
  Directories are gitignored; no `tmpfiles.d` or logrotate entries are needed.
  The official installer runs daemon logs via `daemon-launch`, and
  `initOrchestration()` re-runs `daemon-logs-setup.yml` on every daemon start so
  existing daemons pick it up without a full reinstall.

### Runtime (systemd + Tilt)

Managed server daemons and co-located dev hosts run
**`turbopanel-daemon.service`** (systemd). The official installer /
`daemon-install.yml` install the unit; co-located instance hosts use
`scripts/install-daemon-systemd.sh` (which also ensures the user, prereqs, and
Deno so a fresh dev host is self-sufficient). **Local Tilt dev** runs the same
process from `../dev/scripts/daemon-serve.sh` (Tilt `daemon` resource) with
`TURBOPANEL_SKIP_ORCHESTRATION=1` so Ansible bootstrap is skipped.
`scripts/ensure-single-daemon.sh` (ExecStartPre) ensures `/run/turbopanel`
exists with correct permissions and clears any stale `daemon.lock` left by an
unclean shutdown.

### Services

| Unit / container              | Purpose                                                                                  | Ordering                                              |
| ----------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `turbopanel-redis.service`    | Redis Unix socket at `/run/turbopanel/redis.sock` (runs as **`turbopanelc:turbopanel`**) | After `network.target`                                |
| `turbopanel-rabbitmq.service` | RabbitMQ Docker container (AMQP + management UI on loopback)                             | After `docker.service`                                |
| `turbopanel-mailpit.service`  | Mailpit Docker container (dev email UI + SMTP on loopback)                               | After `docker.service`                                |
| `turbopanel-mailer.service`   | RabbitMQ email consumer → SMTP                                                           | After `turbopanel-instance` and `turbopanel-rabbitmq` |

### Dev sync & instance tunnel (WS messages)

- **Dev sync**: the instance streams a tarball of `../daemon` as
  `dev-sync-begin`/`dev-sync-chunk`/`dev-sync-end`; the daemon
  (`src/dev-sync-apply.ts`) unpacks over its checkout (excluding `.git`,
  `orchestration/roles`, `cloudflared/tunnels`, `node_modules`), runs
  `deno cache`, replies `dev-sync-result`, then `systemctl restart`s.
- **Instance tunnel**: a `tunnel-token` message makes the co-located daemon
  write `cloudflared/tunnels/instance.token` and (re)launch the supervisor in
  `src/tunnels.ts` (`writeInstanceTunnelToken`), exposing the instance to
  external nodes.
- Both reply with a result message the instance correlates by id.

### Release artifacts (zstd tar)

Cross-arch daemon binaries ship as **zstd-compressed tar** (`.tar.zst`) — small
on the wire, native on Debian via the `zstd` package (`daemon-prereqs` and
`install.sh` apt).

| Task | Purpose |
| ---- | ------- |
| `deno task compile:all` | `dist/turbopaneld-linux-{amd64,arm64}` + `.tar.zst` packages |
| `deno task release:package` | same as `compile:all` (compile + zstd tar) |

Each archive contains a single `turbopaneld` member at the tar root (installed
as `./turbopaneld` in the daemon checkout). Co-located dev serves unversioned
names from `/downloads/daemon/`:

- `turbopaneld-linux-amd64.tar.zst`
- `turbopaneld-linux-arm64.tar.zst`

Versioned GitHub release assets (set `TURBOPANEL_RELEASE_VERSION` when
packaging, or `TURBOPANEL_DAEMON_RELEASE_VERSION` when downloading):

- `turbopaneld-<version>-linux-amd64.tar.zst`
- `turbopaneld-<version>-linux-arm64.tar.zst`

Naming and fetch/extract helpers live in
`scripts/lib/release-artifacts.sh` (used by `run.sh`, `update.sh`, the CDN
`install.sh`, and the packager). The dev bootstrap **`run.sh`** is the single
entrypoint: it exports `TURBOPANEL_DAEMON_BINARY_URL` (`--binary-url`), downloads
and extracts `turbopaneld` into the daemon runtimes tree, then runs
`daemon-install.yml`. There is no separate `install.sh` in this repo — the
daemon provisions everything else (instance/Caddy/UI/Docker-on-demand) via
Ansible after it starts.

### Slim Debian prerequisites

Minimal Debian images often lack packages full installs have. Daemon bootstrap
and `roles/daemon-prereqs` must include anything Ansible/Docker need before
playbooks run:

| Package           | Why                                          |
| ----------------- | -------------------------------------------- |
| `unzip`           | Deno install script                          |
| `xz-utils`        | Node tarball extraction (`tar -J`)           |
| `tar`             | dev-sync archive + runtime extraction        |
| `zstd`            | daemon release `.tar.zst` download/extract   |
| `gnupg`           | Legacy apt paths; still useful on slim hosts |
| `python3-debian`  | `deb822_repository` in `geerlingguy.docker`  |
| `iptables`        | Docker networking — installed by the `docker` role on demand, NOT `daemon-prereqs` |
| `build-essential` | Redis compile (`make`, `gcc`)                |
| `libssl-dev`      | Redis TLS/OpenSSL headers at compile time    |
| `pkg-config`      | Redis build dependency resolution            |

Co-located dev (`instance-dev-prereqs` role, not `daemon-prereqs`) installs the
Chromium/GTK runtime stack (`libatk*`, `libnss3`, `libgbm1`, `libgtk-3-0`, …) so
`@react-native/debugger-shell` passes its `--version` prep check. Debian 13+
`*t64` renames are probed at install time. A headless server may still log
DISPLAY warnings when opening the GUI debugger; that is separate from the
shared-library install.

## Layout

- `main.ts` — entry; orchestration bootstrap, tunnels, instance client (no
  self-update)
- `run.sh` — the single dev bootstrap entrypoint (served at `/run.sh` by Caddy
  in co-located dev): installs prereqs + Deno, clones the checkout, drops in the
  released `turbopaneld`, bootstraps orchestration, and runs `daemon-install.yml`.
  No companion `install.sh` — the daemon does the rest via Ansible. The official
  production node installer lives in
  [turbopanel/turbopanel-cdn](https://github.com/turbopanel/turbopanel-cdn) (see
  `README.md` for the curl workflow)
- `src/instance/client.ts` — WSS client; HTTP-first enrollment/session
  bootstrap + command/address + dev-sync/tunnel-token handlers
- `src/instance/api-client.ts` — HTTP API client for daemon auth/enroll/session
  endpoints
- `src/instance/token-manager.ts` — in-memory daemon JWT manager with lazy
  refresh
- `src/instance/enroll.ts` — enrollment flow (`auth/challenge` → keypair/sign →
  `enroll` → persist identity)
- `src/monitor/` — monitoring sentinel: `sentinel.ts` (orchestrator), `host-summary.ts` (cpu/memory/disk/load collector), `normalize.ts` (container → `MonitorResourceState`), `delta.ts` (sequence tracking + delta generation), `protocol.ts` (shared wire contracts mirroring the instance repo), `source.ts` (DockerMonitor adapter interface).
- `src/crypto/keys.ts` — Ed25519 keypair generation, fingerprinting, canonical
  payload, sign/verify, key file load/save
- `src/dev-sync-apply.ts` — unpack + cache a synced daemon build
- `src/tunnels.ts` — cloudflared supervisor + `writeInstanceTunnelToken`
- `src/orchestration/` — uv/Python/ansible bootstrap, playbook runners (incl.
  `runInstanceDevInstall`)
- `orchestration/playbooks/instance-dev-install.yml` — co-located dev
  instance/UI/Caddy install
- `orchestration/roles/{instance-user,instance-dev-prereqs,node-runtime,caddy,instance-repo,ui-repo,instance-certs,instance-launch}`
  — instance-side install roles
- `orchestration/roles/daemon-launch/templates/turbopanel-daemon.service.j2` —
  daemon systemd unit template
- `scripts/package-daemon-release.sh` — zstd tar release packager;
  `scripts/lib/release-artifacts.sh` — shared naming + fetch helpers
- `scripts/install-daemon-systemd.sh` — install `turbopanel-daemon.service` on
  co-located dev (after `turbopanel-instance.service`)
- `scripts/bootstrap-orchestration.ts` — thin entry compiled to
  `dist/turbopanel-bootstrap-orchestration`; runs `ensureUv` →
  `ensurePython` → `bootstrapOrchestrationRuntime`; used by `run.sh` and the
  dev console (host Deno fallback when the compiled binary is absent).
