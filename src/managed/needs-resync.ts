/**
 * Shared needs_resync handling for a member whose data volume holds data
 * without the engine's standby marker (e.g. a demoted former primary). Used by
 * `managed.apply` (before compose up) and `managed.lifecycle` (before compose
 * start) so such a member is never brought up as a second writable primary.
 */

import type { ManagedApplyResult } from "../contracts/commands-contracts.ts";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { logInfo } from "../util/logger.ts";
import { managedComposeProject } from "./engine-paths.ts";

/** Pure member DTO for the needs_resync early-return path. */
export function buildNeedsResyncMember(
  memberId: string,
): NonNullable<ManagedApplyResult["member"]> {
  return {
    memberId,
    role: "replica",
    status: "needs_resync",
    replication: {
      state: "needs_resync",
      observedAt: new Date().toISOString(),
    },
  };
}

/** Stop the member's compose project (best effort) so it is not left running. */
export async function stopManagedProjectForResync(
  managedId: string,
  redact: (text: string) => string,
  run: (args: string[]) => Promise<DockerCliResult>,
): Promise<void> {
  const project = managedComposeProject(managedId);
  const stop = await run(["compose", "-p", project, "stop"]);
  if (!stop.success) {
    logInfo(
      "managed",
      `needs_resync compose stop soft-failed project=${project}: ${
        redact(stop.stderr || stop.stdout || "compose stop failed")
      }`,
    );
  }
}
