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
import { resolveLayout } from "../paths/layout.ts";
import { assertSwitchoverAbortReactivateAllowed } from "./switchover-abort-guard.ts";
import {
  clearSwitchoverQuiescedMarker,
  writeSwitchoverQuiescedMarker,
} from "./switchover-state-marker.ts";

function isMysqlFamilySwitchoverEngine(
  engine: string | undefined,
): boolean {
  return engine === "mysql" || engine === "mariadb";
}

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
  const gtidSet = await quiesce(ctx);
  const layout = resolveLayout(Deno.env.toObject());
  await writeSwitchoverQuiescedMarker(layout, payload.managedId, {
    primaryExecutedGtidSet: gtidSet,
    quiescedAt: new Date().toISOString(),
  });
  return gtidSet;
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
  const layout = resolveLayout(Deno.env.toObject());
  if (isMysqlFamilySwitchoverEngine(payload.engine)) {
    await assertSwitchoverAbortReactivateAllowed(layout, payload);
  }
  const { engine, ctx } = await resolveLocalReplicationEngine(
    payload.managedId,
    payload.engine,
    "managed.lifecycle",
    { runDocker: run, ...engineDeps },
  );
  await engine.waitReady(ctx);
  await engine.replication
    ?.assertFormerPrimarySafeToReactivateAfterSwitchoverAbort?.(ctx);
  await engine.replication?.reactivateFormerPrimaryAfterSwitchoverAbort?.(ctx);
  if (isMysqlFamilySwitchoverEngine(payload.engine)) {
    await clearSwitchoverQuiescedMarker(layout, payload.managedId);
  }
}
