/**
 * Managed engine lifecycle: start / stop / restart.
 *
 * Status in the result is derived from observed `docker compose ps` state —
 * never from the requested action.
 */

import type {
  EnvironmentDeployContainer,
  ManagedLifecyclePayload,
  ManagedLifecycleResult,
} from "../instance/commands/contracts.ts";
import {
  type DockerCliResult,
  runDocker as defaultRunDocker,
  type RunDockerOptions,
} from "../deploy/docker-cli.ts";
import { sanitizeForLog } from "../logger.ts";
import { resolveLayout } from "../paths/layout.ts";
import {
  managedComposeProject,
  managedDir,
  managedIngressComposePath,
  managedIngressProject,
  SAFE_MANAGED_ID_RE,
} from "./paths.ts";

type DecryptSecretsFn = (ciphertexts: string[]) => Promise<(string | null)[]>;
type RunDockerFn = (
  args: string[],
  options?: RunDockerOptions,
) => Promise<DockerCliResult>;

export type ManagedLifecycleHandlerDeps = {
  decryptSecrets?: DecryptSecretsFn;
  /** Test seam — defaults to {@link defaultRunDocker}. */
  runDocker?: RunDockerFn;
};

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

async function pathExists(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    return stat.isDirectory || stat.isFile;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

async function collectContainers(
  project: string,
  run: RunDockerFn = defaultRunDocker,
): Promise<EnvironmentDeployContainer[]> {
  const result = await run([
    "compose",
    "-p",
    project,
    "ps",
    "-a",
    "--format",
    "json",
  ]);
  if (!result.success) return [];

  const containers: EnvironmentDeployContainer[] = [];
  for (const entry of parseComposePsEntries(result.stdout)) {
    const containerId = entry.ID;
    const containerName = entry.Name;
    const composeServiceName = entry.Service;
    const status = entry.State;
    if (
      typeof containerId !== "string" ||
      containerId.length === 0 ||
      typeof containerName !== "string" ||
      containerName.length === 0 ||
      typeof composeServiceName !== "string" ||
      composeServiceName.length === 0 ||
      typeof status !== "string" ||
      status.length === 0
    ) {
      continue;
    }
    containers.push({
      composeServiceName,
      containerId,
      containerName,
      status,
    });
  }
  return containers;
}

function statusFromContainers(
  containers: EnvironmentDeployContainer[],
): "ready" | "stopped" | "failed" {
  if (containers.length === 0) return "stopped";
  const states = containers.map((c) => c.status.toLowerCase());
  if (states.every((s) => s === "running")) return "ready";
  if (states.every((s) => s === "exited" || s === "dead" || s === "stopped")) {
    return "stopped";
  }
  if (states.includes("running")) return "ready";
  return "failed";
}

export async function handleManagedLifecycle(
  payload: ManagedLifecyclePayload,
  _daemonReceivedAt: string,
  deps?: ManagedLifecycleHandlerDeps,
): Promise<ManagedLifecycleResult> {
  if (!SAFE_MANAGED_ID_RE.test(payload.managedId)) {
    throw new Error("managedId contains unsupported characters");
  }

  const run = deps?.runDocker ?? defaultRunDocker;
  const layout = resolveLayout(Deno.env.toObject());
  const root = managedDir(layout, payload.managedId);
  if (!(await pathExists(root))) {
    return {
      status: "stopped",
      summary: "managed state absent — idempotent no-op",
    };
  }

  const project = managedComposeProject(payload.managedId);
  // Project-scoped only — no `-f`, so compose does not interpolate the
  // removed TURBOPANEL_MANAGED_ROOT_PASSWORD env-file variable.
  const result = await run([
    "compose",
    "-p",
    project,
    payload.action,
  ]);
  if (!result.success) {
    throw new Error(
      `managed.lifecycle ${payload.action} failed: ${
        sanitizeForLog(result.stderr || "compose failed")
      }`,
    );
  }

  // Active only while compose exists — removeManagedIngress deletes this path
  // when exposure is disabled so start/restart cannot revive stale Traefik.
  const ingressCompose = managedIngressComposePath(layout, payload.managedId);
  if (await pathExists(ingressCompose)) {
    const ingressProject = managedIngressProject(payload.managedId);
    const ingressResult = await run([
      "compose",
      "-p",
      ingressProject,
      "-f",
      ingressCompose,
      payload.action,
    ]);
    if (!ingressResult.success) {
      throw new Error(
        `managed.lifecycle ${payload.action} ingress failed: ${
          sanitizeForLog(ingressResult.stderr || "compose failed")
        }`,
      );
    }
  }

  // Status is derived from the engine project only — ingress is sidecar.
  const containers = await collectContainers(project, run);
  const status = statusFromContainers(containers);
  return {
    status,
    summary: `managed ${payload.action} observed status=${status}`,
  };
}
