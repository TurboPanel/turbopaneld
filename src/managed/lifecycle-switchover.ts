/**
 * Planned switchover helpers for `managed.lifecycle` (MySQL-family GTID capture
 * and abort reactivation).
 */

import type { ManagedLifecyclePayload } from "../contracts/commands-contracts.ts";
import {
  type LocalEngineContextDeps,
  resolveLocalReplicationEngine,
} from "./local-engine-context.ts";
import type { RunDockerFn } from "../deploy/docker-cli.ts";

export async function captureSwitchoverGtidBeforeStop(
  payload: ManagedLifecyclePayload,
  run: RunDockerFn,
  engineDeps?: LocalEngineContextDeps,
): Promise<string | undefined> {
  if (payload.action !== "stop" || payload.captureSwitchoverGtid !== true) {
    return undefined;
  }
  const { engine, ctx } = await resolveLocalReplicationEngine(
    payload.managedId,
    payload.engine,
    "managed.lifecycle",
    { runDocker: run, ...engineDeps },
  );
  const quiesce = engine.replication?.quiesceFormerPrimaryForSwitchover;
  if (!quiesce) {
    throw new Error(
      "managed.lifecycle captureSwitchoverGtid is not supported for this engine",
    );
  }
  return await quiesce(ctx);
}

export async function reactivatePrimaryAfterSwitchoverAbort(
  payload: ManagedLifecyclePayload,
  run: RunDockerFn,
  engineDeps?: LocalEngineContextDeps,
): Promise<void> {
  if (
    payload.action !== "start" ||
    payload.reactivateAfterSwitchoverAbort !== true
  ) {
    return;
  }
  const { engine, ctx } = await resolveLocalReplicationEngine(
    payload.managedId,
    payload.engine,
    "managed.lifecycle",
    { runDocker: run, ...engineDeps },
  );
  await engine.waitReady(ctx);
  await engine.replication?.reactivateFormerPrimaryAfterSwitchoverAbort?.(ctx);
}
