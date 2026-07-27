/**
 * Managed engine destroy: compose down + optional volumes + state dir removal.
 */

import type {
  ManagedDestroyPayload,
  ManagedDestroyResult,
} from "../instance/commands/contracts.ts";
import { runDocker } from "../deploy/docker-cli.ts";
import { logInfo, sanitizeForLog } from "../logger.ts";
import { resolveLayout } from "../paths/layout.ts";
import {
  ensureManagedIngress,
  removeManagedIngressEntries,
} from "./ingress.ts";
import {
  managedComposeProject,
  managedDir,
  SAFE_MANAGED_ID_RE,
} from "./paths.ts";

type DecryptSecretsFn = (ciphertexts: string[]) => Promise<(string | null)[]>;

export type ManagedDestroyHandlerDeps = {
  decryptSecrets?: DecryptSecretsFn;
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
  _deps?: ManagedDestroyHandlerDeps,
): Promise<ManagedDestroyResult> {
  if (!SAFE_MANAGED_ID_RE.test(payload.managedId)) {
    throw new Error("managedId contains unsupported characters");
  }

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
    const down = await runDocker(args);
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

  const remaining = await removeManagedIngressEntries(layout, payload.managedId);
  if (remaining !== null) {
    await ensureManagedIngress(layout, remaining);
  }

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
