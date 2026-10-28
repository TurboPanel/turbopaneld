# AGENTS.md

TurboPanel **daemon** — Ansible-driven host daemon; connects to the instance over
HTTPS/WSS (or Unix socket when co-located).

## Releases

How changes ship: squash-merge into `trunk`, then two bot-opened pull requests (`trunk` to `staging`, `staging` to `live`) that a maintainer merges with merge commits. Hotfixes land on `trunk` first, and the daemon ships before the control plane. See [How changes ship](https://github.com/TurboPanel/.github/blob/trunk/CONTRIBUTING.md#how-changes-ship) and [How to ship](https://turbopanel.io/docs/development/how-to-ship).

## Documentation discipline

**Keep this file current.** When you learn something durable about daemon ↔
instance contracts — WS presence, reconnect behavior, command handlers,
orchestration — add or update a note here in the same PR/session as the code
change. Cross-repo cell/cost rules live in `../turbopanel/AGENTS.md` (Daemon Cell
section); link there instead of duplicating DO hibernation detail.

## Project metadata

GitHub repository:
[TurboPanel/turbopaneld](https://github.com/TurboPanel/turbopaneld). Deno
package name: `turbopaneld` (`deno.json`), aligned with the repo slug and the
compiled `/opt/turbopanel/bin/turbopaneld` binary.

**Public naming:** **TurboPanel Daemon** → [TurboPanel/turbopaneld](https://github.com/TurboPanel/turbopaneld); internal term `daemon`. **License:** AGPL-3.0-only ([`LICENSE`](./LICENSE), `deno.json`). Trademarks are not granted by the software license ([`TRADEMARKS.md`](./TRADEMARKS.md)). Third-party components keep their own licenses ([`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)); release packaging stages that file at `opt/turbopanel/share/THIRD_PARTY_NOTICES.md`. Published story: `../website` `/open-source` and `docs/getting-started/licensing.mdx`. Contributions require the [CLA](https://github.com/TurboPanel/.github/blob/trunk/CLA.md). **Maturity:** **Private alpha**. README is product-facing; AGENTS.md is maintainer-facing.

## Host facts & command handlers

Moved to `src/host/AGENTS.md` — host OS, time sync, docker, machine key, and
runtime inventory probes.

## Subsystem docs (nested `AGENTS.md`)

Large subsystems live in focused `AGENTS.md` files next to their code. **Read the matching file before editing that area.** This root keeps the foundational path model + conventions; the detail moved to:

| Subsystem | Read before editing | Covers |
|---|---|---|
| **Command handlers** | `src/commands/AGENTS.md` | Daemon command implementations (`command-router.ts`); injected into `InstanceClient` from `src/entry/run.ts` so transport never imports handlers |
| **Instance client** | `src/instance/AGENTS.md` | WSS / Unix-socket connection, idle presence + heartbeats (`timeSync`/`ips`/`docker`), reconnect / parked backoff, JWKS JWT verification, daemon TLS trust model |
| **Host metrics (collector)** | `src/metrics/AGENTS.md` | `/proc`-based collection + scheduling, `POST /api/daemon/v1/metrics`, schema v3 four-part contract (`core`/`extended`/`sensors`/`traffic`), sensor discovery, live-mode leases |
| **Tenant deploy & hosting ingress** | `src/deploy/AGENTS.md` | `environment.deploy` / `.lifecycle` / `.stop`, Docker Compose + Traefik, hosting Caddy, TLS materialization. Nested per-area docs: `src/deploy/release/AGENTS.md` (git-backed releases), `src/deploy/native/AGENTS.md` (host-run Node/Next), `src/deploy/site/AGENTS.md` (nginx/Apache/OLS sites), `src/deploy/cron/AGENTS.md` (scheduled jobs), `src/deploy/ssh/AGENTS.md` (tenant SSH) |
| **Command execution logs** | `src/logs/` | Streamed command transcripts: redaction deny-set, `<stateDir>/spool/execution-logs/` spool, batched upload to `POST /api/daemon/v1/commands/:commandId/log`, orphan sweep. Control-plane side: `../turbopanel/src/features/execution-logs/AGENTS.md`; capture details in `src/deploy/AGENTS.md` (Streamed transcript capture). This is the **only** log class uploaded and retained. |
| **Managed engines (daemon runtime)** | `src/managed/AGENTS.md` | `managed.apply` / `.lifecycle` / `.destroy`, `managed.ingress.reconcile` (shared ProxySQL — compose project = the `managed-ingress` `serviceId` — on the organization's managed network, a bare-UUID name carried as `managedNetwork` on the command), engine registry (Postgres first); separate from tenant deploy. On-demand tails ride the same correlated cell round trip as `managed-logs-request` / `managed-logs-result`: engine `compose logs`, and running-container `docker container logs`. Neither is stored or collected; presence does not carry `containerLogsEnabled`. |
| **Installer presentation** | `src/orchestration/AGENTS.md` | Installer presenter + sanitizer / vocabulary map for `run.sh` install & converge |
| **Installer script hosting** | this file → *Installer script hosting* | **turbopanel.sh** = a redirect (served outside this repo) to `scripts/run.sh` on `live`; dev overlay catalog notes |
| **Host facts** | `src/host/AGENTS.md` | Host OS, time sync, docker, machine key, runtime inventory probes (hello + change-detected heartbeats) |
| **Time sync (Ansible)** | `orchestration/AGENTS.md` | `time-sync` role + `time-sync-apply.yml` (NTP / timezone) |

Ansible playbooks/roles live under `orchestration/`; runtime TypeScript under `src/`.

