/**
 * Map an Orchestrator instance key to the managed cluster id on this host.
 *
 * Orchestrator's cluster alias is normally the managed UUID
 * (`set-cluster-alias`), but that call is best-effort and may fail on some
 * builds — fall back to the local primary's published private listener.
 */

import type { LayoutPaths } from "../paths/layout.ts";
import { forEachSequential } from "../util/sequential.ts";
import {
  resolveOrchestratorRegisterHost,
  type RunDockerFn,
} from "./orchestrator.ts";
import { isManagedMemberDestroyed } from "./destroyed-marker.ts";
import { isIntentLookupActive, lookupManagedIntent } from "./ha-intent.ts";
import { listManagedHaMembers, readManagedHaMember } from "./ha-member.ts";
import {
  readSwitchoverPromoteLocalMarker,
  readSwitchoverQuiescedMarker,
} from "./switchover-state-marker.ts";

const MANAGED_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ENGINE_CONTAINER_PORT: Partial<Record<string, number>> = {
  mysql: 3306,
  mariadb: 3306,
};

export type OrchestratorInstanceKey = {
  hostname: string;
  port: number;
};

export function orchestratorClusterAliasManagedId(
  clusterAlias: string | undefined,
): string | null {
  if (!clusterAlias || !MANAGED_ID_RE.test(clusterAlias)) return null;
  return clusterAlias;
}

/** Stable per-incident dedupe identity for one dead primary. */
export function orchestratorIncidentPrimaryKey(
  key: OrchestratorInstanceKey,
): string {
  return `${key.hostname.toLowerCase()}:${key.port}`;
}

/** Every provided Orchestrator key field must match the local primary dial. */
export function orchestratorKeysMatch(
  analyzed: { hostname?: string; port?: number },
  dial: OrchestratorInstanceKey,
): boolean {
  const { hostname, port } = analyzed;
  if (hostname === undefined && port === undefined) return true;
  if (hostname !== undefined && hostname !== dial.hostname) return false;
  if (port !== undefined && port !== dial.port) return false;
  return true;
}

export async function resolveLocalPrimaryOrchestratorDial(
  layout: LayoutPaths,
  managedId: string,
  run: RunDockerFn,
): Promise<OrchestratorInstanceKey | null> {
  const record = await readManagedHaMember(layout, managedId);
  if (record?.role !== "primary") return null;
  const containerPort = ENGINE_CONTAINER_PORT[record.engine];
  if (containerPort === undefined) return null;
  try {
    const dial = await resolveOrchestratorRegisterHost(
      {
        host: record.containerName,
        port: containerPort,
        containerName: record.containerName,
      },
      run,
    );
    return { hostname: dial.host, port: dial.port };
  } catch {
    return null;
  }
}

async function managedIdForAnalyzedDial(
  layout: LayoutPaths,
  key: OrchestratorInstanceKey,
  run: RunDockerFn,
): Promise<string | null> {
  const members = await listManagedHaMembers(layout);
  let matched: string | null = null;
  await forEachSequential(members, async (record) => {
    if (matched !== null) return;
    if (record.role !== "primary") return;
    const dial = await resolveLocalPrimaryOrchestratorDial(
      layout,
      record.managedId,
      run,
    );
    if (
      dial?.hostname === key.hostname &&
      dial?.port === key.port
    ) {
      matched = record.managedId;
    }
  });
  return matched;
}

export async function isOrchestratorHaEmitSuppressed(
  layout: LayoutPaths,
  managedId: string,
  nowMs: number,
): Promise<boolean> {
  const record = await readManagedHaMember(layout, managedId);
  if (record?.role !== "primary") return true;
  if (
    await isManagedMemberDestroyed(
      layout.stateDir,
      managedId,
      record.memberId,
    )
  ) {
    return true;
  }
  const intent = await lookupManagedIntent(layout.stateDir, managedId);
  if (isIntentLookupActive(intent, nowMs)) return true;
  if (await readSwitchoverQuiescedMarker(layout, managedId)) return true;
  const promoteLocal = await readSwitchoverPromoteLocalMarker(
    layout,
    managedId,
  );
  return promoteLocal?.phase === "started";
}

export type OrchestratorDeadPrimaryEmitContext = {
  managedId: string;
  incidentKey: string;
  emitKey: { hostname?: string; port?: number };
};

/**
 * Resolve a dead-primary Orchestrator row to a local cluster and listener proof.
 * Returns null when the cluster is gone, suppressed, or the key does not match
 * this host's primary dial.
 */
export async function resolveOrchestratorDeadPrimaryEmit(
  layout: LayoutPaths,
  analyzedKey: { hostname?: string; port?: number },
  clusterAlias: string | undefined,
  run: RunDockerFn,
  nowMs: number,
): Promise<OrchestratorDeadPrimaryEmitContext | null> {
  const aliasId = orchestratorClusterAliasManagedId(clusterAlias);
  const analyzedHost = analyzedKey.hostname;
  const analyzedPort = analyzedKey.port;
  const hasFullKey = analyzedHost !== undefined && analyzedPort !== undefined;
  let managedId: string | null = null;

  if (hasFullKey) {
    const byDial = await managedIdForAnalyzedDial(
      layout,
      { hostname: analyzedHost, port: analyzedPort },
      run,
    );
    if (byDial != null && aliasId != null && byDial !== aliasId) return null;
    managedId = byDial ?? aliasId;
  } else if (aliasId) {
    managedId = aliasId;
  }

  if (!managedId) return null;
  if (await isOrchestratorHaEmitSuppressed(layout, managedId, nowMs)) {
    return null;
  }

  const dial = await resolveLocalPrimaryOrchestratorDial(
    layout,
    managedId,
    run,
  );
  if (!dial) return null;
  if (!orchestratorKeysMatch(analyzedKey, dial)) return null;

  const incidentKey = `${managedId}:${orchestratorIncidentPrimaryKey(dial)}`;
  const analyzedKeyEmpty = analyzedHost === undefined &&
    analyzedPort === undefined;
  const partialKeyVerified = !hasFullKey && !analyzedKeyEmpty;
  const proveEmitFromLocalDial = analyzedKeyEmpty ||
    hasFullKey ||
    (aliasId != null && partialKeyVerified);
  const emitKey = proveEmitFromLocalDial
    ? { hostname: dial.hostname, port: dial.port }
    : {};
  return { managedId, incidentKey, emitKey };
}

export async function resolveManagedIdForOrchestratorInstance(
  layout: LayoutPaths,
  key: { hostname: string; port: number },
  clusterAlias: string | undefined,
  run: RunDockerFn,
): Promise<string | null> {
  const ctx = await resolveOrchestratorDeadPrimaryEmit(
    layout,
    key,
    clusterAlias,
    run,
    Date.now(),
  );
  return ctx?.managedId ?? null;
}
