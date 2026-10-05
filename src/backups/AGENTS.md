# Scheduled backups — AGENTS.md

A backup policy runs on its host with no control-plane round trip: a systemd
timer (`turbopanel-backup-<policyId>.timer`, Road row `r2-backup-unit-template`)
starts `<install>/lib/tp-backup-run <policyId>`, which execs
`turbopaneld backup-run <policyId>` — a one-shot process, not the long-running
daemon, and it never takes `daemon.lock`.

| Piece | File |
| --- | --- |
| `backup-run` verb and exit codes (0 ok, 1 failed + spooled, 2 usage, 3 no policy) | `src/entry/cli.ts` |
| The run itself | `runner.ts` |
| Host copy of the policies, written by `server.backups.reconcile` | `policies-file.ts` |
| Result spool, drained by the reporter | `result-spool.ts` |
| Reporter: spool → `backup-run-report`, delete on `backup-run-report-result` | `result-reporter.ts` (wired in `src/instance/client.ts`) |
| Free-space probe | `free-space.ts` |
| Wrapper, rendered per exec mode by the daemon-launch role | `orchestration/roles/daemon-launch/templates/tp-backup-run.j2` |
| Per-engine lock shared with `managed.backup` / `managed.restore`, per-copy lock shared by copy backups | `src/managed/target-lock.ts` |
| Storage-copy archive through the pinned helper image (scheduled and manual) | `copy-backup.ts` |
| `storage.backup` handler (manual create / delete of one copy archive) | `storage-backup.ts` |
| `storage.restore` handler (stop the copy's containers, swap, start them) | `copy-restore.ts` |
| Timer + service renderers (`turbopanel-backup-<policyId>.*`) | `units.ts` |
| `server.backups.reconcile` handler | `reconcile.ts` |
| Shared install-if-changed / reload / enable / sweep machinery (with tenant cron) | `src/deploy/systemd-unit-set.ts` |
| Host-side unit check for this family | `orchestration/scripts/tp-host` (`tp_backup_unit_id`, `tp_backup_unit_ok`) |

## `server.backups.reconcile`

The payload is the **complete** set for this server. The handler writes the
policies file first (only when the set changed, so an unchanged set leaves its
`appliedAt` alone), then applies the unit family: install a service + timer for
each enabled policy only when the bytes differ, one `daemon-reload`, `enable
--now` only the timers that moved, and remove every `turbopanel-backup-*` timer
the set no longer names (disabled policies included). Next runs come from
`systemctl list-timers --all --output=json <timer>` (`timer-next-run.ts`; its
`next` is microseconds since the epoch), unprivileged; a failed read is a
warning, not an error. Do not use `systemctl show --timestamp=unix`: `show`
ignores `--timestamp` and prints the local "Tue 2026-10-06 03:25:35 CDT" form.

The units: the service is a oneshot as `tp:tp` whose only `ExecStart` is the
wrapper with its own policy id, reading `daemon.env`, at `Nice=10` /
`IOSchedulingClass=idle`, no `[Install]` (only its timer starts it). The timer
is `Persistent=true` (a run missed while the host was off happens once when it
returns) with a 300 s `RandomizedDelaySec`. tp-host pins every one of those
lines — change `units.ts` and `tp_backup_unit_ok` together.

## What the runner may do (Deno permissions)

In **JS mode** the wrapper runs `backup-run` under its own small grant set,
`renderBackupRunnerPermissionFlags()` in `src/permissions/daemon-permissions.ts`
(rendered verbatim into `tp-backup-run.j2` and pinned by
`daemon-permissions.test.ts`), not the daemon's:

- **read/write:** `<state>/backup` (policies file, result spool), the two lock
  folders `<run>/managed-locks` and `<run>/copy-locks`, and `/backup`. Nothing
  else under the state dir, no `/srv/users` (a helper container reads the
  volume, never this process), no Docker socket (the CLI child opens it).
- **read of `/usr/bin/docker`:** `ensureDocker` stats the binary.
- **run:** `/usr/bin/docker` only. No `sudo`, shell, `systemctl`, `iptables`.
  `docker-cli.ts` treats Deno's "Requires run access" refusal of its `sudo`
  fallback as "no escalation available", so a socket permission problem is
  reported as the real Docker error.
- **env:** unscoped (`Deno.env.toObject()` in layout resolution needs it); safe
  because there is no net grant. **sys:** `statfs`. No net, no ffi.

A new path or program on the backup path needs the same change in
`daemon-permissions.ts` (the tests check the grants cover every path the code
builds). `TURBOPANEL_BACKUP_DIR` repointing needs the grant to follow it (the
daemon's own set has the same fixed `/backup`). **Native hosts** run the
compiled binary, whose baked grants are the daemon's full set and cannot be
narrowed at runtime; narrowing them would take a second compiled binary.

## Files on the host

- `<daemonStateDir>/backup/policies.json` —
  `{ "version": 1, "appliedAt": "<ISO>", "policies": [<BackupPolicyWireEntry>] }`,
  mode 0640, replaced atomically (dot-prefixed tmp, then rename). Every read
  re-validates `policies` with `parseBackupsReconcilePayload`; a malformed file
  runs nothing.
- `<daemonStateDir>/backup/results/<runId>.json` — one per finished run,
  `{ "version": 1, policyId, runId, startedAt, finishedAt, status, error?,
  backupId?, sizeBytes?, checksum?, path?, pruned? }` (the run fields of
  `BackupRunReportMessage`), mode 0640, written as `.<runId>.json.tmp` then
  renamed. Readers skip dot-prefixed names. The reporter deletes a file only
  after the control plane acks it.
- Artifacts: `<backupDir>/<managedId>/policy-<policyId>/<backupId>.<ext>`
  (`managed/engine-paths.ts`), pruned to the policy's `retentionKeep` within
  that directory only. Storage copies: `<backupDir>/copies/<copyId>/<backupId>.tar.gz`
  (manual) and `<backupDir>/copies/<copyId>/policy-<policyId>/…` (scheduled).

## Storage copies

- A copy archive is a live gzipped tar (no pause, no stop) written by a
  throwaway helper container, never by the daemon reading tenant files:
  `COPY_BACKUP_HELPER_IMAGE` (alpine pinned by its multi-arch index digest),
  `--network none --read-only --security-opt no-new-privileges --pull never`,
  the copy mounted read-only at `/src`. Changing the image is a code change.
- The image is pulled by `server.backups.reconcile` when an enabled copy
  policy exists (a failed pull is a warning) and by a manual `storage.backup`;
  a scheduled run never pulls.
- Sources: a Docker volume by name, or a host directory. `copy-source-guard.ts`
  checks both before every mount (backup, restore, and again under the restore
  lock). A volume must be the storage's own (name = `storageId`) or carry the
  project's `com.docker.compose.project` label, and must be a plain local
  volume (no `device`/bind options, no other driver); `docker volume inspect`
  also refuses a missing volume. A host path must be inside
  `/srv/users/<ownerUsername>/volumes/` (the wire names the owner) or the
  default `<stateDir>/storage/` root, with no symlink component below the
  owner's home / storage root. Never `/var/lib/docker/volumes`.
- Retention (`pruneBackupArtifacts` with `COPY_ARCHIVE_MIN_GOOD_BYTES`): an
  archive under 1 KiB holds no files; it is kept, never counts toward
  `retentionKeep`, and a run that produced one prunes nothing.
- `<runDir>/copy-locks/<copyId>.lock` is the per-copy flock: a scheduled run,
  a manual backup and a restore of one copy never run at once.

## `storage.restore`

Security-sensitive: it stops tenant services and writes into a tenant's copy.
Keep this order (`copy-restore.ts`, pinned by `copy-restore.test.ts`):

1. Before anything stops: the artifact's sha256 equals the payload's (the
   control plane's `archive` row), the copy resolves inside the allowed roots,
   the helper image is present, and the volume or directory exists.
2. Under the copy lock: list **running** containers (`docker ps`, then
   `docker inspect`) whose mounts are the copy's volume, or a bind at or under
   its directory, and stop them one at a time. If one will not stop, start
   the ones already stopped and extract nothing.
3. The helper mounts the copy read-write at `/dst` and the artifact read-only,
   extracts into `/dst/.tp-restore-stage`, moves the current entries to
   `/dst/.tp-restore-old`, moves the staged ones up, deletes the old ones
   (`RESTORE_SCRIPT`: exit 3 = unextractable, copy unchanged; 4 = swap failed,
   old contents put back; 5 = putting them back failed too; 6 = an earlier
   restore left `.tp-restore-old` without its `.tp-restore-done` marker, so
   nothing is touched. The script never deletes such an `old`).
   Before step 2 an intent file (`<backupDir>/restore-intents/<copyId>.json`:
   container ids, helper name) is written; it is removed once the containers
   run again, and `recoverInterruptedRestores` (daemon boot) starts them if the
   daemon died in between.
4. Always: start every container stopped in step 2; report the ones that
   would not start.

Only containers are stopped. A native (systemd) app reading a `/srv/users/`
directory keeps running, and a deploy or lifecycle command for the same app
during the restore can start a container again: the copy lock does not cover
deploy.

## Rules

- A run that has no enabled policy on the host (missing, disabled, invalid id,
  unreadable policies file) runs nothing and spools nothing: the control plane
  would refuse a report for it anyway, and the unit is removed at the next
  reconcile.
- Every other outcome spools a result, `succeeded` or `failed`: busy engine or
  copy (the lock is held), not enough free space, a missing volume or a
  directory outside the allowed roots, or a dump / archive error. Error text is
  capped at 2000 characters.
- Free space: refuse below `max(2 × the policy's newest artifact, 256 MiB)` on
  the backup filesystem (nearest existing ancestor of the policy directory).
- The lock is a non-blocking `flock` on `<runDir>/managed-locks/<managedId>.lock`:
  a second holder fails at once instead of queueing, and the kernel releases
  it when the holder exits, so it cannot go stale. The wrapper exports the
  daemon's `TURBOPANEL_RUN_DIR` so both sides lock the same file.

## Reporting

- `BackupResultReporter` runs in the long-running daemon while the socket is
  up: on attach and every 60 s it sends up to 20 spooled results, oldest first,
  as `backup-run-report` with `id` = the run id (= the file name), so an
  answer finds its file after a reconnect or restart.
- A file is deleted only when `backup-run-report-result` with its id arrives,
  `ok` true (recorded) or false (refused for good). No answer leaves it for
  the next tick; the control plane records a run once however often it is
  sent. A closed socket ends the tick.
- `nextRunAt` comes from `systemctl list-timers --all --output=json
  turbopanel-backup-<policyId>.timer` (read-only, no sudo; `timer-next-run.ts`); it is omitted while the unit does not exist or is not scheduled.
- A spooled file that would not pass the control plane's frame check is
  renamed to `.<runId>.json.invalid` and never sent: an out-of-shape frame
  closes the socket, which would otherwise repeat every tick.
