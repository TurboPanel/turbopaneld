# AGENTS.md

Agent-node daemon: connects to a TurboPanel **instance** over WSS, runs local orchestration (Ansible, Docker, Cloudflare tunnels), and self-updates to match the instance's `trunk` commit.

## Documentation discipline

**Keep this file current.** When you learn something durable about agent nodes — install prerequisites, orchestration playbooks, connectivity, slim-Debian gotchas — add or update a note here alongside code changes. Future agents read `AGENTS.md` first.

- Prefer extending an existing section over orphan bullets.
- Record **why** when non-obvious (missing packages, ordering constraints, idempotency traps).
- Cross-link the instance repo (`../turbopanel/AGENTS.md`) for Caddy, `/ws`, and platform CA details.
- Do not record secrets, tokens, or machine-specific credentials.
- Remove or correct notes that prove wrong.

`README.md` is for humans installing nodes; `AGENTS.md` is for agents maintaining the daemon.

## Instance connectivity

Two modes in `src/instance/paths.ts`:

| Mode | When | Target |
|---|---|---|
| `url` | `TURBOPANEL_INSTANCE_URL` set (installed agents) | `https://<host>:<port>` / `wss://…/ws` through Caddy |
| `socket` | No URL (co-located dev on the instance host) | `unix:///run/turbopanel/turbopanel.sock` |

On connect the daemon sends a `hello` with `hostname` (`Deno.hostname()`) and `nodeId` (`/etc/machine-id`). The instance uses these (and `X-Real-IP` from Caddy) to dedupe reconnects.

Install flow: `install.sh` → `scripts/bootstrap-orchestration.sh` (uv, Python, ansible, **Galaxy roles**) → `orchestration/playbooks/agent-install.yml`. Docker is installed in that playbook and again at daemon startup via `initOrchestration()` in `src/orchestration/setup.ts`.

Daemon runtime is managed by systemd (`turbopanel-daemon.service`): `flock` enforces a single process, `deno run` without `--watch`, and `install.sh` / `agent-install.yml` reconcile the unit on every run. Self-updates run `git reset` then `systemctl restart turbopanel-daemon`.

## Orchestration

- Playbooks: `orchestration/playbooks/`
- Galaxy roles: `orchestration/requirements.yml` (pinned, installed into `orchestration/roles/`, gitignored)
- Docker: thin `roles/docker` wrapper around **`geerlingguy.docker`** (Debian Trixie/Raspbian)
- Bootstrap also runs on every daemon start (idempotent; failures are logged, daemon keeps running)
- Logs are written to both journald and `/var/log/turbopanel/daemon/{daemon.log,daemon.err.log}` when running under systemd (`StandardOutput`/`StandardError` in the unit template). Logrotate policy lives at `/etc/logrotate.d/turbopanel-daemon` (daily, 14 rotations, compress). The log directory is recreated on boot via `/etc/tmpfiles.d/turbopanel-daemon-logs.conf`. The `daemon-logs` role provisions all of this; `install.sh` runs it via `daemon-launch`, and `initOrchestration()` re-runs `daemon-logs-setup.yml` on every daemon start so existing agents pick it up without a full reinstall.

### Runtime (systemd only)

Agent nodes and co-located dev hosts run **`turbopanel-daemon.service`** — there is no Tilt entrypoint in this repo. `install.sh` / `agent-install.yml` install the unit; co-located instance hosts use `scripts/install-daemon-systemd.sh`. The `daemon-launch` role runs `tilt down` if Tilt was previously used, so a leftover Tilt process cannot fight systemd over `/ws`.

### Slim Debian prerequisites

Minimal Debian images often lack packages full installs have. Agent bootstrap and `roles/agent-prereqs` must include anything Ansible/Docker need before playbooks run:

| Package | Why |
|---|---|
| `unzip` | Deno install script |
| `gnupg` | Legacy apt paths; still useful on slim hosts |
| `python3-debian` | `deb822_repository` in `geerlingguy.docker` |
| `iptables` | Docker networking |

## Layout

- `main.ts` — entry; orchestration bootstrap, tunnels, instance client
- `install.sh` — root bootstrap + `agent-install` playbook
- `src/instance/client.ts` — WSS client, command/address handlers
- `src/orchestration/` — uv/Python/ansible bootstrap, playbook runners
- `orchestration/roles/daemon-launch/templates/turbopanel-daemon.service.j2` — systemd unit template
- `scripts/install-daemon-systemd.sh` — install `turbopanel-daemon.service` on co-located dev (after `turbopanel-instance.service`)
