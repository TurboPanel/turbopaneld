/**
 * Re-point a local standby at a new primary after switchover or failover.
 *
 * Does not re-seed: Postgres rewrites `primary_conninfo`; MySQL / MariaDB
 * change only the replication source host and port. Physical slots are
 * created on the new primary (`ensureLocalPrimarySlots`) before replicas
 * follow.
 */

import type { ManagedEngineCode } from "../contracts/commands-contracts.ts";
import type {
  ManagedEngineContext,
  ManagedEngineReplicationRuntime,
} from "./engines/types.ts";
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

export type EnsurePrimarySlotsSpec = {
  managedId: string;
  engine?: ManagedEngineCode;
  slots: readonly string[];
};

const REPOINT_STREAMING_POLL_MS = 3_000;
const REPOINT_STREAMING_TIMEOUT_MS = 90_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type FollowPrimaryDeps = LocalEngineContextDeps & {
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
};

async function waitUntilStandbyStreaming(
  replication: ManagedEngineReplicationRuntime,
  ctx: ManagedEngineContext,
  deps?: FollowPrimaryDeps,
): Promise<void> {
  const sleep = deps?.sleep ?? defaultSleep;
  const timeoutMs = deps?.timeoutMs ?? REPOINT_STREAMING_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let lastState = "unknown";
  for (;;) {
    lastState = (await replication.readHealth(ctx, "standby")).state;
    if (lastState === "streaming") return;
    if (Date.now() >= deadline) break;
    await sleep(REPOINT_STREAMING_POLL_MS);
  }
  throw new Error(
    `standby did not reach streaming after repoint (last state: ${lastState})`,
  );
}

export async function ensureLocalPrimarySlots(
  spec: EnsurePrimarySlotsSpec,
  deps?: FollowPrimaryDeps,
): Promise<void> {
  const { engine, ctx } = await resolveLocalReplicationEngine(
    spec.managedId,
    spec.engine,
    "managed.ha.failover repoint",
    deps,
  );
  const replication = engine.replication!;
  if (await replication.isStandby(ctx)) {
    throw new Error("refusing to ensure slots: this member is a standby");
  }
  await replication.ensureSlots(ctx, spec.slots);
}

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
  const replication = engine.replication!;
  if (!await replication.isStandby(ctx)) {
    throw new Error("refusing to repoint: this member is not a standby");
  }
  await replication.followPrimary(ctx, { primary: spec.primary });
  await waitUntilStandbyStreaming(replication, ctx, deps);
}
