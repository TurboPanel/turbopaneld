/**
 * Map an Orchestrator instance key to the managed cluster id on this host.
 *
 * Orchestrator's cluster alias is normally the managed UUID
 * (`set-cluster-alias`), but that call is best-effort and may fail on some
 * builds — fall back to the local primary's published private listener.
 */

import type { LayoutPaths } from "../paths/layout.ts";
import {
  resolveOrchestratorRegisterHost,
  type RunDockerFn,
} from "./orchestrator.ts";
import { listManagedHaMembers } from "./ha-member.ts";

const MANAGED_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ENGINE_CONTAINER_PORT: Partial<Record<string, number>> = {
  mysql: 3306,
  mariadb: 3306,
};

export function orchestratorClusterAliasManagedId(
  clusterAlias: string | undefined,
): string | null {
  if (!clusterAlias || !MANAGED_ID_RE.test(clusterAlias)) return null;
  return clusterAlias;
}

export async function resolveManagedIdForOrchestratorInstance(
  layout: LayoutPaths,
  key: { hostname: string; port: number },
  clusterAlias: string | undefined,
  run: RunDockerFn,
): Promise<string | null> {
  const fromAlias = orchestratorClusterAliasManagedId(clusterAlias);
  if (fromAlias) return fromAlias;

  const members = await listManagedHaMembers(layout);
  for (const record of members) {
    if (record.role !== "primary") continue;
    const containerPort = ENGINE_CONTAINER_PORT[record.engine];
    if (containerPort === undefined) continue;
    let dial: { host: string; port: number };
    try {
      dial = await resolveOrchestratorRegisterHost(
        {
          host: record.containerName,
          port: containerPort,
          containerName: record.containerName,
        },
        run,
      );
    } catch {
      continue;
    }
    if (dial.host === key.hostname && dial.port === key.port) {
      return record.managedId;
    }
  }
  return null;
}
