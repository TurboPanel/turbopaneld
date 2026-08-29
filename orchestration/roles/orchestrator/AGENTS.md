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
| Ansible (`orchestrator` role) | Config/tls/data dirs `0770`, `api.cnf` + `raft.cnf` mode `0600` owned by `turbopanel_user`, `wait-ready.sh`, `turbopanel-orchestrator-stack.service`. **Never** the managed Docker network and **never** the compose project name — same per-organization/per-service identifiers the role cannot know at converge time; the daemon creates and heals the network. Config dirs keep their `/etc/turbopanel/orchestrator/` path for the reason given under ProxySQL → **Paths** |
| Daemon (`src/managed/orchestrator.ts`, `managed.ha.reconcile`) | Write `docker-compose.yml` + `orchestrator.conf.json` (`Recover: false`, empty `RecoverMasterClusterFilters`), HTTP loopback `127.0.0.1:33001:33001`, Raft published on advertise address only (`33002`) |
| Systemd unit | `Type=oneshot` `RemainAfterExit`; **if compose file exists** → `docker compose -f <configDir>/docker-compose.yml up -d --remove-orphans` + wait-ready; **if compose not yet written** → no-op success. No `-p`: the project is the allocated `managed-ha` `serviceId`, carried by the compose file's own `name:` key |

**Image pin:** `ghcr.io/proxysql/orchestrator:v4.30.2`. Internal ports **33001**
(HTTP) / **33002** (Raft). Never publish `0.0.0.0`. Avoid 6032/6132/45000–45999
(and 15432/13306). Servers that host only remote `read`/DR replicas do not join
Raft.

**Installer vocabulary:** component/status token `orchestrator` → **HA**.

