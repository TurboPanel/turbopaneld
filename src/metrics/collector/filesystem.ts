/**
 * Filesystem capacity probes via async `statfs` — no subprocess (`df`).
 *
 * The v2 contract carries three probes (system `/`, the tenant hosting root,
 * and the Docker data root) as raw total/available bytes; percent reduction
 * is an API-side concern. The Docker probe reports capacity on the filesystem
 * backing TurboPanel Docker volumes, not per-volume quotas.
 */
import { statfs } from "node:fs/promises";

import type { StorageProbeResult } from "./types.ts";

export type StatfsLike = {
  blocks: number;
  bfree: number;
  bavail: number;
  bsize: number;
};

/**
 * Probe one path's capacity. Returns `null` when the path is missing, the
 * probe is unsupported, or the statfs shape is invalid/zero-capacity.
 *
 * Raw values, normalized before any aggregation: `totalBytes = blocks *
 * bsize` (true filesystem capacity — root-reserved blocks stay in the
 * denominator) and `availableBytes = bavail * bsize` (unprivileged
 * availability). Percent reduction is an API-side concern.
 *
 * Optional `io.statfs` remaps the node `statfs` call for host-free tests;
 * it may return `null` (CollectorDeps-shaped probes) as well as throw.
 */
export async function probeStorage(
  path: string,
  io?: {
    statfs?: (
      path: string,
    ) => Promise<StatfsLike | null> | StatfsLike | null;
  },
): Promise<StorageProbeResult> {
  try {
    const probe = io?.statfs ?? statfs;
    const stat = await probe(path);
    if (!stat) return null;
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

    const totalBytes = blocks * bsize;
    const availableBytes = bavail * bsize;
    if (totalBytes <= 0) return null;

    return { totalBytes, availableBytes };
  } catch {
    return null;
  }
}
