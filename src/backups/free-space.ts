/**
 * Free bytes for a path that may not exist yet (a policy's first run has no
 * directory). `statfs` on a missing path fails, so the nearest existing
 * ancestor is measured — the same filesystem the directory will be created on.
 * Needs `--allow-sys=statfs` (granted on every daemon path).
 */

import { statfs } from "node:fs/promises";
import { dirname } from "@std/path";

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

async function nearestExistingDir(path: string): Promise<string> {
  if (await pathExists(path)) return path;
  const parent = dirname(path);
  return parent === path ? path : nearestExistingDir(parent);
}

/** Free bytes (available to an unprivileged writer) on the filesystem holding `path`. */
export async function freeBytesAtNearestDir(path: string): Promise<number> {
  const probe = await nearestExistingDir(path);
  const result = await statfs(probe);
  const available = Number(result.bavail) * Number(result.bsize);
  if (!Number.isFinite(available) || available < 0) {
    throw new Error(`unable to measure free space at ${probe}`);
  }
  return available;
}
