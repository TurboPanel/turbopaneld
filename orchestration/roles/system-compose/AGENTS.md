# System services Compose stack (`system-compose`) — AGENTS.md

Ansible role for TurboPanel orchestration. Shared conventions: `../../AGENTS.md`.

Postgres, RabbitMQ, and ClickHouse run as **one Docker Compose project**,
**`turbopanel-system`** (`docker-compose.yml` at
`/etc/turbopanel/system/docker-compose.yml`, services `database` / `queue` /
`analytics`), brought up by a single `Type=oneshot` systemd unit —
**`turbopanel-system-stack.service`** — instead of three independent
`docker run` containers each with its own unit. **Role split:** the `postgres` / `rabbitmq` / `clickhouse` roles are now
**config-only** — user/group provisioning, secret generation
(`.pgpass` / `.rabbitmq_pass` / `.clickhouse_admin_pass` +
`.clickhouse_app_pass`), `config.json`, and (for ClickHouse) the
`config.xml`/`users.xml` `config.d`/`users.d` overlays. None of them run
`docker`/`docker inspect`/`docker run`, install a per-service systemd unit, or
install a wrapper-start script anymore. The **`system-compose`** role (meta
`docker` dependency) runs *after* whichever of those three roles ran in the
same play and:

1. Slurps each service's password file directly (`.pgpass` / `.rabbitmq_pass`
   / `.clickhouse_admin_pass`) — it does not depend on facts set by the prior
   roles, so it stays idempotent/self-sufficient across separate playbook runs.
2. A service block only renders when its secret file exists, so the role
   degrades gracefully when only a subset of the three roles ran in this play
   (see the standalone `postgres-setup.yml` / `rabbitmq-setup.yml` /
   `clickhouse-setup.yml` playbooks, which each add `system-compose` after
   their one role). `queue` / `analytics` are additionally omitted on Workers
   runtime (`turbopanel_instance_runtime == 'workers'` — Mailgun / Cloudflare
   Analytics Engine replace them).
3. Ensures the `turbopanel` Docker network + the active named volumes exist,
   pre-owns volume data directories on the very first run (before Compose
   takes ownership), and force-removes any pre-existing non-Compose container
   with a conflicting name (migration path from the old per-service `docker
   run` containers — container names are unchanged: `turbopanel-database` /
   `turbopanel-queue` / `turbopanel-analytics`).
4. Templates `docker-compose.yml` (mode `0640`, owner `root:{{
   turbopanel_group }}`) and a `wait-ready.sh` readiness script, installs
   `turbopanel-system-stack.service`, and starts the new unit.
5. `docker compose -p turbopanel-system … up -d --remove-orphans` — the
   `--remove-orphans` flag is what tears down `queue`/`analytics` containers
   when a converge switches to Workers runtime (no per-runtime "stop and
   disable" systemd task needed in `instance-launch`).
6. Restarts (targeted `docker restart`, not `--force-recreate`) just the
   `queue` or `analytics` container when the `rabbitmq`/`clickhouse` roles'
   config-overlay `template` tasks reported `changed` earlier in the play
   (`docker compose up -d` alone does not notice a bind-mounted file's
   *content* changing), then re-waits for readiness on that container.
7. Once ClickHouse is up (first run or after a config-triggered restart),
   `include_role: clickhouse, tasks_from: bootstrap` runs the post-ready SQL
   bootstrap (see below) — it needs a running container, so it cannot happen
   inside the trimmed `clickhouse` role itself.

**Labels:** every service in the Compose file carries **only**
`com.turbopanel.system.component: <database|queue|analytics>` and
`turbopanel.role: turbopanel` — never `com.turbopanel.service`, `traefik.enable`, or
`com.turbopanel.raw-port` (those identify *tenant* deploy containers; see
`../src/deploy/system-component.ts` / `../src/deploy/labels.ts`).

| Path / resource                                                                | Purpose                                                                                                                                                                                       |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/etc/turbopanel/system/docker-compose.yml`                                     | The `turbopanel-system` Compose project (services `database`/`queue`/`analytics`)                                                                                                              |
| `/etc/turbopanel/system/wait-ready.sh`                                          | Readiness script (`pg_isready` / `rabbitmq-diagnostics -q ping` / `curl .../ping` via `docker exec`), run as a second `ExecStart` so the oneshot unit blocks until services actually answer     |
| `turbopanel-system-stack.service`                                               | `Type=oneshot`, `RemainAfterExit=yes`; `ExecStart` = compose `up -d --remove-orphans` then `wait-ready.sh`; `ExecStop` = compose `down`                                                        |
| Containers `turbopanel-database` / `turbopanel-queue` / `turbopanel-analytics`  | Unchanged names/volumes from the old per-service containers — Compose adopts them (old non-Compose containers with the same name are force-removed on first run)                              |

Dependent units (`turbopanel-instance.service`, `turbopanel-dbstudio.service`,
`turbopanel-mailer.service`, `turbopanel-tabix.service`) declare
`After=`/`Wants=`/`Requires=turbopanel-system-stack.service`.

**Converge order:** `postgres` → `rabbitmq` → `clickhouse` (config only) →
`system-compose` (brings the stack up, then runs the ClickHouse bootstrap
internally) → `tabix`. Standalone single-service playbooks
(`postgres-setup.yml` / `rabbitmq-setup.yml` / `clickhouse-setup.yml`) each run
their one config role followed by `system-compose`.

**`turbopanel-system` is inspect-only from the daemon's side** — this role (and
its readiness/restart-on-config-change logic above) is the *only* thing that
brings the stack up or restarts a service in it. `system.reconcile` never
calls `docker compose up`/`restart` for `database`/`queue`/`analytics` (see
`../src/deploy/AGENTS.md` → "Shared HTTP ingress identity", fourth table row).
Caddy (control-plane + hosting), Redis, the control-plane instance, and
`turbopaneld` itself stay **host-native** and are never part of this or any
other Compose project — they have no `container` row, and their health/restart
surface is the server **Control** tab / system-component control API on the
instance, not a container table. Rationale for why those four stay host-native
(PAM, `systemctl`/`git` update access, socket uid/gid, unix-socket
permissions) is canonical in `../../turbopanel/AGENTS.md` → "Self-host system
inventory" — do not duplicate it here.

