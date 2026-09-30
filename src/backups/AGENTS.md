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
| Per-engine lock shared with `managed.backup` / `managed.restore` | `src/managed/target-lock.ts` |

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
  that directory only.

## Rules

- A run that has no enabled policy on the host (missing, disabled, invalid id,
  unreadable policies file) runs nothing and spools nothing: the control plane
  would refuse a report for it anyway, and the unit is removed at the next
  reconcile.
- Every other outcome spools a result, `succeeded` or `failed`: busy engine
  (the lock is held), not enough free space, a `copy` target (volumes are Road
  row `r2-backup-tenant-volumes`, not supported yet), or a dump error. Error
  text is capped at 2000 characters.
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
