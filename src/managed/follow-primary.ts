/**
 * Re-point a local standby at a new primary after switchover or failover.
 *
 * Does not re-seed: Postgres rewrites `primary_conninfo`; MySQL / MariaDB
 * change only the replication source host and port.
 */

import type { ManagedEngineCode } from "../contracts/commands-contracts.ts";
import {
  type LocalEngineContextDeps,
  resolveLocalReplicationEngine,
} from "./local-engine-context.ts";

export type FollowPrimarySpec = {
  managedId: string;
  engine?: ManagedEngineCode;
  primary: {
    host: string;
    hostaddr?: string;
    port: number;
  };
};

export type FollowPrimaryDeps = LocalEngineContextDeps;

export async function followLocalStandby(
  spec: FollowPrimarySpec,
  deps?: FollowPrimaryDeps,
): Promise<void> {
  const { engine, ctx } = await resolveLocalReplicationEngine(
    spec.managedId,
    spec.engine,
    "managed.ha.failover repoint",
    deps,
  );
  await engine.replication!.followPrimary(ctx, { primary: spec.primary });
}
