/**
 * Bounded log collection for managed compose projects.
 *
 * Transport: correlated cell request `managed-logs-request` →
 * `managed-logs-result` (see instance `daemon/cell/protocol.ts`). Command
 * results stay bounded summaries — logs never ride `command-outcome`.
 */

import { runDocker } from "../deploy/docker-cli.ts";
import { sanitizeForLog } from "../logger.ts";
import {
  managedComposeProject,
  SAFE_MANAGED_ID_RE,
} from "./paths.ts";

const DEFAULT_TAIL = 200;
const MAX_TAIL = 2_000;
const MAX_LOG_BYTES = 256 * 1024;

export type CollectManagedLogsOptions = {
  tail?: number;
};

/**
 * `docker compose -p <project> logs --no-color --tail <N>`, truncated to a
 * hard byte cap.
 */
export async function collectManagedLogs(
  managedId: string,
  options?: CollectManagedLogsOptions,
): Promise<string> {
  if (!SAFE_MANAGED_ID_RE.test(managedId)) {
    throw new Error("managedId contains unsupported characters");
  }
  const rawTail = options?.tail ?? DEFAULT_TAIL;
  const tail = Math.min(Math.max(1, Math.floor(rawTail)), MAX_TAIL);
  const project = managedComposeProject(managedId);

  const result = await runDocker([
    "compose",
    "-p",
    project,
    "logs",
    "--no-color",
    "--tail",
    String(tail),
  ]);

  if (!result.success) {
    throw new Error(
      `managed logs failed: ${sanitizeForLog(result.stderr || "compose logs failed")}`,
    );
  }

  const text = result.stdout;
  if (text.length <= MAX_LOG_BYTES) return text;
  return text.slice(text.length - MAX_LOG_BYTES);
}
