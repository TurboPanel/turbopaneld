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
import { isWritableSql as mariadbIsWritableSql } from "./engines/mariadb-sql.ts";
import { isWritableSql as mysqlIsWritableSql } from "./engines/mysql-sql.ts";
import { parseSqlBool } from "./engines/sql-bool.ts";
import { resolveLayout } from "../paths/layout.ts";
import {
  assertSwitchoverAbortReactivateAllowed,
  switchoverAbortReactivateBlockedReason,
} from "./switchover-abort-guard.ts";
import {
  clearManagedDemotionArtifacts,
  isManagedMemberDemoted,
} from "./demoted-marker.ts";
import {
  clearSwitchoverPromoteLocalMarker,
  clearSwitchoverQuiescedMarker,
  readSwitchoverQuiescedMarker,
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
  const layout = resolveLayout(Deno.env.toObject());
  // A new fence starts here: what the previous switchover left behind (this
  // member's own "promotion completed" mark) is history, and would make the
  // abort guard refuse to reactivate this member for ever.
  await clearSwitchoverPromoteLocalMarker(layout, payload.managedId);
  const gtidSet = await quiesce(ctx);
  await writeSwitchoverQuiescedMarker(layout, payload.managedId, {
    primaryExecutedGtidSet: gtidSet,
    quiescedAt: new Date().toISOString(),
  });
  return gtidSet;
}

/**
 * The fence stop failed before it fenced anything (for example the position
 * read threw and the engine was put back): there is no quiesced mark, no
 * demoted mark, and the engine is still the writable primary. There is
 * nothing to undo, and refusing here would fail the cluster for no reason. A
 * read-only engine without a mark is never treated this way: it may have been
 * fenced by something else. Changes nothing on the engine.
 */
async function formerPrimaryNeverFenced(
  layout: ReturnType<typeof resolveLayout>,
  payload: ManagedLifecyclePayload,
  run: RunDockerFn,
  engineDeps?: LocalEngineContextDeps,
): Promise<boolean> {
  if (switchoverAbortReactivateBlockedReason(payload) !== null) return false;
  if (await readSwitchoverQuiescedMarker(layout, payload.managedId)) {
    return false;
  }
  if (await isManagedMemberDemoted(layout, payload.managedId)) return false;
  const { engine, ctx } = await resolveLocalReplicationEngine(
    payload.managedId,
    payload.engine,
    "managed.lifecycle",
    { runDocker: run, ...engineDeps },
  );
  await engine.waitReady(ctx);
  const replication = engine.replication;
  if (!replication?.runAdminScalarQuery) return false;
  if (await replication.isStandby(ctx)) return false;
  // Every read-only flag of the engine must read off: a read-only engine
  // without a mark is the ambiguous case and stays refused.
  const flags = (await replication.runAdminScalarQuery(
    ctx,
    payload.engine === "mysql" ? mysqlIsWritableSql() : mariadbIsWritableSql(),
  )).trim().split(/\s+/).map(parseSqlBool);
  return flags.length > 0 && flags.every((flag) => flag === false);
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
    if (await formerPrimaryNeverFenced(layout, payload, run, engineDeps)) {
      return;
    }
    await assertSwitchoverAbortReactivateAllowed(layout, payload);
  }
  try {
    await clearManagedDemotionArtifacts(layout, payload.managedId, {
      engine: payload.engine,
      run,
      volumeFenceOnly: true,
    });
  } catch (err) {
    throw new Error(
      `managed.lifecycle switchover abort: could not clear demoted volume fence (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
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
