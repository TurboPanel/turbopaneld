/**
 * Filesystem capacity probes via async `statfs` — no subprocess (`df`).
 *
 * The v2 contract carries three probes (system `/`, the tenant hosting root,
 * and the Docker data root) as raw total/available bytes; percent reduction
 * is an API-side concern. The Docker probe reports capacity on the filesystem
 * backing TurboPanel Docker volumes, not per-volume quotas.
 */
import { statfs } from "node:fs/promises";

import type { FilesystemSampleV4 } from "../contract-v4.ts";
import type { FilesystemTopology } from "../topology/types.ts";
import type { StorageProbeResult } from "./types.ts";

export type StatfsLike = {
  blocks: number;
  bfree: number;
  bavail: number;
  bsize: number;
  /** Total inode count, when the platform's `statfs` exposes it (Linux does). */
  files?: number;
  /** Free inode count, when the platform's `statfs` exposes it (Linux does). */
  ffree?: number;
};

/** Injected `statfs` may return a value, a promise, or `null`. */
export type StatfsProbeResult = StatfsLike | null;
export type StatfsProbe = (
  path: string,
) => StatfsProbeResult | Promise<StatfsProbeResult>;

export type StatfsIo = {
  statfs?: StatfsProbe;
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
  io?: StatfsIo,
): Promise<StorageProbeResult> {
  try {
    const probe = io?.statfs ?? statfs;
    const stat = await probe(path);
    if (!stat) {
      return null;
    }
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
    if (totalBytes <= 0) {
      return null;
    }

    const totalInodes = Number.isFinite(stat.files) ? Number(stat.files) : null;
    const freeInodes = Number.isFinite(stat.ffree) ? Number(stat.ffree) : null;
    return { totalBytes, availableBytes, totalInodes, freeInodes };
  } catch {
    return null;
  }
}

/**
 * Build one `FilesystemSampleV4` per non-root topology-enumerated filesystem.
 * The root-tagged entry is never included here — its capacity is carried
 * exclusively by `host.storage`'s `rootFilesystemAvailableBytes`/
 * `rootFilesystemFreeInodes` (see {@link probeRootFilesystemCapacity}), so a
 * server never spends an `extraFilesystemSlots` budget slot on `/` itself. A
 * non-root filesystem whose `statfs` probe fails this tick stays present in
 * the output with both fields `null` — topology said it exists, so the entry
 * is never dropped.
 */
export async function buildFilesystemSamples(
  topology: FilesystemTopology[],
  statfsIo?: StatfsIo,
): Promise<FilesystemSampleV4[]> {
  const nonRoot = topology.filter((fs) => !fs.roles.includes("root"));
  return await Promise.all(nonRoot.map(async (fs): Promise<
    FilesystemSampleV4
  > => {
    const probe = await probeStorage(fs.mountpoint, statfsIo);
    return {
      filesystemId: fs.filesystemId,
      availableBytes: probe?.availableBytes ?? null,
      freeInodes: probe?.freeInodes ?? null,
    };
  }));
}

/**
 * Probe the root-tagged topology filesystem's capacity for `host.storage`'s
 * `rootFilesystemAvailableBytes`/`rootFilesystemFreeInodes` — the sole home
 * for root capacity now that {@link buildFilesystemSamples} excludes it.
 * Returns `null` when no topology entry is tagged `"root"` (unexpected, but
 * never thrown) or when its `statfs` probe fails.
 */
export async function probeRootFilesystemCapacity(
  topology: FilesystemTopology[],
  statfsIo?: StatfsIo,
): Promise<
  { availableBytes: number | null; freeInodes: number | null } | null
> {
  const root = topology.find((fs) => fs.roles.includes("root"));
  if (!root) return null;
  const probe = await probeStorage(root.mountpoint, statfsIo);
  return {
    availableBytes: probe?.availableBytes ?? null,
    freeInodes: probe?.freeInodes ?? null,
  };
}
