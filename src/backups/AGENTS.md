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
| Result spool, drained by the reporter (Road row `r2-backup-status-report`) | `result-spool.ts` |
| Free-space probe | `free-space.ts` |
| Wrapper, rendered per exec mode by the daemon-launch role | `orchestration/roles/daemon-launch/templates/tp-backup-run.j2` |
| Per-engine lock shared with `managed.backup` / `managed.restore` | `src/managed/target-lock.ts` |
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
