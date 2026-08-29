# ProxySQL role (`proxysql`) — AGENTS.md

Ansible role for TurboPanel orchestration. Shared conventions: `../../AGENTS.md`.

Shared **managed-database ingress** on every host that will run managed
engines. Host prerequisites only — **not** a full stack bring-up of compose
content. Meta-depends on the `docker` role. Standalone playbook:
`playbooks/proxysql-setup.yml` (invoked by daemon `runProxySqlSetup` after
`ensureGalaxyDockerRole`, including **lazily from `managed.ingress.reconcile`**
when host `admin.cnf` is missing). Co-located dev also installs the role via
`instance-dev-install` / `dev-converge-manifest.json` (after `system-compose`).

**Docker bind-mount scars:** if `admin.cnf` or `proxysql.cnf` were missing when
the daemon first ran `compose up`, Docker creates empty **directories** at those
paths. The role removes directory scars before seeding files; shell creation
requires a real non-empty regular file (`-f` + `-s`), not merely `test -s`
(which stays false for empty dirs but also never recreates a non-empty dir).
The daemon refuses compose up / config write while those paths are directories.

**Division of labour**

| Owner | Responsibility |
| --- | --- |
| Ansible (`proxysql` role) | Config dir `0750` root:`turbopanel_group`, `tls/` subdir, state data dir + first-run alpine `chown` to `999:999`, one-shot `admin.cnf` mode `0600`, initial static `proxysql.cnf` **only when absent** (`force: no`), `wait-ready.sh`, `turbopanel-proxysql-stack.service`. **Never** the managed Docker network and **never** the compose project name — both are per-organization identifiers the control plane allocates and Ansible cannot know at converge time. The `proxysql_managed_network` default var and the unit's `ExecStartPre … docker network create` are **gone**; do not reintroduce either |
| Daemon (`src/managed/proxysql.ts`, `managed.ingress.reconcile`) | Write/update `docker-compose.yml`, regenerate full durable `proxysql.cnf` (static listeners + users/servers/rules), materialize TLS PEMs under `tls/`, admin runtime apply, compose up/restart |
| Systemd unit | `Type=oneshot` `RemainAfterExit`; **if compose file exists** → `docker compose -f <configDir>/docker-compose.yml up -d --remove-orphans` + wait-ready; **if compose not yet written** → no-op success (pre-reconcile hosts stay healthy after converge). No `-p` and no templated project var: the project is the allocated `managed-ingress` `serviceId`, which the daemon writes into the compose file's own top-level `name:` key |

**Paths**

| Path | Mode / owner | Purpose |
| --- | --- | --- |
| `/etc/turbopanel/proxysql/` | `0750` root:group | Config root (`proxysql_config_dir`) |
| `…/tls/` | `0750` root:group | Org-CA leaf + CA for frontend TLS (daemon writes PEMs) |
| `…/admin.cnf` | `0600` root:group | mysql-client-style `[client]` admin user/password (like postgres `.pgpass`) |
| `…/proxysql.cnf` | `0640` root:group | Cold-start config (Ansible seeds static globals once; daemon owns thereafter) |
| `…/wait-ready.sh` | `0750` root:root | Probe admin `127.0.0.1:6032` after compose up |
| `…/docker-compose.yml` | daemon `0640` | **Not** written by Ansible |
| `/var/lib/turbopanel/proxysql/` | pre-owned `999:999` | Host-side data tree marker / optional bind target |
| Managed network (bare-UUID per-org name from `network(kind='managed')`) | bridge | Engines + ProxySQL (never the tenant hosting-ingress network). **Not a path this role owns** — the name is allocated per organization by the control plane, is unknown at converge time, and the daemon creates it on reconcile and re-creates it on `system.reconcile` self-heal (recovered from the on-disk compose file). See `../src/managed/AGENTS.md` → **Managed network self-heal** |
| Unit `turbopanel-proxysql-stack.service` | `0640` | Reboot durability once compose exists |

**Why the config dir keeps a branded path.** `/etc/turbopanel/proxysql/` (and
`/etc/turbopanel/orchestrator/` below) stayed put while the Docker
network/project identifiers went bare-UUID, and that is deliberate: Ansible
seeds `admin.cnf` / `monitor.cnf` / `proxysql.cnf` (and `api.cnf` / `raft.cnf`)
on a **fresh host, before any service UUID exists**, so a UUID-named directory
is simply not knowable at converge time. A filesystem path under the
already-branded `/etc/turbopanel` tree is also not a Docker-visible identifier —
nothing enumerating containers, networks, or compose projects on the host ever
sees it. Same reasoning for the `turbopanel-*-stack.service` unit names.

**Image pin:** `proxysql_image: proxysql/proxysql:3.0.9`. Must not be loosened
without reviewing **CVE-2026-48773** (pre-auth first-packet heap overflow) and
**CVE-2026-48772** (PROXY-protocol-v1 `client_addr` ACL bypass); both fixed in
3.0.9. Keep in step with daemon `PROXYSQL_IMAGE` in `src/managed/proxysql.ts`.

**Ports (defaults):** admin `6032` (loopback), pgsql frontend `15432`, mysql
frontend `13306`. These published frontend ports are reserved against tenant
raw TCP hostings (`PROXYSQL_RESERVED_PUBLISHED_PORTS`).

**Installer vocabulary:** component/status token `proxysql` → **ingress** (see
`src/orchestration/presentation.ts`).

