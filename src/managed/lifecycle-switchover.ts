/**
 * Planned switchover helpers for `managed.lifecycle` (MySQL-family GTID capture
 * and abort reactivation).
 */

import type { ManagedLifecyclePayload } from "../contracts/commands-contracts.ts";
import { resolveLocalReplicationEngine } from "./local-engine-context.ts";
import type { RunDockerFn } from "../deploy/docker-cli.ts";

export async function captureSwitchoverGtidBeforeStop(
  payload: ManagedLifecyclePayload,
  run: RunDockerFn,
): Promise<string | undefined> {
  if (payload.action !== "stop" || payload.captureSwitchoverGtid !== true) {
    return undefined;
  }
  const { engine, ctx } = await resolveLocalReplicationEngine(
    payload.managedId,
    payload.engine,
    "managed.lifecycle",
    { runDocker: run },
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
    { runDocker: run },
  );
  await engine.waitReady(ctx);
  await engine.replication?.reactivateFormerPrimaryAfterSwitchoverAbort?.(ctx);
}
