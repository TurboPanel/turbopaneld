/**
 * CPU socket/core/thread topology from `/proc/cpuinfo` (`physical id`/
 * `core id`/`model name` grouping), plus a topology-stable id for every
 * logical core (`processor`). `collector/cpu.ts` only turns `/proc/stat`
 * aggregate jiffie deltas into percentages, so this is the only per-core
 * `/proc/cpuinfo` parsing in the daemon.
 */
import type { CpuCoreTopology, CpuTopology } from "./types.ts";

export type CpuTopologyDeps = {
  readProcFile: (
    path: string,
  ) => string | undefined | Promise<string | undefined>;
};

const EMPTY_CPU_TOPOLOGY: CpuTopology = {
  sockets: 0,
  coresPerSocket: 0,
  threadsPerSocket: 0,
  model: null,
  cores: [],
};

/**
 * Stable id for one logical core: `physical id` + `core id` (both from
 * `/proc/cpuinfo`) pin it to a specific physical core regardless of which
 * `cpuN` the kernel numbers it as, and `threadIndex` (this core's position
 * among the SMT siblings sharing that `physical id`/`core id` pair, in
 * `/proc/cpuinfo` order) disambiguates hyperthread siblings that would
 * otherwise collide on the same physical/core id.
 */
function coreIdFor(
  physicalId: string,
  coreId: string,
  threadIndex: number,
): string {
  return `cpu:p${physicalId}c${coreId}t${threadIndex}`;
}

function parseCpuInfoBlocks(text: string): Record<string, string>[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => {
      const fields: Record<string, string> = {};
      for (const line of block.split("\n")) {
        const idx = line.indexOf(":");
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        if (key) fields[key] = value;
      }
      return fields;
    })
    .filter((fields) => Object.keys(fields).length > 0);
}

/** Socket/core/thread counts and model, grouped by `physical id`/`core id`. */
export async function collectCpuTopology(
  deps: CpuTopologyDeps,
): Promise<CpuTopology> {
  const text = await deps.readProcFile("/proc/cpuinfo");
  if (!text) return EMPTY_CPU_TOPOLOGY;

  const blocks = parseCpuInfoBlocks(text);
  if (blocks.length === 0) return EMPTY_CPU_TOPOLOGY;

  const physicalIds = new Set<string>();
  const threadsByPhysicalId = new Map<string, number>();
  const coreIdsByPhysicalId = new Map<string, Set<string>>();
  const threadIndexByPhysicalCore = new Map<string, number>();
  const cores: CpuCoreTopology[] = [];
  let model: string | null = null;

  for (const block of blocks) {
    if (model === null && block["model name"]) model = block["model name"];
    const physicalId = block["physical id"] ?? "0";
    physicalIds.add(physicalId);
    threadsByPhysicalId.set(
      physicalId,
      (threadsByPhysicalId.get(physicalId) ?? 0) + 1,
    );
    const coreId = block["core id"];
    if (coreId !== undefined) {
      const coreIds = coreIdsByPhysicalId.get(physicalId) ?? new Set<string>();
      coreIds.add(coreId);
      coreIdsByPhysicalId.set(physicalId, coreIds);
    }

    const logicalIndex = Number(block["processor"]);
    if (Number.isFinite(logicalIndex)) {
      const physicalCoreKey = `${physicalId}:${coreId ?? "0"}`;
      const threadIndex = threadIndexByPhysicalCore.get(physicalCoreKey) ?? 0;
      threadIndexByPhysicalCore.set(physicalCoreKey, threadIndex + 1);
      cores.push({
        logicalIndex,
        coreId: coreIdFor(physicalId, coreId ?? "0", threadIndex),
      });
    }
  }

  const sockets = physicalIds.size || 1;
  const threadCounts = [...threadsByPhysicalId.values()];
  const threadsPerSocket = threadCounts.length > 0
    ? Math.max(...threadCounts)
    : blocks.length;
  const coreCounts = [...coreIdsByPhysicalId.values()].map((set) => set.size);
  const coresPerSocket = coreCounts.length > 0
    ? Math.max(...coreCounts)
    : threadsPerSocket;

  return { sockets, coresPerSocket, threadsPerSocket, model, cores };
}

/**
 * Builds the logical-index → stable-coreId lookup `collector/cpu-detail.ts`
 * and `collector/cpu-core-live.ts` key off, indexed by the same string key
 * `parse-stat.ts`'s `parseStatPerCoreLines` uses (`/proc/stat`'s `cpuN`
 * suffix, e.g. `"0"`).
 */
export function buildCpuCoreIdIndex(
  cores: readonly CpuCoreTopology[],
): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const core of cores) {
    index.set(String(core.logicalIndex), core.coreId);
  }
  return index;
}

/**
 * Resolves a `/proc/stat` logical-core key to its topology-stable id, e.g.
 * `"0"` → `"cpu:p0c0t0"`. Falls back to the OS-assigned `cpu${key}` shape
 * only when the topology snapshot has no entry for this key (a host whose
 * `/proc/cpuinfo` never populated `cores`) — a degraded-but-never-throwing
 * id, not the normal path.
 */
export function coreIdForStatKey(
  index: ReadonlyMap<string, string>,
  key: string,
): string {
  return index.get(key) ?? `cpu${key}`;
}
