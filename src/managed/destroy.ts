/**
 * Managed engine destroy: compose down + leftover container sweep + state dir
 * removal. Compose down is project-scoped only (no `-f`) so interpolation of
 * the removed `TURBOPANEL_MANAGED_ROOT_PASSWORD` env-file cannot fail the
 * teardown — same rule as lifecycle.
 */

import type {
  ManagedDestroyPayload,
  ManagedDestroyResult,
} from "../instance/commands/contracts.ts";
import {
  type DockerCliResult,
  runDocker as defaultRunDocker,
  type RunDockerOptions,
} from "../deploy/docker-cli.ts";
import { logInfo, sanitizeForLog } from "../logger.ts";
import { resolveLayout } from "../paths/layout.ts";
import { removeManagedPublicFirewallBestEffort } from "./firewall.ts";
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

export type ManagedDestroyHandlerDeps = {
  decryptSecrets?: DecryptSecretsFn;
  /** Test seam — defaults to {@link defaultRunDocker}. */
  runDocker?: RunDockerFn;
};

const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";
const SAFE_CONTAINER_ID_RE = /^[a-f0-9]{12,64}$/i;

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

function parseContainerIds(stdout: string): string[] {
  return stdout
    .trim()
    .split(/\s+/)
    .filter((id) => SAFE_CONTAINER_ID_RE.test(id));
}

async function listComposeProjectContainerIds(
  run: RunDockerFn,
  project: string,
): Promise<string[] | null> {
  const listed = await run([
    "ps",
    "-aq",
    "--filter",
    `label=${COMPOSE_PROJECT_LABEL}=${project}`,
  ]);
  if (!listed.success) return null;
  return parseContainerIds(listed.stdout);
}

async function forceRemoveContainers(
  run: RunDockerFn,
  ids: string[],
): Promise<boolean> {
  if (ids.length === 0) return true;
  const removed = await run(["rm", "-f", ...ids]);
  return removed.success;
}

async function tearDownManagedCompose(
  run: RunDockerFn,
  project: string,
  removeVolumes: boolean,
): Promise<void> {
  const downArgs = ["compose", "-p", project, "down", "--remove-orphans"];
  if (removeVolumes) downArgs.push("--volumes");
  const down = await run(downArgs);
  if (!down.success) {
    logInfo(
      "managed",
      `managed.destroy compose down failed project=${project}: ${
        sanitizeForLog(down.stderr || "compose down failed")
      }`,
    );
  }

  let remaining = await listComposeProjectContainerIds(run, project);
  if (remaining === null) {
    if (!down.success) {
      throw new Error(
        `managed.destroy compose down failed: ${
          sanitizeForLog(down.stderr || "compose down failed")
        }`,
      );
    }
    await removeManagedDataVolumeBestEffort(run, project, removeVolumes);
    return;
  }
  if (remaining.length > 0) {
    await forceRemoveContainers(run, remaining);
    remaining = await listComposeProjectContainerIds(run, project) ?? remaining;
  }
  if (remaining.length > 0) {
    throw new Error(
      `managed.destroy left ${remaining.length} container(s) for project ${project}`,
    );
  }
  await removeManagedDataVolumeBestEffort(run, project, removeVolumes);
}

/**
 * Best-effort removal of the engine data volume by its exact pinned name
 * (`managed_<id>_data`). `compose down --volumes` only removes volumes
 * labeled with the project, which misses (a) orphan bare-name volumes that
 * pre-pin `bootstrapStandby` throwaway containers auto-created via
 * `docker run -v`, and (b) nothing must survive a removeVolumes destroy —
 * a leftover data volume makes the next standby seed misread stale state.
 */
async function removeManagedDataVolumeBestEffort(
  run: RunDockerFn,
  managedId: string,
  removeVolumes: boolean,
): Promise<void> {
  if (!removeVolumes) return;
  const volumeName = `managed_${managedId.replaceAll("-", "_")}_data`;
  const removed = await run(["volume", "rm", "-f", volumeName]);
  if (!removed.success) {
    const text = (removed.stderr || "").toLowerCase();
    if (!text.includes("no such volume")) {
      logInfo(
        "managed",
        `managed.destroy data volume remove failed name=${volumeName}: ${
          sanitizeForLog(removed.stderr || "volume rm failed")
        }`,
      );
    }
  }
}

async function removeManagedStateDir(root: string): Promise<void> {
  try {
    await Deno.remove(root, { recursive: true });
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      throw new TypeError(
        `failed to remove managed state dir: ${sanitizeForLog(err)}`,
      );
    }
  }
}

export async function handleManagedDestroy(
  payload: ManagedDestroyPayload,
  _daemonReceivedAt: string,
  deps?: ManagedDestroyHandlerDeps,
): Promise<ManagedDestroyResult> {
  if (!SAFE_MANAGED_ID_RE.test(payload.managedId)) {
    throw new Error("managedId contains unsupported characters");
  }

  const run = deps?.runDocker ?? defaultRunDocker;
  const layout = resolveLayout(Deno.env.toObject());
  const root = managedDir(layout, payload.managedId);
  const project = managedComposeProject(payload.managedId);
  const existed = await pathExists(root);

  await tearDownManagedCompose(run, project, payload.removeVolumes);
  await removeManagedPublicFirewallBestEffort(payload.managedId);
  await removeManagedStateDir(root);

  return {
    status: "stopped",
    containers: [],
    summary: existed
      ? "managed service destroyed"
      : "managed state absent — containers swept",
  };
}
