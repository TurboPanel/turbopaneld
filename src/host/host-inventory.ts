/**
 * Static host capacity facts for hello inventory (cores / memory / swap totals).
 * Loaded once per process — not per-tick metrics.
 */

export type HostInventory = {
  /** Logical CPU count from `/proc/stat` `cpuN` lines. */
  cpuCores?: number;
  memoryTotalBytes?: number;
  swapTotalBytes?: number;
};

const PROC_STAT = "/proc/stat";
const PROC_MEMINFO = "/proc/meminfo";
const MEMINFO_LINE = /^(\w+):\s+(\d+)\s+kB/;

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

/** Count online CPUs from aggregate `/proc/stat` `cpuN` lines. */
export function countCpuCores(statText: string): number {
  let cores = 0;
  for (const line of statText.split("\n")) {
    if (/^cpu\d+\s/.test(line.trim())) cores++;
  }
  return cores;
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
): HostInventory | undefined {
  const inventory: HostInventory = {};

  if (statText) {
    const cores = countCpuCores(statText);
    if (cores > 0) inventory.cpuCores = cores;
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
  );
  cached = inventory ?? null;
  return inventory;
}

/** Test helper — clear process cache between fixture cases. */
export function resetHostInventoryCacheForTests(): void {
  cached = undefined;
}
