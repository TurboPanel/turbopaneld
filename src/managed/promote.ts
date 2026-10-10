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
import {
  clearManagedDemotionArtifacts,
  isManagedMemberDemoted,
} from "./demoted-marker.ts";
import { withManagedLifecycleLock } from "./target-lock.ts";
import { runDocker as defaultRunDocker } from "../deploy/docker-cli.ts";
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

function switchoverGtidProofInput(
  payload: ManagedPromotePayload,
): {
  managedId: string;
  engine: ManagedPromotePayload["engine"];
  requiredExecutedGtidSet: string;
  gtidWaitTimeoutSeconds?: number;
} {
  const input = {
    managedId: payload.managedId,
    engine: payload.engine,
    requiredExecutedGtidSet: payload.requiredExecutedGtidSet!,
  };
  return payload.gtidWaitTimeoutSeconds === undefined
    ? input
    : { ...input, gtidWaitTimeoutSeconds: payload.gtidWaitTimeoutSeconds };
}

async function recordSwitchoverPromoteStartedOnFailure(
  layout: ReturnType<typeof resolveLayout>,
  payload: ManagedPromotePayload,
  error: unknown,
): Promise<void> {
  const code = parseSwitchoverPromoteFailureCode(
    switchoverCaughtErrorDetail(error),
  );
  if (code !== "promote_started") return;
  await writeSwitchoverPromoteLocalMarker(
    layout,
    payload.managedId,
    "started",
    new Date().toISOString(),
  );
}

export async function handleManagedPromote(
  payload: ManagedPromotePayload,
  _daemonReceivedAt: string,
  deps?: ManagedPromoteHandlerDeps,
): Promise<ManagedPromoteResult> {
  const layout = resolveLayout(Deno.env.toObject());
  if (!(await isManagedMemberDemoted(layout, payload.managedId))) {
    return await promoteManagedMember(payload, layout, deps);
  }
  // A marked member is writable between promote and the marker clear; hold
  // the lock the demoted guard takes so it cannot stop the new primary.
  return await withManagedLifecycleLock(
    layout,
    payload.managedId,
    () => promoteManagedMember(payload, layout, deps),
  );
}

async function promoteManagedMember(
  payload: ManagedPromotePayload,
  layout: ReturnType<typeof resolveLayout>,
  deps: ManagedPromoteHandlerDeps | undefined,
): Promise<ManagedPromoteResult> {
  const { engine, ctx } = await resolveLocalReplicationEngine(
    payload.managedId,
    payload.engine,
    "managed.promote",
    deps,
  );

  const switchoverPromote = payload.requiredExecutedGtidSet !== undefined;
  try {
    if (switchoverPromote) {
      await proveSwitchoverGtidBeforePromote(
        switchoverGtidProofInput(payload),
        deps,
      );
      await engine.replication!.promote(ctx, {
        ...(payload.gtidWaitTimeoutSeconds !== undefined
          ? { gtidWaitTimeoutSeconds: payload.gtidWaitTimeoutSeconds }
          : {}),
      });
    } else {
      await engine.replication!.promote(ctx, undefined);
    }
  } catch (error) {
    if (switchoverPromote) {
      await recordSwitchoverPromoteStartedOnFailure(layout, payload, error);
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
  const run = deps?.runDocker ?? defaultRunDocker;
  await clearManagedDemotionArtifacts(layout, payload.managedId, {
    engine: payload.engine,
    run: (args) => run(args),
  });
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
