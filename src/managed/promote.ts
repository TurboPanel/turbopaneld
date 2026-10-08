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

  await engine.replication!.promote(ctx);
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
