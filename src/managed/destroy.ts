/**
 * Managed engine destroy: compose down + optional volumes + state dir removal.
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
import {
  removeManagedIngress,
  removeManagedIngressEntries,
  teardownLegacyManagedIngress,
} from "./ingress.ts";
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
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
  const exists = await pathExists(root);

  if (exists) {
    const args = [
      "compose",
      "-p",
      project,
      "down",
      "--remove-orphans",
    ];
    if (payload.removeVolumes) {
      args.push("--volumes");
    }
    const down = await run(args);
    if (!down.success) {
      // Idempotent when the project was never brought up.
      logInfo(
        "managed",
        `managed.destroy compose down soft-failed project=${project}: ${
          sanitizeForLog(down.stderr || "compose down failed")
        }`,
      );
    }
  }

  // Per-service Traefik first, then claim file, then the pre-release shared
  // project — so a last-service delete cannot leave either Traefik running.
  await removeManagedIngress(layout, payload.managedId, run);
  await removeManagedIngressEntries(layout, payload.managedId);
  await teardownLegacyManagedIngress(layout, run);

  try {
    await Deno.remove(root, { recursive: true });
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      throw new TypeError(
        `failed to remove managed state dir: ${sanitizeForLog(err)}`,
      );
    }
  }

  return {
    status: "stopped",
    containers: [],
    summary: exists
      ? "managed service destroyed"
      : "managed state absent — idempotent no-op",
  };
}
