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
`systemctl show <timer> --property=NextElapseUSecRealtime --value
--timestamp=unix`, unprivileged; a failed read is a warning, not an error.

The units: the service is a oneshot as `tp:tp` whose only `ExecStart` is the
wrapper with its own policy id, reading `daemon.env`, at `Nice=10` /
`IOSchedulingClass=idle`, no `[Install]` (only its timer starts it). The timer
is `Persistent=true` (a run missed while the host was off happens once when it
returns) with a 300 s `RandomizedDelaySec`. tp-host pins every one of those
lines — change `units.ts` and `tp_backup_unit_ok` together.

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
- Sources: a Docker volume by name (`docker volume inspect` first, so a
  missing volume is refused rather than created empty), or a host directory
  under `/srv/users/` or `<stateDir>/storage/` only. Never
  `/var/lib/docker/volumes`.
- `<runDir>/copy-locks/<copyId>.lock` is the per-copy flock: a scheduled run
  and a manual backup of one copy never run at once.

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
- `nextRunAt` comes from `systemctl show turbopanel-backup-<policyId>.timer
  --property=NextElapseUSecRealtime --value --timestamp=unix` (read-only, no
  sudo); it is omitted while the unit does not exist or is not scheduled.
- A spooled file that would not pass the control plane's frame check is
  renamed to `.<runId>.json.invalid` and never sent: an out-of-shape frame
  closes the socket, which would otherwise repeat every tick.
