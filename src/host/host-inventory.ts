/**
 * Static host capacity facts for hello inventory (cores / threads / memory / swap).
 * Loaded once per process — not per-tick metrics.
 */

export type HostInventory = {
  /**
   * Physical core count from `/proc/cpuinfo` topology (`physical id` +
   * `core id` unique pairs). When topology is absent, equals
   * {@link cpuThreads}.
   */
  cpuCores?: number;
  /**
   * Logical CPU / thread count from `/proc/stat` `cpuN` lines (online vCPUs).
   * Used for load-average normalization (`load / cpuThreads`).
   */
  cpuThreads?: number;
  memoryTotalBytes?: number;
  swapTotalBytes?: number;
};

const PROC_STAT = "/proc/stat";
const PROC_MEMINFO = "/proc/meminfo";
const PROC_CPUINFO = "/proc/cpuinfo";
const MEMINFO_LINE = /^(\w+):\s+(\d+)\s+kB/;
const CPUINFO_FIELD = /^([^\t:]+)\s*:\s*(.*)$/;

let cached: HostInventory | null | undefined;

function readProcFile(path: string): string | undefined {
  try {
    return Deno.readTextFileSync(path);
  } catch {
    // Deno 2 may block /proc under scoped --allow-read; fall back to cat.
  }

  try {
    const { code, stdout } = new Deno.Command("cat", {
      args: [path],
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    if (code !== 0) return undefined;
    return new TextDecoder().decode(stdout);
  } catch {
    return undefined;
  }
}

/** Count online logical CPUs from aggregate `/proc/stat` `cpuN` lines. */
export function countCpuThreads(statText: string): number {
  let threads = 0;
  for (const line of statText.split("\n")) {
    if (/^cpu\d+\s/.test(line.trim())) threads++;
  }
  return threads;
}

/**
 * Count physical cores from `/proc/cpuinfo` topology.
 *
 * Prefers unique `(physical id, core id)` pairs (correct under HT). Falls back
 * to `cpu cores` × distinct `physical id` when `core id` is missing. Returns 0
 * when no topology is available.
 */
export function countPhysicalCpuCores(cpuinfoText: string): number {
  const pairs = new Set<string>();
  let physicalId = "0";
  let coreId: string | undefined;
  let cpuCoresField: number | undefined;
  const physicalIds = new Set<string>();
  let sawProcessor = false;

  const flush = () => {
    if (!sawProcessor) return;
    physicalIds.add(physicalId);
    if (coreId !== undefined) pairs.add(`${physicalId}:${coreId}`);
  };

  for (const raw of cpuinfoText.split("\n")) {
    const line = raw.trimEnd();
    if (line === "") {
      flush();
      physicalId = "0";
      coreId = undefined;
      sawProcessor = false;
      continue;
    }
    const match = CPUINFO_FIELD.exec(line);
    if (!match) continue;
    const key = match[1]!.trim();
    const value = match[2]!.trim();
    if (key === "processor") {
      flush();
      physicalId = "0";
      coreId = undefined;
      sawProcessor = true;
      continue;
    }
    if (!sawProcessor) continue;
    if (key === "physical id") physicalId = value;
    else if (key === "core id") coreId = value;
    else if (key === "cpu cores") {
      const n = Number(value);
      if (Number.isInteger(n) && n > 0) cpuCoresField = n;
    }
  }
  flush();

  if (pairs.size > 0) return pairs.size;
  if (cpuCoresField !== undefined && physicalIds.size > 0) {
    return cpuCoresField * physicalIds.size;
  }
  return 0;
}

export function parseMeminfoTotals(
  text: string,
): Pick<HostInventory, "memoryTotalBytes" | "swapTotalBytes"> {
  let memoryTotalBytes: number | undefined;
  let swapTotalBytes: number | undefined;

  for (const line of text.split("\n")) {
    const match = MEMINFO_LINE.exec(line);
    if (!match) continue;
    const kb = Number(match[2]);
    if (!Number.isFinite(kb) || kb < 0) continue;
    if (match[1] === "MemTotal") memoryTotalBytes = kb * 1024;
    if (match[1] === "SwapTotal") swapTotalBytes = kb * 1024;
  }

  const out: Pick<HostInventory, "memoryTotalBytes" | "swapTotalBytes"> = {};
  if (memoryTotalBytes !== undefined) out.memoryTotalBytes = memoryTotalBytes;
  // SwapTotal 0 is a real host fact (no swap configured).
  if (swapTotalBytes !== undefined) out.swapTotalBytes = swapTotalBytes;
  return out;
}

/** Build inventory from raw /proc texts (testable). */
export function hostInventoryFromProc(
  statText: string | undefined,
  memText: string | undefined,
  cpuinfoText?: string | undefined,
): HostInventory | undefined {
  const inventory: HostInventory = {};

  if (statText) {
    const threads = countCpuThreads(statText);
    if (threads > 0) inventory.cpuThreads = threads;
  }
  if (cpuinfoText) {
    const physical = countPhysicalCpuCores(cpuinfoText);
    if (physical > 0) inventory.cpuCores = physical;
  }
  // No topology (some VMs) → treat each online CPU as one core.
  if (inventory.cpuCores === undefined && inventory.cpuThreads !== undefined) {
    inventory.cpuCores = inventory.cpuThreads;
  }
  if (memText) {
    Object.assign(inventory, parseMeminfoTotals(memText));
  }

  return Object.keys(inventory).length > 0 ? inventory : undefined;
}

/**
 * Host capacity from `/proc` — process-cached after first successful read.
 * Safe under restricted read permissions (falls back to `cat`).
 */
export function readHostInventory(): HostInventory | undefined {
  if (cached !== undefined) {
    return cached ?? undefined;
  }

  const inventory = hostInventoryFromProc(
    readProcFile(PROC_STAT),
    readProcFile(PROC_MEMINFO),
    readProcFile(PROC_CPUINFO),
  );
  cached = inventory ?? null;
  return inventory;
}

/** Test helper — clear process cache between fixture cases. */
export function resetHostInventoryCacheForTests(): void {
  cached = undefined;
}
