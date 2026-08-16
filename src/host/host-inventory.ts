/**
 * Static host capacity facts for hello resources (CPU / memory / swap).
 * Loaded once per process — not per-tick metrics.
 */

export type HostCpuResources = {
  /** CPU model name from `/proc/cpuinfo` (`model name`). */
  name?: string;
  /** e.g. `"x86_64"`, `"aarch64"` from Deno.build.arch. */
  architecture?: string;
  /** Distinct `physical id` count (sockets). */
  socketCount?: number;
  /**
   * Physical core count from `/proc/cpuinfo` topology (`physical id` +
   * `core id` unique pairs). When topology is absent, equals
   * {@link threadCount}.
   */
  coreCount?: number;
  /**
   * Logical CPU / thread count from `/proc/stat` `cpuN` lines (online vCPUs).
   * Used for load-average normalization (`load / threadCount`).
   */
  threadCount?: number;
};

export type HostResources = {
  cpu?: HostCpuResources;
  memory?: { totalBytes?: number };
  swap?: { totalBytes?: number };
};

const PROC_STAT = "/proc/stat";
const PROC_MEMINFO = "/proc/meminfo";
const PROC_CPUINFO = "/proc/cpuinfo";
const MEMINFO_LINE = /^(\w+):\s+(\d+)\s+kB/;

type CpuinfoField = { key: string; value: string };

/** Linear parse of `/proc/cpuinfo` `key : value` lines (no regex backtracking). */
function parseCpuinfoField(line: string): CpuinfoField | undefined {
  const colon = line.indexOf(":");
  if (colon <= 0) return undefined;
  const key = line.slice(0, colon).trim();
  if (!key) return undefined;
  return { key, value: line.slice(colon + 1).trim() };
}

type CpuinfoProcessorBlock = {
  physicalId: string;
  coreId?: string;
  cpuCoresField?: number;
};

type CpuinfoWalkState = {
  physicalId: string;
  coreId: string | undefined;
  cpuCoresField: number | undefined;
  sawProcessor: boolean;
};

function emptyCpuinfoWalkState(): CpuinfoWalkState {
  return {
    physicalId: "0",
    coreId: undefined,
    cpuCoresField: undefined,
    sawProcessor: false,
  };
}

function applyCpuinfoField(
  state: CpuinfoWalkState,
  field: CpuinfoField,
): void {
  if (field.key === "physical id") {
    state.physicalId = field.value;
    return;
  }
  if (field.key === "core id") {
    state.coreId = field.value;
    return;
  }
  if (field.key !== "cpu cores") return;
  const n = Number(field.value);
  if (Number.isInteger(n) && n > 0) state.cpuCoresField = n;
}

/**
 * Walk `/proc/cpuinfo` processor blocks. Calls `onBlock` when a blank line or
 * a new `processor` key ends the previous block.
 */
function forEachCpuinfoProcessor(
  cpuinfoText: string,
  onBlock: (block: CpuinfoProcessorBlock) => void,
): void {
  const state = emptyCpuinfoWalkState();

  const flush = () => {
    if (!state.sawProcessor) return;
    onBlock({
      physicalId: state.physicalId,
      coreId: state.coreId,
      cpuCoresField: state.cpuCoresField,
    });
  };

  const beginProcessor = () => {
    flush();
    state.physicalId = "0";
    state.coreId = undefined;
    state.sawProcessor = true;
  };

  const endBlank = () => {
    flush();
    state.physicalId = "0";
    state.coreId = undefined;
    state.sawProcessor = false;
  };

  for (const raw of cpuinfoText.split("\n")) {
    const line = raw.trimEnd();
    if (line === "") {
      endBlank();
      continue;
    }
    const field = parseCpuinfoField(line);
    if (!field) continue;
    if (field.key === "processor") {
      beginProcessor();
      continue;
    }
    if (state.sawProcessor) applyCpuinfoField(state, field);
  }
  flush();
}

let cached: HostResources | null | undefined;

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
  const physicalIds = new Set<string>();
  let cpuCoresField: number | undefined;

  forEachCpuinfoProcessor(cpuinfoText, (block) => {
    physicalIds.add(block.physicalId);
    if (block.coreId !== undefined) {
      pairs.add(`${block.physicalId}:${block.coreId}`);
    }
    if (block.cpuCoresField !== undefined) cpuCoresField = block.cpuCoresField;
  });

  if (pairs.size > 0) return pairs.size;
  if (cpuCoresField !== undefined && physicalIds.size > 0) {
    return cpuCoresField * physicalIds.size;
  }
  return 0;
}

/** Distinct socket count from `/proc/cpuinfo` `physical id` fields. */
export function countCpuSockets(cpuinfoText: string): number {
  const physicalIds = new Set<string>();
  forEachCpuinfoProcessor(cpuinfoText, (block) => {
    physicalIds.add(block.physicalId);
  });
  return physicalIds.size;
}

/** First non-empty `model name` from `/proc/cpuinfo`. */
export function readCpuModelName(cpuinfoText: string): string | undefined {
  for (const raw of cpuinfoText.split("\n")) {
    const field = parseCpuinfoField(raw.trimEnd());
    if (field?.key !== "model name") continue;
    if (field.value) return field.value;
  }
  return undefined;
}

export function parseMeminfoTotals(
  text: string,
): { memoryTotalBytes?: number; swapTotalBytes?: number } {
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

  const out: { memoryTotalBytes?: number; swapTotalBytes?: number } = {};
  if (memoryTotalBytes !== undefined) out.memoryTotalBytes = memoryTotalBytes;
  // SwapTotal 0 is a real host fact (no swap configured).
  if (swapTotalBytes !== undefined) out.swapTotalBytes = swapTotalBytes;
  return out;
}

function hasCpuFields(cpu: HostCpuResources): boolean {
  return Object.keys(cpu).length > 0;
}

function applyCpuinfoToResources(
  cpu: HostCpuResources,
  cpuinfoText: string,
): void {
  const physical = countPhysicalCpuCores(cpuinfoText);
  if (physical > 0) cpu.coreCount = physical;
  const sockets = countCpuSockets(cpuinfoText);
  if (sockets > 0) cpu.socketCount = sockets;
  const name = readCpuModelName(cpuinfoText);
  if (name) cpu.name = name;
}

function fillCpuTopologyDefaults(cpu: HostCpuResources): void {
  // No topology (some VMs) → treat each online CPU as one core.
  if (cpu.coreCount === undefined && cpu.threadCount !== undefined) {
    cpu.coreCount = cpu.threadCount;
  }
  if (cpu.socketCount === undefined && cpu.coreCount !== undefined) {
    cpu.socketCount = 1;
  }
}

function applyMeminfoToResources(
  resources: HostResources,
  memText: string,
): void {
  const totals = parseMeminfoTotals(memText);
  if (totals.memoryTotalBytes !== undefined) {
    resources.memory = { totalBytes: totals.memoryTotalBytes };
  }
  if (totals.swapTotalBytes !== undefined) {
    resources.swap = { totalBytes: totals.swapTotalBytes };
  }
}

/** Build resources from raw /proc texts (testable). */
export function hostResourcesFromProc(
  statText: string | undefined,
  memText: string | undefined,
  cpuinfoText?: string | undefined,
  architecture?: string,
): HostResources | undefined {
  const resources: HostResources = {};
  const cpu: HostCpuResources = {};

  if (architecture?.trim()) cpu.architecture = architecture.trim();

  if (statText) {
    const threads = countCpuThreads(statText);
    if (threads > 0) cpu.threadCount = threads;
  }
  if (cpuinfoText) applyCpuinfoToResources(cpu, cpuinfoText);
  fillCpuTopologyDefaults(cpu);
  if (hasCpuFields(cpu)) resources.cpu = cpu;

  if (memText) applyMeminfoToResources(resources, memText);

  return Object.keys(resources).length > 0 ? resources : undefined;
}

/**
 * Host capacity from `/proc` — process-cached after first successful read.
 * Safe under restricted read permissions (falls back to `cat`).
 */
export function readHostResources(): HostResources | undefined {
  if (cached !== undefined) {
    return cached ?? undefined;
  }

  const resources = hostResourcesFromProc(
    readProcFile(PROC_STAT),
    readProcFile(PROC_MEMINFO),
    readProcFile(PROC_CPUINFO),
    Deno.build.arch,
  );
  cached = resources ?? null;
  return resources;
}

/** Test helper — clear process cache between fixture cases. */
export function resetHostResourcesCacheForTests(): void {
  cached = undefined;
}
