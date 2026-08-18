import { statfs } from "node:fs/promises";
import type { DiskCapacityGauges } from "./types.ts";

export type StatfsLike = {
  blocks: number;
  bfree: number;
  bavail: number;
  bsize: number;
};

/**
 * Root filesystem capacity via async `statfs` — no subprocess (`df`).
 * Returns `null` when unsupported or on error.
 *
 * Optional `io.statfs` remaps the node `statfs` call for host-free tests of
 * invalid / zero-capacity shapes.
 */
export async function readRootFilesystemCapacity(
  path = "/",
  io?: { statfs?: (path: string) => Promise<StatfsLike> | StatfsLike },
): Promise<DiskCapacityGauges | null> {
  try {
    const probe = io?.statfs ?? statfs;
    const stat = await probe(path);
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
