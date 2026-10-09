/**
 * `managed.ha.failover` — ProxySQL drain, designated Orchestrator recover,
 * or replica repoint after promotion.
 *
 * Drain is fail-closed for automatic failover (control plane still decides).
 * Recover talks to local Orchestrator; when the HA stack is absent **or**
 * designated recover fails, it falls back to `managed.promote`.
 * Repoint runs on every other healthy replica so `primary_conninfo` /
 * replication source follows the new primary (without a full Resync).
 */

import type {
  ManagedHaFailoverPayload,
  ManagedHaFailoverResult,
} from "../contracts/commands-contracts.ts";
import { parseManagedHaFailoverPayload } from "../contracts/commands-contracts.ts";
import { handleManagedPromote } from "../managed/promote.ts";
import { proveSwitchoverGtidBeforePromote } from "../managed/switchover-gtid-proof.ts";
import {
  ensureLocalPrimarySlots,
  followLocalStandby,
  type FollowPrimaryDeps,
} from "../managed/follow-primary.ts";
import { applyProxySqlAdminStatements } from "../managed/proxysql-admin.ts";
import {
  buildProxySqlDrainStatements,
  buildProxySqlUndrainStatements,
} from "../managed/proxysql.ts";
import {
  hostPrepPresent,
  loadOrchestratorApiCredentials,
} from "../managed/orchestrator.ts";
import {
  type OrchestratorRecoverTarget,
  recoverToCandidate,
} from "../managed/orchestrator-api.ts";
import {
  readSystemComponentDescriptor,
  SYSTEM_MANAGED_INGRESS_COMPONENT,
} from "../deploy/system-component.ts";
import { logInfo, logWarn } from "../util/logger.ts";
import { resolveLayout } from "../paths/layout.ts";

export type ManagedHaFailoverHandlerDeps = {
  decryptSecrets?: (ciphertexts: string[]) => Promise<(string | null)[]>;
  drain?: (
    hostname: string,
    port: number,
  ) => Promise<void>;
  undrain?: (
    hostname: string,
    port: number,
  ) => Promise<void>;
  proveGtid?: typeof proveSwitchoverGtidBeforePromote;
  recover?: typeof recoverToCandidate;
  promote?: typeof handleManagedPromote;
  follow?: typeof followLocalStandby;
  ensurePrimarySlots?: typeof ensureLocalPrimarySlots;
  /** Test seam — defaults to {@link hostPrepPresent}. */
  haPresent?: () => Promise<boolean>;
  followDeps?: FollowPrimaryDeps;
};

async function undrainWriterOnLocalProxySql(
  hostname: string,
  port: number,
): Promise<void> {
  const layout = resolveLayout();
  const descriptor = await readSystemComponentDescriptor(
    layout,
    SYSTEM_MANAGED_INGRESS_COMPONENT,
  );
  if (!descriptor) return;
  await applyProxySqlAdminStatements(
    buildProxySqlUndrainStatements(hostname, port),
    {
      layout,
      containerName: descriptor.containerName,
    },
  );
}

async function drainWriterOnLocalProxySql(
  hostname: string,
  port: number,
): Promise<void> {
  const layout = resolveLayout();
  const descriptor = await readSystemComponentDescriptor(
    layout,
    SYSTEM_MANAGED_INGRESS_COMPONENT,
  );
  if (!descriptor) return;
  await applyProxySqlAdminStatements(
    buildProxySqlDrainStatements(hostname, port),
    {
      layout,
      containerName: descriptor.containerName,
    },
  );
}

function recoverEndpoints(
  payload: ManagedHaFailoverPayload,
): OrchestratorRecoverTarget | undefined {
  const { sourceHost, sourcePort, targetHost, targetPort } = payload;
  if (!sourceHost || sourcePort === undefined) return undefined;
  if (!targetHost || targetPort === undefined) return undefined;
  return { sourceHost, sourcePort, targetHost, targetPort };
}

function recoverFailureMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? "unknown error";
  } catch {
    return "unknown error";
  }
}

async function promoteWithoutOrchestrator(
  payload: ManagedHaFailoverPayload,
  daemonReceivedAt: string,
  deps: ManagedHaFailoverHandlerDeps | undefined,
  reason: "absent" | "recover-failed",
): Promise<ManagedHaFailoverResult> {
  const promote = deps?.promote ?? handleManagedPromote;
  await promote(
    {
      managedId: payload.managedId,
      memberId: payload.targetMemberId,
      demoteMemberId: payload.sourceMemberId,
      ...(payload.engine ? { engine: payload.engine } : {}),
      ...(payload.requiredExecutedGtidSet
        ? { requiredExecutedGtidSet: payload.requiredExecutedGtidSet }
        : {}),
      ...(payload.gtidWaitTimeoutSeconds !== undefined
        ? { gtidWaitTimeoutSeconds: payload.gtidWaitTimeoutSeconds }
        : {}),
    },
    daemonReceivedAt,
    { decryptSecrets: deps?.decryptSecrets },
  );
  const suffix = reason === "recover-failed"
    ? "after Orchestrator recover failure"
    : "without Orchestrator";
  logInfo(
    "commands",
    `managed.ha.failover recover fell back to promote managedId=${payload.managedId} ${suffix} received=${daemonReceivedAt}`,
  );
  return {
    summary: `promoted managed ${payload.managedId} ${suffix}`,
    phase: "recover",
  };
}

function repointHasEnsureSlots(payload: ManagedHaFailoverPayload): boolean {
  return (payload.ensureSlots?.length ?? 0) > 0;
}

async function handleEnsureSlotsRepoint(
  payload: ManagedHaFailoverPayload,
  daemonReceivedAt: string,
  deps: ManagedHaFailoverHandlerDeps | undefined,
): Promise<ManagedHaFailoverResult> {
  const ensure = deps?.ensurePrimarySlots ?? ensureLocalPrimarySlots;
  await ensure(
    {
      managedId: payload.managedId,
      ...(payload.engine ? { engine: payload.engine } : {}),
      slots: payload.ensureSlots ?? [],
    },
    deps?.followDeps,
  );
  logInfo(
    "commands",
    `managed.ha.failover repoint slots ensured managedId=${payload.managedId} received=${daemonReceivedAt}`,
  );
  return {
    summary: `slots ensured for managed ${payload.managedId}`,
    phase: "repoint",
  };
}

async function handleFollowRepoint(
  payload: ManagedHaFailoverPayload,
  daemonReceivedAt: string,
  deps: ManagedHaFailoverHandlerDeps | undefined,
): Promise<ManagedHaFailoverResult> {
  if (!payload.targetHost || payload.targetPort === undefined) {
    throw new Error(
      "managed.ha.failover repoint requires targetHost and targetPort",
    );
  }
  const follow = deps?.follow ?? followLocalStandby;
  await follow(
    {
      managedId: payload.managedId,
      ...(payload.engine ? { engine: payload.engine } : {}),
      primary: {
        host: payload.targetHost,
        port: payload.targetPort,
        ...(payload.targetHostaddr ? { hostaddr: payload.targetHostaddr } : {}),
      },
    },
    deps?.followDeps,
  );
  logInfo(
    "commands",
    `managed.ha.failover repoint completed managedId=${payload.managedId} received=${daemonReceivedAt}`,
  );
  return {
    summary:
      `repointed replica for managed ${payload.managedId} at the new primary`,
    phase: "repoint",
  };
}

async function handleRepointPhase(
  payload: ManagedHaFailoverPayload,
  daemonReceivedAt: string,
  deps: ManagedHaFailoverHandlerDeps | undefined,
): Promise<ManagedHaFailoverResult> {
  if (repointHasEnsureSlots(payload)) {
    return await handleEnsureSlotsRepoint(payload, daemonReceivedAt, deps);
  }
  return await handleFollowRepoint(payload, daemonReceivedAt, deps);
}

async function handleDrainPhase(
  payload: ManagedHaFailoverPayload,
  daemonReceivedAt: string,
  deps: ManagedHaFailoverHandlerDeps | undefined,
): Promise<ManagedHaFailoverResult> {
  if (payload.sourceHost && payload.sourcePort !== undefined) {
    const drain = deps?.drain ?? drainWriterOnLocalProxySql;
    await drain(payload.sourceHost, payload.sourcePort);
  }
  logInfo(
    "commands",
    `managed.ha.failover drain completed managedId=${payload.managedId} received=${daemonReceivedAt}`,
  );
  return {
    summary: `drained writer for managed ${payload.managedId}`,
    phase: "drain",
  };
}

async function handleUndrainPhase(
  payload: ManagedHaFailoverPayload,
  daemonReceivedAt: string,
  deps: ManagedHaFailoverHandlerDeps | undefined,
): Promise<ManagedHaFailoverResult> {
  if (payload.sourceHost && payload.sourcePort !== undefined) {
    const undrain = deps?.undrain ?? undrainWriterOnLocalProxySql;
    await undrain(payload.sourceHost, payload.sourcePort);
  }
  logInfo(
    "commands",
    `managed.ha.failover undrain completed managedId=${payload.managedId} received=${daemonReceivedAt}`,
  );
  return {
    summary: `restored writer routing for managed ${payload.managedId}`,
    phase: "undrain",
  };
}

async function proveSwitchoverGtidIfRequired(
  payload: ManagedHaFailoverPayload,
  deps: ManagedHaFailoverHandlerDeps | undefined,
): Promise<void> {
  if (!payload.requiredExecutedGtidSet) return;
  const prove = deps?.proveGtid ?? proveSwitchoverGtidBeforePromote;
  await prove(
    {
      managedId: payload.managedId,
      ...(payload.engine ? { engine: payload.engine } : {}),
      requiredExecutedGtidSet: payload.requiredExecutedGtidSet,
      ...(payload.gtidWaitTimeoutSeconds !== undefined
        ? { gtidWaitTimeoutSeconds: payload.gtidWaitTimeoutSeconds }
        : {}),
    },
  );
}

async function recoverWithOrchestrator(
  payload: ManagedHaFailoverPayload,
  endpoints: OrchestratorRecoverTarget,
  daemonReceivedAt: string,
  deps: ManagedHaFailoverHandlerDeps | undefined,
): Promise<ManagedHaFailoverResult> {
  try {
    await proveSwitchoverGtidIfRequired(payload, deps);
    const recover = deps?.recover ?? recoverToCandidate;
    const credentials = deps?.recover
      ? undefined
      : await loadOrchestratorApiCredentials(resolveLayout());
    await recover(endpoints, credentials ? { credentials } : {});
    logInfo(
      "commands",
      `managed.ha.failover recover completed managedId=${payload.managedId} received=${daemonReceivedAt}`,
    );
    return {
      summary: `recovered managed ${payload.managedId} onto designated replica`,
      phase: "recover",
    };
  } catch (error) {
    logWarn(
      "commands",
      `managed.ha.failover orchestrator recover failed managedId=${payload.managedId}: ${
        recoverFailureMessage(error)
      }`,
    );
    return await promoteWithoutOrchestrator(
      payload,
      daemonReceivedAt,
      deps,
      "recover-failed",
    );
  }
}

export async function handleManagedHaFailover(
  rawPayload: unknown,
  daemonReceivedAt: string,
  deps?: ManagedHaFailoverHandlerDeps,
): Promise<ManagedHaFailoverResult> {
  const payload = parseManagedHaFailoverPayload(rawPayload);
  if (payload.phase === "drain") {
    return await handleDrainPhase(payload, daemonReceivedAt, deps);
  }
  if (payload.phase === "undrain") {
    return await handleUndrainPhase(payload, daemonReceivedAt, deps);
  }
  if (payload.phase === "repoint") {
    return await handleRepointPhase(payload, daemonReceivedAt, deps);
  }

  const haPresent = deps?.haPresent
    ? await deps.haPresent()
    : await hostPrepPresent(resolveLayout());
  const endpoints = recoverEndpoints(payload);
  if (haPresent && endpoints) {
    return await recoverWithOrchestrator(
      payload,
      endpoints,
      daemonReceivedAt,
      deps,
    );
  }

  return await promoteWithoutOrchestrator(
    payload,
    daemonReceivedAt,
    deps,
    "absent",
  );
}
