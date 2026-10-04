/**
 * The run-result spool: `<daemonStateDir>/backup/results/<runId>.json`, one
 * file per finished scheduled run, success or failure. The long-running
 * daemon's reporter (Road row `r2-backup-status-report`) sends each file as a
 * `backup-run-report` and deletes it only once the control plane acks, so a
 * result survives a disconnect or a daemon restart.
 *
 * Files are written to a dot-prefixed tmp name and renamed into place, so a
 * reader that skips names starting with `.` never sees a partial file.
 *
 * File format (version 1) — exactly the run fields of `BackupRunReportMessage`
 * (the reporter adds `id`, `nextRunAt` and `at`):
 *
 * ```json
 * { "version": 1, "policyId": "…", "runId": "run_…", "startedAt": "…",
 *   "finishedAt": "…", "status": "succeeded" | "failed", "error"?: "…",
 *   "backupId"?: "bk_…", "sizeBytes"?: n, "checksum"?: "<sha256>",
 *   "path"?: "…", "pruned"?: ["bk_…"] }
 * ```
 */

import { join } from "@std/path";
import type { BackupRunReportMessage } from "../contracts/cell-messages.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { backupStateDir } from "./policies-file.ts";

const RESULT_FILE_VERSION = 1;
/** Bound on the reported failure text; the rest is in the journal. */
export const MAX_RESULT_ERROR_LENGTH = 2000;
const SAFE_RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type BackupRunResult = Pick<
  BackupRunReportMessage,
  | "policyId"
  | "runId"
  | "startedAt"
  | "finishedAt"
  | "status"
  | "error"
  | "backupId"
  | "sizeBytes"
  | "checksum"
  | "path"
  | "pruned"
>;

export function backupResultsDir(
  layout: Pick<LayoutPaths, "daemonStateDir">,
): string {
  return join(backupStateDir(layout), "results");
}

/** Mint a run id: `run_` plus 32 hex chars, inside the shared id charset. */
export function mintRunId(): string {
  return `run_${crypto.randomUUID().replaceAll("-", "")}`;
}

/** Trim failure text to {@link MAX_RESULT_ERROR_LENGTH}, marking the cut. */
export function capResultError(text: string): string {
  if (text.length <= MAX_RESULT_ERROR_LENGTH) return text;
  return `${text.slice(0, MAX_RESULT_ERROR_LENGTH - 1)}…`;
}

/** Atomically write one run's result; returns the final path. */
export async function writeBackupRunResult(
  layout: Pick<LayoutPaths, "daemonStateDir">,
  result: BackupRunResult,
): Promise<string> {
  if (!SAFE_RUN_ID_RE.test(result.runId)) {
    throw new Error("runId contains unsupported characters");
  }
  const dir = backupResultsDir(layout);
  await Deno.mkdir(dir, { recursive: true, mode: 0o750 });
  const finalPath = join(dir, `${result.runId}.json`);
  const tmp = join(dir, `.${result.runId}.json.tmp`);
  const body = JSON.stringify({ version: RESULT_FILE_VERSION, ...result });
  try {
    await Deno.writeTextFile(tmp, `${body}\n`, {
      createNew: true,
      mode: 0o640,
    });
    await Deno.chmod(tmp, 0o640);
    await Deno.rename(tmp, finalPath);
  } catch (err) {
    await Deno.remove(tmp).catch(() => {});
    throw err;
  }
  return finalPath;
}
