/**
 * Enforce read-only (or stop) on a fenced member whose engine container is up.
 */

import type { ManagedEngineCode } from "../contracts/commands-contracts.ts";
import { runDocker as defaultRunDocker } from "../deploy/docker-cli.ts";
import { logWarn, sanitizeForLog } from "../util/logger.ts";
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

export async function enforceFencedMemberIfRunning(
  layout: LayoutPaths,
  managedId: string,
  engine: ManagedEngineCode,
  run: RunDockerFn,
): Promise<void> {
  try {
    await persistDemotedVolumeFence(layout, managedId, engine, run);
  } catch (err) {
    logWarn(
      "managed",
      `demoted fence: volume persist failed managedId=${managedId}:`,
      sanitizeForLog(err),
    );
  }

  const project = managedComposeProject(managedId);
  const containers = await collectManagedContainers(
    project,
    (text) => sanitizeForLog(text),
    run,
  );
  const enginePossiblyRunning = containers === undefined ||
    containers.some((row) => row.status.toLowerCase() === "running");
  if (!enginePossiblyRunning) {
    return;
  }

  const runtime = getManagedEngineRuntime(engine);
  const repl = runtime.replication;
  if (!repl?.enforceFencedFormerPrimaryReadOnly) return;

  try {
    const { engine: resolved, ctx } = await resolveLocalReplicationEngine(
      managedId,
      engine,
      "demoted fence",
      replicationEngineDeps(run),
    );
    await resolved.replication?.enforceFencedFormerPrimaryReadOnly?.(ctx);
  } catch (err) {
    logWarn(
      "managed",
      `demoted fence: read-only enforce failed managedId=${managedId}:`,
      sanitizeForLog(err),
    );
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
  if (observed !== undefined && observed.length === 0) {
    return false;
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
  } catch {
    return true;
  }
}
