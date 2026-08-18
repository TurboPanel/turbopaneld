/**
 * Shared managed-engine container resolution.
 *
 * `apply.ts`, `backup.ts`, and `lifecycle.ts` all need to find the running
 * engine container for a compose project the same way — extracted here so
 * behavior (including the "not running" failure) stays identical everywhere.
 */

import type { EnvironmentDeployContainer } from "../instance/commands/contracts.ts";
import {
  type DockerCliResult,
  runDocker as defaultRunDocker,
  type RunDockerOptions,
} from "../deploy/docker-cli.ts";

type RunDockerFn = (
  args: string[],
  options?: RunDockerOptions,
) => Promise<DockerCliResult>;
import { logInfo } from "../logger.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseComposePsEntries(stdout: string): Record<string, unknown>[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return [];

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.filter(isRecord);
    }
    if (isRecord(parsed)) return [parsed];
  } catch {
    // Fall through to NDJSON.
  }

  const entries: Record<string, unknown>[] = [];
  for (const line of trimmed.split("\n")) {
    const row = line.trim();
    if (row.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(row);
      if (isRecord(parsed)) entries.push(parsed);
    } catch {
      return [];
    }
  }
  return entries;
}

/**
 * `docker compose -p <project> ps --format json` → normalized container rows.
 * Returns `undefined` (never throws) when collection itself fails — callers
 * decide whether that is fatal.
 */
export async function collectManagedContainers(
  project: string,
  redact: (text: string) => string = (text) => text,
  run: RunDockerFn = defaultRunDocker,
): Promise<EnvironmentDeployContainer[] | undefined> {
  try {
    const result = await run([
      "compose",
      "-p",
      project,
      "ps",
      "--format",
      "json",
    ]);
    if (!result.success) {
      logInfo(
        "managed",
        `managed container collect failed project=${project}: ${
          redact(result.stderr || "docker compose ps failed")
        }`,
      );
      return undefined;
    }

    const containers: EnvironmentDeployContainer[] = [];
    for (const entry of parseComposePsEntries(result.stdout)) {
      const containerId = entry.ID;
      const containerName = entry.Name;
      const service = entry.Service;
      const status = entry.State;
      if (
        typeof containerId !== "string" ||
        containerId.length === 0 ||
        typeof containerName !== "string" ||
        containerName.length === 0 ||
        typeof service !== "string" ||
        service.length === 0 ||
        typeof status !== "string" ||
        status.length === 0
      ) {
        continue;
      }
      containers.push({
        composeServiceName: service,
        containerId,
        containerName,
        status,
        role: "service",
      });
    }
    // Return all observed rows; the caller resolves the engine service.
    return containers;
  } catch (err) {
    logInfo(
      "managed",
      `managed container collect failed project=${project}: ${
        redact(err instanceof Error ? err.message : String(err))
      }`,
    );
    return undefined;
  }
}

/**
 * Resolve the running engine container id for `composeServiceName`, throwing
 * a clear typed error when the container is missing or not `running`.
 */
export function resolveEngineContainerId(
  containers: EnvironmentDeployContainer[] | undefined,
  composeServiceName: string,
): string {
  if (!containers || containers.length === 0) {
    throw new Error("managed: engine container not found");
  }
  const match = containers.find((c) =>
    c.composeServiceName === composeServiceName
  );
  const chosen = match ?? containers[0]!;
  if (chosen.status.toLowerCase() !== "running") {
    throw new Error(
      `managed: engine container is not running (status=${chosen.status})`,
    );
  }
  return chosen.containerId;
}

/**
 * Resolve the running engine container when the compose service name is
 * unknown to the caller (backup/restore only have `managedId`, not the
 * user compose document). Every managed compose project has exactly one
 * service (`normalizeManagedCompose` enforces this at apply time), so the
 * sole observed container is the engine.
 */
export function resolveSoleEngineContainer(
  containers: EnvironmentDeployContainer[] | undefined,
): EnvironmentDeployContainer {
  if (!containers || containers.length === 0) {
    throw new Error("managed: engine container is not running");
  }
  const chosen = containers[0]!;
  if (chosen.status.toLowerCase() !== "running") {
    throw new Error(
      `managed: engine container is not running (status=${chosen.status})`,
    );
  }
  return chosen;
}

/**
 * Collect a project's containers and stamp each row with `serviceId` so
 * reconcile fills the instance-allocated ingress (or other) service row.
 * Best-effort — returns `undefined` on collection failure (never throws).
 */
export async function collectManagedContainersForService(
  project: string,
  serviceId: string,
  redact: (text: string) => string = (text) => text,
  run: RunDockerFn = defaultRunDocker,
): Promise<EnvironmentDeployContainer[] | undefined> {
  const containers = await collectManagedContainers(project, redact, run);
  if (containers === undefined) return undefined;
  return containers.map((row) => ({
    ...row,
    serviceId,
    role: "ingress" as const,
  }));
}

/**
 * Collect docker compose container rows and optional replication health for a
 * member when the engine supports it. Compose collection stays engine-agnostic.
 */
export async function collectManagedMemberHealth(
  project: string,
  engine: {
    composeServiceName?: string;
    rootUsername: string;
    defaultDatabase: string;
    replication?: {
      readHealth: (
        ctx: {
          containerId: string;
          composeServiceName: string;
          rootUsername: string;
          defaultDatabase: string;
          exec: (
            argv: string[],
            input?: string,
          ) => Promise<{ success: boolean; stdout: string; stderr: string }>;
        },
        role: "primary" | "standby",
      ) => Promise<{
        state: string;
        lagBytes?: number;
        lagSeconds?: number;
        observedAt: string;
      }>;
    };
  },
  params: {
    memberId: string;
    role: "primary" | "replica";
    redact?: (text: string) => string;
  },
  run: RunDockerFn = defaultRunDocker,
): Promise<{
  containers: EnvironmentDeployContainer[] | undefined;
  member?: {
    memberId: string;
    role: "primary" | "replica";
    status: string;
    replication?: {
      state: string;
      lagBytes?: number;
      lagSeconds?: number;
      observedAt: string;
    };
  };
}> {
  const containers = await collectManagedContainers(project, params.redact, run);
  if (!containers || !engine.replication) {
    return { containers };
  }
  try {
    const containerId = resolveEngineContainerId(
      containers,
      containers[0]!.composeServiceName,
    );
    const health = await engine.replication.readHealth(
      {
        containerId,
        composeServiceName: containers[0]!.composeServiceName,
        rootUsername: engine.rootUsername,
        defaultDatabase: engine.defaultDatabase,
        exec: async (argv, input) => {
          const result = await run(
            ["exec", "-i", containerId, ...argv],
            input === undefined ? undefined : { input },
          );
          const redact = params.redact ?? ((text: string) => text);
          return {
            success: result.success,
            stdout: result.stdout,
            stderr: redact(result.stderr),
          };
        },
      },
      params.role === "primary" ? "primary" : "standby",
    );
    return {
      containers,
      member: {
        memberId: params.memberId,
        role: params.role,
        status: "ready",
        replication: health,
      },
    };
  } catch {
    return { containers };
  }
}
