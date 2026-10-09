# Orchestrator role (`orchestrator`) — AGENTS.md

Ansible role for TurboPanel orchestration. Shared conventions: `../../AGENTS.md`.

Host prerequisites for the **per-organization** Orchestrator Raft group
(`managed-ha`). Host prep only — **not** a full stack bring-up of compose
content. Meta-depends on the `docker` role. Standalone playbook:
`playbooks/orchestrator-setup.yml` (invoked by daemon `runOrchestratorSetup`
after `ensureGalaxyDockerRole`). Co-located dev installs the role via
`instance-dev-install` / `dev-converge-manifest.json` (after `proxysql`).

**Division of labour**

| Owner | Responsibility |
| --- | --- |
| Ansible (`orchestrator` role) | Config/tls/data dirs `0770`, `<install root>/libexec/orchestrator-wait-ready.sh` (root-only; the unit runs it as root), `turbopanel-orchestrator-stack.service`. **`api.cnf` / `raft.cnf` are org-wide secrets** — the control plane derives them and `managed.ha.reconcile` writes mode `0600` files under `orchestrator_config_dir`. **Never** the managed Docker network and **never** the compose project name — same per-organization/per-service identifiers the role cannot know at converge time; the daemon creates and heals the network. Config dirs keep their `/etc/turbopanel/orchestrator/` path for the reason given under ProxySQL → **Paths** |
| Daemon (`src/managed/orchestrator.ts`, `managed.ha.reconcile`) | Write `docker-compose.yml` + `orchestrator.conf.json` (`Recover: false`, empty `RecoverMasterClusterFilters`, `MySQLTopologyUseSSL` with Organization CA when present), HTTP published on loopback **and** the Raft advertise address (`33001`; followers proxy to `HTTPAdvertise`), Raft on advertise only (`33002`), `restart: always`; the service `group_add`s the gid owning the daemon-written conf (the image runs as uid 1001 and the conf/CA are `tp:tp` 0640); after `up` a crash-looping container fails the reconcile with its last log line (`src/managed/container-stability.ts`) |
| Systemd unit | `Type=oneshot` `RemainAfterExit`; **if compose file exists** → `docker compose -f <configDir>/docker-compose.yml up -d --remove-orphans` + wait-ready; **if compose not yet written** → no-op success. No `-p`: the project is the allocated `managed-ha` `serviceId`, carried by the compose file's own `name:` key |

**Image pin:** `ghcr.io/proxysql/orchestrator:v4.30.2`. Internal ports **33001**
(HTTP) / **33002** (Raft). Never publish `0.0.0.0`. Avoid 6032/6132/45000–45999
(and 15432/13306). Servers that host only remote `read`/DR replicas do not join
Raft.

**Installer vocabulary:** component/status token `orchestrator` → **HA**.

