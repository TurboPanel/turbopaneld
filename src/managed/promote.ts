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
  parseSwitchoverPromoteFailureCode,
  switchoverCaughtErrorDetail,
} from "./engines/switchover-promote-error.ts";
import {
  type LocalEngineContextDeps,
  resolveLocalReplicationEngine,
} from "./local-engine-context.ts";
import { proveSwitchoverGtidBeforePromote } from "./switchover-gtid-proof.ts";
import { writeSwitchoverPromoteLocalMarker } from "./switchover-state-marker.ts";

type DecryptSecretsFn = (ciphertexts: string[]) => Promise<(string | null)[]>;

export type ManagedPromoteHandlerDeps = LocalEngineContextDeps & {
  decryptSecrets?: DecryptSecretsFn;
};

export async function handleManagedPromote(
  payload: ManagedPromotePayload,
  _daemonReceivedAt: string,
  deps?: ManagedPromoteHandlerDeps,
): Promise<ManagedPromoteResult> {
  const layout = resolveLayout(Deno.env.toObject());
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
  const requiredGtidSet = payload.requiredExecutedGtidSet;
  const switchoverPromote = requiredGtidSet !== undefined;
  try {
    if (switchoverPromote) {
      await proveSwitchoverGtidBeforePromote(
        {
          managedId: payload.managedId,
          engine: payload.engine,
          requiredExecutedGtidSet: requiredGtidSet,
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
  } catch (error) {
    if (switchoverPromote) {
      const code = parseSwitchoverPromoteFailureCode(
        switchoverCaughtErrorDetail(error),
      );
      if (code === "promote_started") {
        await writeSwitchoverPromoteLocalMarker(
          layout,
          payload.managedId,
          "started",
          new Date().toISOString(),
        );
      }
    }
    throw error;
  }
  if (switchoverPromote) {
    await writeSwitchoverPromoteLocalMarker(
      layout,
      payload.managedId,
      "completed",
      new Date().toISOString(),
    );
  }
  await clearManagedDemotedMarker(layout, payload.managedId);
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
