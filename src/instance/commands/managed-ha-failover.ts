/**
 * `managed.ha.failover` — ProxySQL drain or designated Orchestrator recover.
 *
 * Drain is fail-closed for automatic failover (control plane still decides).
 * Recover talks to local Orchestrator; when the HA stack is absent **or**
 * designated recover fails, it falls back to `managed.promote`.
 */

import type {
  ManagedHaFailoverPayload,
  ManagedHaFailoverResult,
} from "./contracts.ts";
import { parseManagedHaFailoverPayload } from "./contracts.ts";
import { handleManagedPromote } from "../../managed/promote.ts";
import { applyProxySqlAdminStatements } from "../../managed/proxysql-admin.ts";
import { buildProxySqlDrainStatements } from "../../managed/proxysql.ts";
import {
  hostPrepPresent,
  loadOrchestratorApiCredentials,
} from "../../managed/orchestrator.ts";
import {
  type OrchestratorRecoverTarget,
  recoverToCandidate,
} from "../../managed/orchestrator-api.ts";
import {
  readSystemComponentDescriptor,
  SYSTEM_MANAGED_INGRESS_COMPONENT,
} from "../../deploy/system-component.ts";
import { logInfo, logWarn } from "../../logger.ts";
import { resolveLayout } from "../../paths/layout.ts";

export type ManagedHaFailoverHandlerDeps = {
  decryptSecrets?: (ciphertexts: string[]) => Promise<(string | null)[]>;
  drain?: (
    hostname: string,
    port: number,
  ) => Promise<void>;
  recover?: typeof recoverToCandidate;
  promote?: typeof handleManagedPromote;
  /** Test seam — defaults to {@link hostPrepPresent}. */
  haPresent?: () => Promise<boolean>;
};

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
  return error instanceof Error ? error.message : String(error);
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

async function recoverWithOrchestrator(
  payload: ManagedHaFailoverPayload,
  endpoints: OrchestratorRecoverTarget,
  daemonReceivedAt: string,
  deps: ManagedHaFailoverHandlerDeps | undefined,
): Promise<ManagedHaFailoverResult> {
  try {
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
