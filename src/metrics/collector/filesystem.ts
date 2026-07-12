import { statfs } from "node:fs/promises";
import type { DiskCapacityGauges } from "./types.ts";

/**
 * Root filesystem capacity via async `statfs` — no subprocess (`df`).
 * Returns `null` when unsupported or on error.
 */
export async function readRootFilesystemCapacity(
  path = "/",
): Promise<DiskCapacityGauges | null> {
  try {
    const stat = await statfs(path);
    const blocks = Number(stat.blocks);
    const bfree = Number(stat.bfree);
    const bavail = Number(stat.bavail);
    const bsize = Number(stat.bsize);

    if (
      !Number.isFinite(blocks) || !Number.isFinite(bfree) ||
      !Number.isFinite(bavail) || !Number.isFinite(bsize) || bsize <= 0
    ) {
      return null;
    }

    const used = (blocks - bfree) * bsize;
    const avail = bavail * bsize;
    const denominator = used + avail;
    if (denominator <= 0) return null;

    const diskUsedPercent = (used / denominator) * 100;
    return { diskUsedPercent };
  } catch {
    return null;
  }
}
