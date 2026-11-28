/**
 * Bounded log collection for managed compose projects.
 *
 * Transport: correlated cell request `managed-logs-request` →
 * `managed-logs-result` (see instance `daemon/cell/protocol.ts`). Command
 * results stay bounded summaries — logs never ride `command-outcome`.
 */

import {
  type DockerCliResult,
  runDocker as defaultRunDocker,
  type RunDockerOptions,
} from "../deploy/docker-cli.ts";
import { truncateLogTail } from "../logs/truncate.ts";
import {
  type MutableTranscriptRedactor,
  redactCommandSummary,
  sharedSecretRedactor,
} from "../logs/redactor.ts";
import {
  sanitizeForLog,
  stripTerminalControlsKeepBreaks,
} from "../util/logger.ts";
import { managedComposeProject, SAFE_MANAGED_ID_RE } from "./engine-paths.ts";

type RunDockerFn = (
  args: string[],
  options?: RunDockerOptions,
) => Promise<DockerCliResult>;

const DEFAULT_TAIL = 200;
const MAX_TAIL = 2_000;

export type CollectManagedLogsOptions = {
  tail?: number;
};

/**
 * `docker compose -p <project> logs --no-color --tail <N>`, truncated to a
 * UTF-8 byte cap after redaction.
 */
export async function collectManagedLogs(
  managedId: string,
  options?: CollectManagedLogsOptions,
  run: RunDockerFn = defaultRunDocker,
  redactor: MutableTranscriptRedactor = sharedSecretRedactor(),
): Promise<string> {
  if (!SAFE_MANAGED_ID_RE.test(managedId)) {
    throw new Error("managedId contains unsupported characters");
  }
  const rawTail = options?.tail ?? DEFAULT_TAIL;
  const tail = Math.min(Math.max(1, Math.floor(rawTail)), MAX_TAIL);
  const project = managedComposeProject(managedId);

  const result = await run([
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
      `managed logs failed: ${
        sanitizeForLog(result.stderr || "compose logs failed")
      }`,
    );
  }

  // Same pipeline as container tails: redact the whole text (line breaks
  // survive), strip terminal controls, then cut to the UTF-8 byte cap.
  return truncateLogTail(
    stripTerminalControlsKeepBreaks(
      redactCommandSummary(result.stdout, redactor.secrets()),
    ),
  );
}
