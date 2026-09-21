# Command execution logs — AGENTS.md

Streamed command transcripts: a deny-set redactor, an NDJSON spool under
`<stateDir>/spool/execution-logs/`, batched upload to
`POST /api/daemon/v1/commands/:commandId/log`, and an orphan sweep of leftover
spool files. This is the **only** log class the daemon uploads and retains.

Control-plane store and client read path:
`../turbopanel/src/features/execution-logs/AGENTS.md`. Capture details that belong
with deploy/managed handlers live in `src/deploy/AGENTS.md` (Streamed
transcript capture). Container stdout is a live on-demand tail
(`container-tail.ts`, `docker container logs`) and is never stored.

Root context: `../../AGENTS.md` (Command execution logs).

## Layout

| File | Role |
| --- | --- |
| `contracts.ts` | `CommandOutputEvent`, phase names, summary redactor type |
| `redactor.ts` | Deny-set scrub before a line touches the spool |
| `line-stream.ts` | Split stdout/stderr into lines for capture |
| `capture.ts` | Attach a transcript to a running command |
| `spool.ts` | Local NDJSON files, seq, seal |
| `sink.ts` | Upload sink used by the uploader |
| `uploader.ts` | Batched POST of sealed/unsealed chunks |
| `orphan-sweep.ts` | Delete spool files whose command is gone |
| `container-tail.ts` | On-demand `docker container logs` (not this store) |
