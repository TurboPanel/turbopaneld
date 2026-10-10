/**
 * Enforce read-only (or stop) on a fenced member whose engine container is up.
 */

import type { ManagedEngineCode } from "../contracts/commands-contracts.ts";
import { runDocker as defaultRunDocker } from "../deploy/docker-cli.ts";
import { logError, logWarn, sanitizeForLog } from "../util/logger.ts";
import { recordDemotedEnforceReadOnlyFailure } from "./demoted-marker.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { persistDemotedVolumeFence } from "./demoted-fence-volume.ts";
import { getManagedEngineRuntime } from "./engines/index.ts";
import {
  resolveLocalReplicationEngine,
  type RunDockerFn,
} from "./local-engine-context.ts";
import { managedComposeProject } from "./engine-paths.ts";
import { collectManagedContainers } from "./containers.ts";

/** Injected `run` is always a test seam — skip host Docker bootstrap. */
function replicationEngineDeps(run: RunDockerFn) {
  if (run === defaultRunDocker) {
    return { runDocker: run };
  }
  return {
    runDocker: run,
    ensureDocker: async () => {},
  };
}

async function recordEnforceFailureBestEffort(
  layout: LayoutPaths,
  managedId: string,
  err: unknown,
): Promise<void> {
  try {
    await recordDemotedEnforceReadOnlyFailure(layout, managedId, err);
  } catch (recordErr) {
    logError(
      "managed",
      `demoted fence: could not record enforce failure managedId=${managedId}:`,
      sanitizeForLog(recordErr),
    );
  }
}

/**
 * Best-effort SQL read-only on a fenced member whose container may be up.
 * Never throws: a failure is logged at error level and recorded on the
 * marker; the guard retries every tick while the engine stays writable, and
 * stopping the container is the real fence.
 */
export async function enforceFencedReadOnlySql(
  layout: LayoutPaths,
  managedId: string,
  engine: ManagedEngineCode,
  run: RunDockerFn,
): Promise<void> {
  const runtime = getManagedEngineRuntime(engine);
  if (!runtime.replication?.enforceFencedFormerPrimaryReadOnly) return;
  try {
    const containers = await collectManagedContainers(
      managedComposeProject(managedId),
      (text) => sanitizeForLog(text),
      run,
    );
    const enginePossiblyRunning = containers === undefined ||
      containers.some((row) => row.status.toLowerCase() === "running");
    if (!enginePossiblyRunning) return;
    const { engine: resolved, ctx } = await resolveLocalReplicationEngine(
      managedId,
      engine,
      "demoted fence",
      replicationEngineDeps(run),
    );
    await resolved.replication?.enforceFencedFormerPrimaryReadOnly?.(ctx);
  } catch (err) {
    logError(
      "managed",
      `demoted fence: read-only enforce failed managedId=${managedId}:`,
      sanitizeForLog(err),
    );
    await recordEnforceFailureBestEffort(layout, managedId, err);
  }
}

/**
 * Re-plant the on-disk fence, then enforce SQL read-only if the engine is up.
 * Never throws (both failures are logged and recorded) so a caller always
 * goes on to stop the container.
 */
export async function enforceFencedMemberIfRunning(
  layout: LayoutPaths,
  managedId: string,
  engine: ManagedEngineCode,
  run: RunDockerFn,
): Promise<void> {
  await persistDemotedVolumeFenceBestEffort(layout, managedId, engine, run);
  await enforceFencedReadOnlySql(layout, managedId, engine, run);
}

/** Plant (or verify) the on-disk fence; failures are logged and recorded. */
export async function persistDemotedVolumeFenceBestEffort(
  layout: LayoutPaths,
  managedId: string,
  engine: ManagedEngineCode,
  run: RunDockerFn,
): Promise<void> {
  try {
    await persistDemotedVolumeFence(layout, managedId, engine, run);
  } catch (err) {
    logError(
      "managed",
      `demoted fence: on-disk fence plant failed managedId=${managedId}:`,
      sanitizeForLog(err),
    );
    await recordEnforceFailureBestEffort(layout, managedId, err);
  }
}

export async function isFencedMemberStillWritable(
  _layout: LayoutPaths,
  managedId: string,
  engine: ManagedEngineCode,
  run: RunDockerFn,
): Promise<boolean> {
  const runtime = getManagedEngineRuntime(engine);
  const isWritable = runtime.replication?.isWritableFormerPrimary;
  if (!isWritable) return false;

  const project = managedComposeProject(managedId);
  const observed = await collectManagedContainers(
    project,
    (text) => sanitizeForLog(text),
    run,
  );
  if (observed?.length === 0) {
    return false;
  }
  if (observed === undefined) {
    return true;
  }

  try {
    const { engine: resolved, ctx } = await resolveLocalReplicationEngine(
      managedId,
      engine,
      "demoted fence",
      replicationEngineDeps(run),
    );
    const probe = resolved.replication?.isWritableFormerPrimary;
    if (!probe) return true;
    return await probe(ctx);
  } catch (err) {
    logWarn(
      "managed",
      `demoted fence: writable probe failed managedId=${managedId}:`,
      sanitizeForLog(err),
    );
    return true;
  }
}
