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
  collectManagedContainers,
  collectManagedMemberHealth,
} from "./containers.ts";
import { getManagedEngineRuntime } from "./engines/index.ts";
import {
  managedComposeProject,
  managedDir,
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

async function pathExists(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    return stat.isDirectory || stat.isFile;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
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

  if (payload.memberId) {
    const engine = getManagedEngineRuntime(payload.engine ?? "postgres");
    const collected = await collectManagedMemberHealth(project, engine, {
      memberId: payload.memberId,
      role: "primary",
      redact: (text) => sanitizeForLog(text),
    }, run);
    const containers = collected.containers ?? [];
    const status = statusFromContainers(containers);
    return {
      status,
      summary: `managed ${payload.action} observed status=${status}`,
      ...(collected.member !== undefined ? { member: collected.member } : {}),
    };
  }

  const containers =
    (await collectManagedContainers(project, (text) => sanitizeForLog(text), run)) ??
      [];
  const status = statusFromContainers(containers);
  return {
    status,
    summary: `managed ${payload.action} observed status=${status}`,
  };
}
