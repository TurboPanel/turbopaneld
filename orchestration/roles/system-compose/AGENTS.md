# System services Compose stack (`system-compose`) — AGENTS.md

Ansible role for TurboPanel orchestration. Shared conventions: `../../AGENTS.md`.

Postgres and RabbitMQ run as **one Docker Compose project**,
**`turbopanel-system`** (`docker-compose.yml` at
`/etc/turbopanel/system/docker-compose.yml`, services `database` / `queue`),
brought up by a single `Type=oneshot` systemd unit —
**`turbopanel-system-stack.service`** — instead of independent
`docker run` containers each with its own unit. **Role split:** the `postgres` / `rabbitmq` roles are now
**config-only** — user/group provisioning, secret generation
(`.pgpass` / `.rabbitmq_pass`), and `config.json`. Neither of them runs
`docker`/`docker inspect`/`docker run`, installs a per-service systemd unit, or
installs a wrapper-start script anymore. The **`system-compose`** role (meta
`docker` dependency) runs *after* whichever of those roles ran in the
same play and:

1. Slurps each service's password file directly (`.pgpass` / `.rabbitmq_pass`)
   — it does not depend on facts set by the prior roles, so it stays
   idempotent/self-sufficient across separate playbook runs.
2. A service block only renders when its secret file exists, so the role
   degrades gracefully when only a subset of the roles ran in this play
   (see the standalone `postgres-setup.yml` / `rabbitmq-setup.yml`
   playbooks, which each add `system-compose` after their one role).
   `queue` is additionally omitted on Workers runtime
   (`turbopanel_instance_runtime == 'workers'` — Mailgun replaces it).
3. Ensures the `turbopanel` Docker network + the active named volumes exist,
   pre-owns volume data directories on the very first run (before Compose
   takes ownership), and force-removes any pre-existing non-Compose container
   with a conflicting name (migration path from the old per-service `docker
   run` containers — container names are unchanged: `turbopanel-database` /
   `turbopanel-queue`).
4. Templates `docker-compose.yml` (mode `0640`, owner `root:{{
   turbopanel_group }}`) and a `wait-ready.sh` readiness script, installs
   `turbopanel-system-stack.service`, and starts the new unit.
5. `docker compose -p turbopanel-system … up -d --remove-orphans` — the
   `--remove-orphans` flag is what tears down the `queue` container
   when a converge switches to Workers runtime (no per-runtime "stop and
   disable" systemd task needed in `instance-launch`).
6. Restarts (targeted `docker restart`, not `--force-recreate`) just the
   `queue` container when the `rabbitmq` role's config `template` task
   reported `changed` earlier in the play (`docker compose up -d` alone does
   not notice a bind-mounted file's *content* changing), then re-waits for
   readiness on that container.

**Labels:** every service in the Compose file carries **only**
`com.turbopanel.system.component: <database|queue>` and
`turbopanel.role: turbopanel` — never `com.turbopanel.service`, `traefik.enable`, or
`com.turbopanel.raw-port` (those identify *tenant* deploy containers; see
`../src/deploy/system-component.ts` / `../src/deploy/labels.ts`).

| Path / resource                                             | Purpose                                                                                                                                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/etc/turbopanel/system/docker-compose.yml`                 | The `turbopanel-system` Compose project (services `database`/`queue`)                                                                                                                       |
| `/etc/turbopanel/system/wait-ready.sh`                      | Readiness script (`pg_isready` / `rabbitmq-diagnostics -q ping` via `docker exec`), run as a second `ExecStart` so the oneshot unit blocks until services actually answer                    |
| `turbopanel-system-stack.service`                           | `Type=oneshot`, `RemainAfterExit=yes`; `ExecStart` = compose `up -d --remove-orphans` then `wait-ready.sh`; `ExecStop` = compose `down`                                                      |
| Containers `turbopanel-database` / `turbopanel-queue`       | Unchanged names/volumes from the old per-service containers — Compose adopts them (old non-Compose containers with the same name are force-removed on first run)                            |
| `/etc/turbopanel/system/postgres-backup.sh`                 | Nightly `pg_dump -Fc` of the control-plane database; installed only when `_system_compose_database_active`                                                                                   |
| `turbopanel-postgres-backup.timer` / `.service`              | `OnCalendar={{ postgres_backup_oncalendar }}` (default `03:00`), `Persistent=true`; the `.service` is `Type=oneshot`, `Requires=turbopanel-system-stack.service`                             |

Dependent units (`turbopanel-instance.service`, `turbopanel-dbstudio.service`,
`turbopanel-mailer.service`) declare
`After=`/`Wants=`/`Requires=turbopanel-system-stack.service`.

**Postgres backup.** `postgres_backup_enabled` defaults `true` — the database
holds every organization's secrets and TLS keys, so a nightly local backup is
the default posture, not opt-in. The script (`postgres-backup.sh.j2`) runs
`pg_dump -Fc` **inside** the `database` container over its default local
connection — no password is slurped or passed, the same trust model
`turbopaneld/src/managed/engines/postgres.ts`'s `dumpArgv` already relies on
for the unrelated customer-facing managed-engine backup feature — writes
atomically (`.part` + rename, `trap` cleanup on failure), and prunes to the
newest `postgres_backup_retention_keep` dumps (default 14) under
`{{ postgres_backup_dir }}` (default `{{ turbopanel_state_dir
}}/backup/postgres`). Off-host push is a separate opt-in,
`postgres_backup_remote_destination` (default `""`, local-only): when set to
an `rsync`-compatible target the script pushes the fresh dump there after
every successful local write — this runs from inside the nightly script
itself, not at Ansible converge time, since a systemd timer fires
independently of converges (contrast the `instance-launch` secret-keyring
escrow, which *is* pull-at-converge via `ansible.builtin.fetch` and cannot
satisfy "nightly"). `website/docs/deployment/security.mdx` → "Backup and
disaster recovery" documents the RPO/RTO and the restore runbook this pairs
with; `src/orchestration/ansible.test.ts` pins the defaults, the gate
expressions, and the script's dump/retention/push shape.

**Container hardening.** Both `database` and `queue` run `cap_drop: [ALL]`,
`security_opt: [no-new-privileges:true]`, `read_only: true` (with a `tmpfs`
`/tmp` for the writes each image still needs at that path — the rest of what
either process writes already lives on its named volume), a `mem_limit` /
`pids_limit` ceiling (`{postgres,rabbitmq}_container_mem_limit` /
`_pids_limit`, default `512m` / `200`, each role's own defaults), and a
`healthcheck` reusing the exact `pg_isready` / `rabbitmq-diagnostics -q ping`
commands `wait-ready.sh` already runs — so a container that is *running but
degraded* (Postgres up but refusing connections, RabbitMQ up with a broken
vhost) now surfaces as unhealthy in `docker ps` instead of looking identical
to a healthy one. Verified live in this sandbox (Docker is available here,
unlike most Ansible-only changes on this page): a hand-built Compose file
with these exact directives against the real `postgres:18` /
`rabbitmq:4-management` images reached `healthy`, a write outside the
declared volumes/tmpfs failed with `Read-only file system` (confirming
`read_only` actually took effect, not just parsed), a real
`CREATE TABLE`/`INSERT`/`SELECT` and `rabbitmqctl list_vhosts` both
succeeded, and the database container returned to `healthy` after a
`docker restart`. Separately, the real Jinja2 template was rendered with
realistic variables and the result passed `docker compose config`. Tenant
compose services get no such default ceiling yet — that is a separate,
larger product decision (what default is safe for an arbitrary tenant
workload) deliberately left open; see the Road-page item this closes.

**Converge order:** `postgres` → `rabbitmq` (config only) →
`system-compose` (brings the stack up). Standalone single-service playbooks
(`postgres-setup.yml` / `rabbitmq-setup.yml`) each run
their one config role followed by `system-compose`.

**`turbopanel-system` is inspect-only from the daemon's side** — this role (and
its readiness/restart-on-config-change logic above) is the *only* thing that
brings the stack up or restarts a service in it. `system.reconcile` never
calls `docker compose up`/`restart` for `database`/`queue` (see
`../src/deploy/AGENTS.md` → "Shared HTTP ingress identity", fourth table row).
Caddy (control-plane + hosting), Redis, the control-plane instance, and
`turbopaneld` itself stay **host-native** and are never part of this or any
other Compose project — they have no `container` row, and their health/restart
surface is the server **Control** tab / system-component control API on the
instance, not a container table. Rationale for why those four stay host-native
(PAM, `systemctl`/`git` update access, socket uid/gid, unix-socket
permissions) is canonical in `../../turbopanel/AGENTS.md` → "Self-host system
inventory" — do not duplicate it here.
