/**
 * Engine promotion of a streaming standby to primary.
 *
 * Never contacts the old primary (that host is fenced by a separate
 * `managed.lifecycle stop` / ProxySQL drain). TurboPanel automatic failover
 * and Orchestrator recover-fallback also land here after fencing; this module
 * does not elect a candidate.
 */

import type {
  ManagedPromotePayload,
  ManagedPromoteResult,
} from "../contracts/commands-contracts.ts";
import { resolveLayout } from "../paths/layout.ts";
import { clearManagedDemotedMarker } from "./demoted-marker.ts";
import {
  type LocalEngineContextDeps,
  resolveLocalReplicationEngine,
} from "./local-engine-context.ts";
import { proveSwitchoverGtidBeforePromote } from "./switchover-gtid-proof.ts";

type DecryptSecretsFn = (ciphertexts: string[]) => Promise<(string | null)[]>;

export type ManagedPromoteHandlerDeps = LocalEngineContextDeps & {
  decryptSecrets?: DecryptSecretsFn;
};

export async function handleManagedPromote(
  payload: ManagedPromotePayload,
  _daemonReceivedAt: string,
  deps?: ManagedPromoteHandlerDeps,
): Promise<ManagedPromoteResult> {
  const { engine, ctx } = await resolveLocalReplicationEngine(
    payload.managedId,
    payload.engine,
    "managed.promote",
    deps,
  );

  const promoteOptions = payload.requiredExecutedGtidSet !== undefined
    ? {
      requiredExecutedGtidSet: payload.requiredExecutedGtidSet,
      ...(payload.gtidWaitTimeoutSeconds !== undefined
        ? { gtidWaitTimeoutSeconds: payload.gtidWaitTimeoutSeconds }
        : {}),
    }
    : undefined;
  if (payload.requiredExecutedGtidSet !== undefined) {
    await proveSwitchoverGtidBeforePromote(
      {
        managedId: payload.managedId,
        engine: payload.engine,
        requiredExecutedGtidSet: payload.requiredExecutedGtidSet,
        ...(payload.gtidWaitTimeoutSeconds !== undefined
          ? { gtidWaitTimeoutSeconds: payload.gtidWaitTimeoutSeconds }
          : {}),
      },
      deps,
    );
    await engine.replication!.promote(ctx, {
      ...promoteOptions,
      requiredExecutedGtidSet: undefined,
    });
  } else {
    await engine.replication!.promote(ctx, promoteOptions);
  }
  await clearManagedDemotedMarker(
    resolveLayout(Deno.env.toObject()),
    payload.managedId,
  );
  const health = await engine.replication!.readHealth(ctx, "primary");

  return {
    status: "ready",
    role: "primary",
    promotedMemberId: payload.memberId,
    demoted: payload.demoteMemberId !== undefined,
    ...(payload.demoteMemberId !== undefined
      ? { demotedMemberId: payload.demoteMemberId }
      : {}),
    summary: "standby promoted to primary",
    replication: health,
  };
}
