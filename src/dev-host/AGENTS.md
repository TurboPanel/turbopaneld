# Development host — AGENTS.md

Daemon repo context: `../../AGENTS.md`. Wire messages: `../instance/AGENTS.md`
(Development host). Cross-repo `../<repo>/…` links are relative to the repo root.

The co-located development host (feature `dev-host-v1`): the daemon reports
the four development checkouts and units (daemon, control plane, web
interface, website) and runs **Update and Restart** or **Restart Only** for the
control plane's host bar and the Developer Console. It exists only on a
development install (daemon run from its checkout) with
`TURBOPANEL_DEV_INSTANCE=1`; anywhere else `startDevHostIfEnabled` returns null
and an action is answered `not_development`.

| Piece | File |
| --- | --- |
| Activation, the four parts, file paths under `<daemonStateDir>/dev-updates` | `config.ts` |
| The one command runner (tests swap it), bounded log tails | `commands.ts` |
| HEAD and `origin/trunk` from files (`packed-refs`, worktrees), fetch, `rev-list`, the fast-forward | `git.ts` |
| Local change classes (`content` blocks; `mode`, `generated`, `untracked`, `runtime` do not) | `dirty.ts` |
| `systemctl show` for all units; the control plane unit's database URL | `units.ts` |
| The status tick | `status.ts` |
| The job (steps, lock, `job.json`, backup command, restart waits) | `job.ts` |
| Wire answers, the service, `status.json`, the size cap | `wire.ts` |
| Starting Update and Restart by itself when trunk has new migrations | `auto-migrate.ts` |

## Owner rules (binding)

- Never reset, stash, switch branches or pull anything but
  `git merge --ff-only origin/trunk`. A checkout on another branch, or with a
  `content` change, is reported and left alone. A refused fast-forward is the
  part's `blockedReason` (git's last line) until HEAD or `origin/trunk` moves.
- Mode-only changes, `website/next-env.d.ts`, untracked files and
  `.config/` / `.local/` / `.cache/` are shown and never block.
- Migration always runs with a backup first: `pnpm migrate` in the control
  plane checkout with `TURBOPANEL_DATABASE_URL` read from the
  `turbopanel-instance` unit (its `Environment=`, then its environment files)
  and `TURBOPANEL_MIGRATE_BACKUP_COMMAND` set to a `pg_dump -Fc` inside the
  `turbopanel-database` container written to `dev-updates/backups/` (newest 5
  kept). The control plane's migrate script runs that command only when
  something is pending and refuses to migrate when it fails. No URL, or a URL
  whose user or database is not a plain name, or whose database is not on
  this machine (a `?host=` socket URL, the form the instance unit uses, or a
  loopback host), fails the step before `pnpm migrate` runs. Migrate is
  skipped when the control plane checkout is off trunk or has a content
  change, so a half-written migration is never applied. A failed install, backup or migrate stops the job
  before any restart.
- Restart order: control plane (then wait until it restarted, is active and
  answers `/api/health`; a development control plane reports commit
  `unknown`, which is accepted), then web interface and website only when
  their package or config files are newer than the unit start, then this
  daemon last, only after the job is written `done` and the lock removed.
  Every restart is `sudo -n systemctl restart --no-block` through
  `hostSudoArgs`.
- Restart Only runs the three restart steps and no git command.
- A merge that adds migrations reaches the dev database by itself (owner
  decision 2026-11-05, which narrows "nothing pulls on its own" to this one
  case): after each status tick, `auto-migrate.ts` compares
  `git show origin/trunk:migrations/manifest.json` (control plane checkout)
  with `public.migration` (`psql` inside `turbopanel-database`, no password).
  When trunk has hashes the database lacks and every part is on trunk with no
  `content` change and no `blockedReason`, it starts the normal `update` job.
  Otherwise nothing runs and the control plane part's `blockedReason` names
  the part that holds it back. Each `origin/trunk` plus control plane HEAD
  pair is tried once, so a failed job is not repeated until one of them moves.
  A database with a hash trunk does not ship (a branch migration applied by
  hand) is never migrated automatically. The co-located instance unit also
  migrates before every start (`orchestration/AGENTS.md`, "instance-launch
  dev migrate before start").

## Speed

One `systemctl show` per 60 s tick for all units; `git fetch -q origin trunk`
per checkout at most every 10 minutes (a job always fetches); HEAD and refs are
file reads; `git rev-list --count` only when HEAD or the remote ref moved;
one `git status` per checkout (plus `git diff --numstat` when a tracked file is
modified). The newest-source check (control plane and daemon, which do not
reload on their own) walks `src/` in process and stops at the first newer file;
once a restart is known to be needed it is not walked again until the unit
restarts. The migration comparison (one `git show` and one `docker exec psql`)
runs only when `origin/trunk` or the control plane HEAD moved, or every 10
minutes, and never while a job runs.

## Files

`/var/lib/turbopanel/dev-updates/` (from `resolveLayout().daemonStateDir`):
`job.json` (the job, written at every step; a job found `running` at start is
marked `failed`), `job.lock` (pid; a dead pid's lock is taken over),
`status.json` (the full status plus `writtenAt`, for the Developer Console)
and `backups/`. The purge never runs on a development host, and the
development reset removes the whole state tree.

## Tests

Real `git` in temp folders only, through `src/testing/dev-host-fixture.ts`
(origins on `trunk`, clones under a temp root, a runner that records
`systemctl`, `sudo` and `pnpm` instead of running them). Never point a test at
the real checkouts or `/var/lib/turbopanel`.
