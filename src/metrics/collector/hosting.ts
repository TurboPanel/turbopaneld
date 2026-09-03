/**
 * Hosting storage path resolution — admin override plus layout default.
 *
 * Operators point the hosting storage probe at a specific filesystem from
 * the control plane. The selection is persisted on
 * `server.metadata.hardwareProfile.hostingPath` and pushed here over the
 * cell socket (`metrics-sensor-overrides-update`) as part of the full
 * hardware profile (see `./sensors/overrides.ts`); absent/invalid state
 * falls back to the layout's `principalHomeRoot`.
 *
 * Either candidate can name a path that does not exist yet on a fresh host
 * — the tenant principal home root is only created on first tenant
 * principal (`ensure-principal.ts`), and an admin override can point at a
 * filesystem before it is provisioned. `statfs` on a missing path always
 * fails, so the resolved path walks up to the nearest existing ancestor
 * directory (bounded at `/`) before being handed to the storage probe —
 * the hosting chart always has something real to measure instead of going
 * blank by construction.
 */
import { dirname } from "@std/path";

import { resolveLayout } from "../../paths/layout.ts";
import { resolveHardwareProfile } from "./sensors/overrides.ts";

/** Injectable existence check for {@link resolveHostingPath}'s ancestor walk-up. */
export type IsDirectoryLike = (path: string) => boolean | Promise<boolean>;

async function defaultIsDirectory(path: string): Promise<boolean> {
  try {
    const info = await Deno.stat(path);
    return info.isDirectory;
  } catch {
    return false;
  }
}

/** Walk up from `path` to the nearest existing ancestor directory, bounded at `/`. */
async function nearestExistingAncestor(
  path: string,
  isDirectory: IsDirectoryLike,
): Promise<string> {
  let current = path;
  while (!(await isDirectory(current))) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

/**
 * Canonical hosting storage path: the admin override when set, else the
 * layout's tenant principal home root — walked up to the nearest existing
 * ancestor directory when the resolved candidate doesn't exist yet.
 */
export async function resolveHostingPath(
  env: Record<string, string | undefined> = Deno.env.toObject(),
  daemonStateDir?: string,
  io: { isDirectory?: IsDirectoryLike } = {},
): Promise<string> {
  const profile = await resolveHardwareProfile(daemonStateDir);
  const candidate = profile.hostingPath ??
    resolveLayout(env).principalHomeRoot;
  const isDirectory = io.isDirectory ?? defaultIsDirectory;
  return await nearestExistingAncestor(candidate, isDirectory);
}
