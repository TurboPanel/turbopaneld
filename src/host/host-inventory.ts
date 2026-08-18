import type { ServerReportedIp } from "../server-addresses.ts";

/**
 * Static host capacity facts for hello resources (CPU sockets / GPUs /
 * memory / swap). Loaded once per process — not per-tick metrics.
 */

/** Physical vs efficiency core/thread counts on hybrid CPUs. */
export type HostCpuCoreSplit = {
  total: number;
  /** Performance / P-cores (Intel) or big cores. */
  p?: number;
  /** Efficiency / E-cores (Intel) or little cores. */
  e?: number;
};

/** Cache sizes in bytes. `l1` is `l1d + l1i` when both splits are known. */
export type HostCpuCache = {
  l1?: number;
  l1d?: number;
  l1i?: number;
  l2?: number;
  l3?: number;
  l4?: number;
};

export type HostCpuSocket = {
  /** cpuinfo `vendor_id` (e.g. GenuineIntel) or ARM `CPU implementer`. */
  vendorId?: string;
  /** cpuinfo `model name` (or ARM `Hardware` / `Processor`). */
  name?: string;
  /** e.g. `"x86_64"`, `"aarch64"` from Deno.build.arch. */
  architecture?: string;
  cores?: HostCpuCoreSplit;
  threads?: HostCpuCoreSplit;
  cache?: HostCpuCache;
  /** Advertised base clock, MHz (`base_frequency` or model-name `@ N GHz`). */
  speedMhz?: number;
  /** Max turbo, MHz (`cpuinfo_max_freq`). */
  turboMhz?: number;
};

export type HostGpu = {
  /** PCI vendor id from sysfs (e.g. `0x10de`). */
  vendorId?: string;
  name?: string;
  memoryBytes?: number;
  driver?: string;
  /** `vendor:device` without `0x` (e.g. `10de:2d04`). */
  pciId?: string;
  /** sysfs `PCI_SLOT_NAME` (e.g. `0000:01:00.0`). */
  pciSlot?: string;
};

export type HostResources = {
  /** One entry per physical socket, ordered by `physical id` (0, 1, …). */
  cpus?: HostCpuSocket[];
  /** One entry per DRM `cardN`, ordered by N. */
  gpus?: HostGpu[];
  memory?: { totalBytes?: number };
  swap?: { totalBytes?: number };
  /** Host interface addresses — nested here on hello / change-detected heartbeat. */
  ips?: ServerReportedIp[];
};

/**
 * Optional sysfs / GPU facts for {@link hostResourcesFromProc} (tests inject;
 * production reads them in {@link readHostResources}).
 */
export type HostInventoryExtras = {
  cacheForCpu?: (cpuIndex: number) => HostCpuCache | undefined;
  freqForCpu?: (
    cpuIndex: number,
  ) => { speedMhz?: number; turboMhz?: number } | undefined;
  /** Linux cpulist of P-cores (`/sys/devices/cpu_core/cpus`). */
  pCpus?: string;
  /** Linux cpulist of E-cores (`cpu_atom` and/or `cpu_lowpower`). */
  eCpus?: string;
  gpus?: HostGpu[];
};

/**
 * Optional filesystem / command seams for host-free {@link readHostResources}
 * tests. Production callers omit this and use real `/proc` + `/sys`.
 */
export type HostInventoryIo = {
  /** Root that contains `stat` / `meminfo` / `cpuinfo` / `driver/…`. */
  procRoot?: string;
  /** Root that contains `devices/system/cpu` and `class/drm`. */
  sysRoot?: string;
  readTextFile?: (path: string) => string | undefined;
  readDirSync?: (path: string) => Iterable<{ name: string }>;
  /**
   * Optional nvidia-smi CSV (`pci.bus_id,memory.total` MiB). When omitted,
   * production spawns `nvidia-smi`; tests typically return fixture text or
   * `undefined` to skip the spawn.
   */
  nvidiaSmiCsv?: () => string | undefined;
  /**
   * Override the `cat` fallback used by the default reader after
   * `Deno.readTextFileSync` fails (host-free coverage of that path).
   */
  runCat?: (path: string) => { code: number; stdout: Uint8Array };
  architecture?: string;
};

const DEFAULT_PROC_ROOT = "/proc";
const DEFAULT_SYS_ROOT = "/sys";
const MEMINFO_LINE = /^(\w+):\s+(\d+)\s+kB/;
const DRM_CARD = /^card(\d+)$/;

type InventoryLayout = {
  procStat: string;
  procMeminfo: string;
  procCpuinfo: string;
  sysCpu: string;
  sysDrm: string;
  sysCpuCore: string;
  sysCpuAtom: string;
  sysCpuLowpower: string;
  nvidiaGpuInfo: (slot: string) => string;
  readTextFile: (path: string) => string | undefined;
  readDirSync: (path: string) => Iterable<{ name: string }>;
  nvidiaSmiCsv?: () => string | undefined;
  architecture: string;
};

function defaultReadTextFile(
  path: string,
  runCat?: (path: string) => { code: number; stdout: Uint8Array },
): string | undefined {
  try {
    return Deno.readTextFileSync(path);
  } catch {
    // Deno 2 may block /proc under scoped --allow-read; fall back to cat.
  }

  try {
    const { code, stdout } = runCat
      ? runCat(path)
      : new Deno.Command("cat", {
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

function resolveInventoryLayout(io?: HostInventoryIo): InventoryLayout {
  const procRoot = io?.procRoot ?? DEFAULT_PROC_ROOT;
  const sysRoot = io?.sysRoot ?? DEFAULT_SYS_ROOT;
  return {
    procStat: `${procRoot}/stat`,
    procMeminfo: `${procRoot}/meminfo`,
    procCpuinfo: `${procRoot}/cpuinfo`,
    sysCpu: `${sysRoot}/devices/system/cpu`,
    sysDrm: `${sysRoot}/class/drm`,
    sysCpuCore: `${sysRoot}/devices/cpu_core/cpus`,
    sysCpuAtom: `${sysRoot}/devices/cpu_atom/cpus`,
    sysCpuLowpower: `${sysRoot}/devices/cpu_lowpower/cpus`,
    nvidiaGpuInfo: (slot) =>
      `${procRoot}/driver/nvidia/gpus/${slot}/information`,
    readTextFile: io?.readTextFile ??
      ((path) => defaultReadTextFile(path, io?.runCat)),
    readDirSync: io?.readDirSync ?? ((path) => Deno.readDirSync(path)),
    nvidiaSmiCsv: io?.nvidiaSmiCsv,
    architecture: io?.architecture ?? Deno.build.arch,
  };
}

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
  processorIndex?: number;
  physicalId: string;
  coreId?: string;
  cpuCoresField?: number;
  vendorId?: string;
  modelName?: string;
  cpuImplementer?: string;
  cacheSizeKb?: number;
};

type CpuinfoWalkState = {
  processorIndex: number | undefined;
  physicalId: string;
  coreId: string | undefined;
  cpuCoresField: number | undefined;
  vendorId: string | undefined;
  modelName: string | undefined;
  cpuImplementer: string | undefined;
  cacheSizeKb: number | undefined;
  sawProcessor: boolean;
};

function emptyCpuinfoWalkState(): CpuinfoWalkState {
  return {
    processorIndex: undefined,
    physicalId: "0",
    coreId: undefined,
    cpuCoresField: undefined,
    vendorId: undefined,
    modelName: undefined,
    cpuImplementer: undefined,
    cacheSizeKb: undefined,
    sawProcessor: false,
  };
}

function applyCpuinfoField(
  state: CpuinfoWalkState,
  field: CpuinfoField,
): void {
  switch (field.key) {
    case "physical id":
      state.physicalId = field.value;
      return;
    case "core id":
      state.coreId = field.value;
      return;
    case "cpu cores": {
      const n = Number(field.value);
      if (Number.isInteger(n) && n > 0) state.cpuCoresField = n;
      return;
    }
    case "vendor_id":
      if (field.value) state.vendorId = field.value;
      return;
    case "model name":
      if (field.value) state.modelName = field.value;
      return;
    case "CPU implementer":
      if (field.value) state.cpuImplementer = field.value;
      return;
    case "cache size": {
      const bytes = parseSizeToBytes(field.value);
      if (bytes !== undefined) state.cacheSizeKb = Math.round(bytes / 1024);
      return;
    }
    default:
      return;
  }
}

function snapshotCpuinfoBlock(state: CpuinfoWalkState): CpuinfoProcessorBlock {
  const block: CpuinfoProcessorBlock = { physicalId: state.physicalId };
  if (state.processorIndex !== undefined) {
    block.processorIndex = state.processorIndex;
  }
  if (state.coreId !== undefined) block.coreId = state.coreId;
  if (state.cpuCoresField !== undefined) {
    block.cpuCoresField = state.cpuCoresField;
  }
  if (state.vendorId) block.vendorId = state.vendorId;
  if (state.modelName) block.modelName = state.modelName;
  if (state.cpuImplementer) block.cpuImplementer = state.cpuImplementer;
  if (state.cacheSizeKb !== undefined) block.cacheSizeKb = state.cacheSizeKb;
  return block;
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
    onBlock(snapshotCpuinfoBlock(state));
  };

  const beginProcessor = (index: number | undefined) => {
    flush();
    state.processorIndex = index;
    state.physicalId = "0";
    state.coreId = undefined;
    state.cpuCoresField = undefined;
    state.vendorId = undefined;
    state.modelName = undefined;
    state.cpuImplementer = undefined;
    state.cacheSizeKb = undefined;
    state.sawProcessor = true;
  };

  const endBlank = () => {
    flush();
    state.processorIndex = undefined;
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
      const n = Number(field.value);
      const index = Number.isInteger(n) && n >= 0 ? n : undefined;
      beginProcessor(index);
      continue;
    }
    if (state.sawProcessor) applyCpuinfoField(state, field);
  }
  flush();
}

let cached: HostResources | null | undefined;

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
  return firstCpuinfoValue(cpuinfoText, "model name");
}

function firstCpuinfoValue(
  cpuinfoText: string,
  key: string,
): string | undefined {
  for (const raw of cpuinfoText.split("\n")) {
    const field = parseCpuinfoField(raw.trimEnd());
    if (field?.key !== key) continue;
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

/**
 * Parse a Linux cpulist (`0-7,16` or `0-7:2`) into unique CPU indexes.
 */
export function parseCpulist(text: string): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const part of text.trim().split(",")) {
    const token = part.trim();
    if (!token) continue;
    for (const n of parseCpulistRange(token)) {
      if (seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

function parseCpulistRange(token: string): number[] {
  const colon = token.indexOf(":");
  let stride = 1;
  let rangePart = token;
  if (colon >= 0) {
    const strideRaw = Number(token.slice(colon + 1));
    if (!Number.isInteger(strideRaw) || strideRaw <= 0) return [];
    stride = strideRaw;
    rangePart = token.slice(0, colon);
  }
  const dash = rangePart.indexOf("-");
  if (dash < 0) {
    const n = Number(rangePart);
    return Number.isInteger(n) && n >= 0 ? [n] : [];
  }
  const start = Number(rangePart.slice(0, dash));
  const end = Number(rangePart.slice(dash + 1));
  if (!Number.isInteger(start) || !Number.isInteger(end)) return [];
  if (start < 0 || end < start) return [];
  const nums: number[] = [];
  for (let n = start; n <= end; n += stride) nums.push(n);
  return nums;
}

function cpulistSet(text: string | undefined): Set<number> | undefined {
  if (text === undefined) return undefined;
  const parsed = parseCpulist(text);
  return parsed.length > 0 ? new Set(parsed) : undefined;
}

/**
 * Parse sysfs / cpuinfo size strings (`32K`, `8192 KB`, `8M`) into bytes.
 */
export function parseSizeToBytes(text: string): number | undefined {
  const compact = text.trim().toLowerCase().replaceAll(" ", "");
  if (!compact) return undefined;
  const parsed = splitSizeMagnitude(compact);
  if (!parsed) return undefined;
  const { n, unit } = parsed;
  if (unit === "g") return Math.round(n * 1024 * 1024 * 1024);
  if (unit === "m") return Math.round(n * 1024 * 1024);
  if (unit === "k") return Math.round(n * 1024);
  return Math.round(n);
}

const SIZE_SUFFIXES: ReadonlyArray<{ suffix: string; unit: "k" | "m" | "g" }> =
  [
    { suffix: "kib", unit: "k" },
    { suffix: "mib", unit: "m" },
    { suffix: "gib", unit: "g" },
    { suffix: "kb", unit: "k" },
    { suffix: "mb", unit: "m" },
    { suffix: "gb", unit: "g" },
    { suffix: "k", unit: "k" },
    { suffix: "m", unit: "m" },
    { suffix: "g", unit: "g" },
  ];

function splitSizeMagnitude(
  compact: string,
): { n: number; unit: "b" | "k" | "m" | "g" } | undefined {
  let unit: "b" | "k" | "m" | "g" = "b";
  let digits = compact;
  for (const entry of SIZE_SUFFIXES) {
    if (!compact.endsWith(entry.suffix)) continue;
    unit = entry.unit;
    digits = compact.slice(0, -entry.suffix.length);
    break;
  }
  if (unit === "b" && compact.endsWith("b")) {
    digits = compact.slice(0, -1);
  }
  const n = Number(digits);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return { n, unit };
}

/** Advertised clock from `model name` (`@ 4.00GHz` → 4000). */
export function advertisedMhzFromModelName(name: string): number | undefined {
  const at = name.lastIndexOf("@");
  if (at < 0) return undefined;
  const rest = name.slice(at + 1).trim().toLowerCase().replaceAll(" ", "");
  const ghz = rest.indexOf("ghz");
  if (ghz >= 0) {
    const n = Number(rest.slice(0, ghz));
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return Math.round(n * 1000);
  }
  const mhz = rest.indexOf("mhz");
  if (mhz < 0) return undefined;
  const n = Number(rest.slice(0, mhz));
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n);
}

function khzTextToMhz(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const n = Number(text.trim());
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n / 1000);
}

function comparePhysicalId(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isInteger(na) && Number.isInteger(nb)) return na - nb;
  return a.localeCompare(b);
}

type SocketAcc = {
  physicalId: string;
  vendorId?: string;
  name?: string;
  cpuCoresField?: number;
  cacheSizeKb?: number;
  coreIds: Set<string>;
  processors: number[];
  coreIdByCpu: Map<number, string>;
};

function socketForPhysicalId(
  sockets: Map<string, SocketAcc>,
  physicalId: string,
): SocketAcc {
  const existing = sockets.get(physicalId);
  if (existing) return existing;
  const created: SocketAcc = {
    physicalId,
    coreIds: new Set(),
    processors: [],
    coreIdByCpu: new Map(),
  };
  sockets.set(physicalId, created);
  return created;
}

function rememberSocketIdentity(
  acc: SocketAcc,
  block: CpuinfoProcessorBlock,
): void {
  if (!acc.vendorId) {
    acc.vendorId = block.vendorId ?? block.cpuImplementer;
  }
  if (!acc.name && block.modelName) acc.name = block.modelName;
  if (acc.cpuCoresField === undefined && block.cpuCoresField !== undefined) {
    acc.cpuCoresField = block.cpuCoresField;
  }
  if (acc.cacheSizeKb === undefined && block.cacheSizeKb !== undefined) {
    acc.cacheSizeKb = block.cacheSizeKb;
  }
}

function rememberSocketTopology(
  acc: SocketAcc,
  block: CpuinfoProcessorBlock,
): void {
  if (block.coreId !== undefined) acc.coreIds.add(block.coreId);
  const cpuIndex = block.processorIndex ?? acc.processors.length;
  acc.processors.push(cpuIndex);
  if (block.coreId !== undefined) acc.coreIdByCpu.set(cpuIndex, block.coreId);
}

function accumulateCpuinfoSockets(cpuinfoText: string): SocketAcc[] {
  const sockets = new Map<string, SocketAcc>();
  forEachCpuinfoProcessor(cpuinfoText, (block) => {
    const acc = socketForPhysicalId(sockets, block.physicalId);
    rememberSocketIdentity(acc, block);
    rememberSocketTopology(acc, block);
  });
  return [...sockets.values()].sort((a, b) =>
    comparePhysicalId(a.physicalId, b.physicalId)
  );
}

function applyHybridSplit(
  acc: SocketAcc,
  pSet: Set<number> | undefined,
  eSet: Set<number> | undefined,
  cores: HostCpuCoreSplit,
  threads: HostCpuCoreSplit,
): void {
  if (!pSet && !eSet) return;
  const pCpus = acc.processors.filter((n) => pSet?.has(n));
  const eCpus = acc.processors.filter((n) => eSet?.has(n));
  if (pCpus.length > 0) threads.p = pCpus.length;
  if (eCpus.length > 0) threads.e = eCpus.length;
  const pCores = uniqueCoreIds(acc, pCpus);
  const eCores = uniqueCoreIds(acc, eCpus);
  if (pCores > 0) cores.p = pCores;
  if (eCores > 0) cores.e = eCores;
}

function uniqueCoreIds(acc: SocketAcc, cpus: number[]): number {
  const ids = new Set<string>();
  for (const cpu of cpus) {
    const coreId = acc.coreIdByCpu.get(cpu);
    if (coreId !== undefined) ids.add(coreId);
  }
  return ids.size > 0 ? ids.size : cpus.length;
}

function cacheFromSysfsOrCpuinfo(
  acc: SocketAcc,
  extras: HostInventoryExtras | undefined,
): HostCpuCache | undefined {
  const sampleCpu = acc.processors[0];
  const fromSysfs = extras?.cacheForCpu?.(sampleCpu);
  if (fromSysfs && Object.keys(fromSysfs).length > 0) {
    const cache = { ...fromSysfs };
    fillL1Sum(cache);
    return cache;
  }
  if (acc.cacheSizeKb === undefined) return undefined;
  return { l3: acc.cacheSizeKb * 1024 };
}

function clocksForSocket(
  acc: SocketAcc,
  extras: HostInventoryExtras | undefined,
): { speedMhz?: number; turboMhz?: number } {
  const sampleCpu = acc.processors[0];
  const fromSysfs = extras?.freqForCpu?.(sampleCpu) ?? {};
  const speedMhz = fromSysfs.speedMhz ??
    (acc.name ? advertisedMhzFromModelName(acc.name) : undefined);
  const out: { speedMhz?: number; turboMhz?: number } = {};
  if (speedMhz !== undefined) out.speedMhz = speedMhz;
  if (fromSysfs.turboMhz !== undefined) out.turboMhz = fromSysfs.turboMhz;
  return out;
}

function socketCoresTotal(acc: SocketAcc, threadCount: number): number {
  if (acc.coreIds.size > 0) return acc.coreIds.size;
  if (acc.cpuCoresField !== undefined) return acc.cpuCoresField;
  return threadCount;
}

function buildCpuSocket(
  acc: SocketAcc,
  architecture: string | undefined,
  fallbackName: string | undefined,
  extras: HostInventoryExtras | undefined,
): HostCpuSocket {
  const socket: HostCpuSocket = {};
  const vendorId = acc.vendorId;
  const name = acc.name ?? fallbackName;
  if (vendorId) socket.vendorId = vendorId;
  if (name) socket.name = name;
  if (architecture) socket.architecture = architecture;

  const threadCount = acc.processors.length;
  const cores: HostCpuCoreSplit = {
    total: socketCoresTotal(acc, threadCount),
  };
  const threads: HostCpuCoreSplit = { total: threadCount };
  applyHybridSplit(
    acc,
    cpulistSet(extras?.pCpus),
    cpulistSet(extras?.eCpus),
    cores,
    threads,
  );
  socket.cores = cores;
  socket.threads = threads;

  const cache = cacheFromSysfsOrCpuinfo(acc, extras);
  if (cache) socket.cache = cache;
  const clocks = clocksForSocket(acc, extras);
  if (clocks.speedMhz !== undefined) socket.speedMhz = clocks.speedMhz;
  if (clocks.turboMhz !== undefined) socket.turboMhz = clocks.turboMhz;
  return socket;
}

function topologylessSocket(
  threadCount: number,
  architecture: string | undefined,
  fallbackName: string | undefined,
  extras: HostInventoryExtras | undefined,
): HostCpuSocket {
  const acc: SocketAcc = {
    physicalId: "0",
    name: fallbackName,
    coreIds: new Set(),
    processors: Array.from({ length: threadCount }, (_, i) => i),
    coreIdByCpu: new Map(),
  };
  return buildCpuSocket(acc, architecture, fallbackName, extras);
}

function expandUngroupedSocketThreads(
  acc: SocketAcc,
  statThreads: number,
): void {
  if (acc.coreIds.size > 0 || acc.cpuCoresField !== undefined) return;
  if (statThreads <= acc.processors.length) return;
  acc.processors = Array.from({ length: statThreads }, (_, i) => i);
}

function hostCpusFromProc(
  statText: string | undefined,
  cpuinfoText: string | undefined,
  architecture: string | undefined,
  extras: HostInventoryExtras | undefined,
): HostCpuSocket[] | undefined {
  const arch = architecture?.trim() || undefined;
  const fallbackName = cpuinfoText
    ? readCpuModelName(cpuinfoText) ??
      firstCpuinfoValue(cpuinfoText, "Processor") ??
      firstCpuinfoValue(cpuinfoText, "Hardware")
    : undefined;
  const statThreads = statText ? countCpuThreads(statText) : 0;
  const sockets = cpuinfoText ? accumulateCpuinfoSockets(cpuinfoText) : [];
  if (sockets.length === 1) {
    expandUngroupedSocketThreads(sockets[0], statThreads);
  }
  if (sockets.length > 0) {
    return sockets.map((acc) =>
      buildCpuSocket(acc, arch, fallbackName, extras)
    );
  }
  if (statThreads > 0) {
    return [topologylessSocket(statThreads, arch, fallbackName, extras)];
  }
  if (!arch && !fallbackName) return undefined;
  const socket: HostCpuSocket = {};
  if (arch) socket.architecture = arch;
  if (fallbackName) socket.name = fallbackName;
  return [socket];
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

function hasCpuSocketFields(socket: HostCpuSocket): boolean {
  return Object.keys(socket).length > 0;
}

/** Build resources from raw /proc texts (testable). */
export function hostResourcesFromProc(
  statText: string | undefined,
  memText: string | undefined,
  cpuinfoText?: string | undefined,
  architecture?: string,
  extras?: HostInventoryExtras,
): HostResources | undefined {
  const resources: HostResources = {};
  const cpus = hostCpusFromProc(statText, cpuinfoText, architecture, extras);
  if (cpus?.some(hasCpuSocketFields)) resources.cpus = cpus;
  if (extras?.gpus && extras.gpus.length > 0) resources.gpus = extras.gpus;
  if (memText) applyMeminfoToResources(resources, memText);
  return Object.keys(resources).length > 0 ? resources : undefined;
}

function readCpuCacheFromSysfs(
  layout: InventoryLayout,
  cpuIndex: number,
): HostCpuCache | undefined {
  const cache: HostCpuCache = {};
  for (let index = 0; index < 8; index++) {
    const dir = `${layout.sysCpu}/cpu${cpuIndex}/cache/index${index}`;
    const levelText = layout.readTextFile(`${dir}/level`);
    if (!levelText) continue;
    const level = Number(levelText.trim());
    const type = (layout.readTextFile(`${dir}/type`) ?? "").trim()
      .toLowerCase();
    const size = parseSizeToBytes(layout.readTextFile(`${dir}/size`) ?? "");
    if (!Number.isInteger(level) || size === undefined) continue;
    applyCacheIndex(cache, level, type, size);
  }
  fillL1Sum(cache);
  return Object.keys(cache).length > 0 ? cache : undefined;
}

function applyCacheIndex(
  cache: HostCpuCache,
  level: number,
  type: string,
  size: number,
): void {
  if (level === 1 && type === "data") {
    cache.l1d = size;
    return;
  }
  if (level === 1 && type === "instruction") {
    cache.l1i = size;
    return;
  }
  if (level === 1) {
    cache.l1 = size;
    return;
  }
  if (level === 2) {
    cache.l2 = size;
    return;
  }
  if (level === 3) {
    cache.l3 = size;
    return;
  }
  if (level === 4) cache.l4 = size;
}

function fillL1Sum(cache: HostCpuCache): void {
  if (cache.l1 !== undefined) return;
  if (cache.l1d === undefined || cache.l1i === undefined) return;
  cache.l1 = cache.l1d + cache.l1i;
}

function readCpuFreqFromSysfs(
  layout: InventoryLayout,
  cpuIndex: number,
): { speedMhz?: number; turboMhz?: number } | undefined {
  const dir = `${layout.sysCpu}/cpu${cpuIndex}/cpufreq`;
  const speedMhz = khzTextToMhz(layout.readTextFile(`${dir}/base_frequency`));
  const turboMhz = khzTextToMhz(layout.readTextFile(`${dir}/cpuinfo_max_freq`));
  if (speedMhz === undefined && turboMhz === undefined) return undefined;
  const out: { speedMhz?: number; turboMhz?: number } = {};
  if (speedMhz !== undefined) out.speedMhz = speedMhz;
  if (turboMhz !== undefined) out.turboMhz = turboMhz;
  return out;
}

function listDrmCardIndexes(layout: InventoryLayout): number[] {
  try {
    const indexes: number[] = [];
    for (const entry of layout.readDirSync(layout.sysDrm)) {
      const match = DRM_CARD.exec(entry.name);
      if (!match) continue;
      indexes.push(Number(match[1]));
    }
    return indexes.sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/** Strip a leading `0x` from PCI id strings (exported for fixture tests). */
export function stripPciHexPrefix(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith("0x")) return trimmed.slice(2);
  return trimmed;
}

/** Parse KEY=VALUE uevent text into a map (exported for fixture tests). */
export function parseUeventMap(text: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!text) return map;
  for (const raw of text.split("\n")) {
    const eq = raw.indexOf("=");
    if (eq <= 0) continue;
    map.set(raw.slice(0, eq), raw.slice(eq + 1));
  }
  return map;
}

function nvidiaModelForSlot(
  layout: InventoryLayout,
  slot: string,
): string | undefined {
  const text = layout.readTextFile(layout.nvidiaGpuInfo(slot));
  if (!text) return undefined;
  for (const raw of text.split("\n")) {
    const field = parseCpuinfoField(raw.trimEnd());
    if (field?.key !== "Model") continue;
    if (field.value) return field.value;
  }
  return undefined;
}

/**
 * Normalize nvidia-smi `pci.bus_id` domains to a 4-hex-digit prefix
 * (exported for fixture tests).
 */
export function normalizePciSlot(slot: string): string {
  const trimmed = slot.trim();
  const colon = trimmed.indexOf(":");
  if (colon <= 0) return trimmed;
  const domain = trimmed.slice(0, colon);
  const rest = trimmed.slice(colon);
  if (domain.length <= 4) return trimmed;
  return `${domain.slice(-4)}${rest}`;
}

/**
 * Parse nvidia-smi CSV (`pci.bus_id,memory.total` MiB) into slot → bytes
 * (exported for fixture tests).
 */
export function parseNvidiaSmiMemoryCsv(text: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const comma = line.indexOf(",");
    if (comma <= 0) continue;
    const slot = normalizePciSlot(line.slice(0, comma).trim());
    const mib = Number(line.slice(comma + 1).trim());
    if (!slot || !Number.isFinite(mib) || mib <= 0) continue;
    map.set(slot, Math.round(mib * 1024 * 1024));
  }
  return map;
}

function readNvidiaMemoryMiBBySlot(
  layout: InventoryLayout,
): Map<string, number> {
  if (layout.nvidiaSmiCsv) {
    const csv = layout.nvidiaSmiCsv();
    if (csv === undefined) return new Map();
    return parseNvidiaSmiMemoryCsv(csv);
  }
  try {
    const { code, stdout } = new Deno.Command("nvidia-smi", {
      args: [
        "--query-gpu=pci.bus_id,memory.total",
        "--format=csv,noheader,nounits",
      ],
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    if (code !== 0) return new Map();
    return parseNvidiaSmiMemoryCsv(new TextDecoder().decode(stdout));
  } catch {
    // nvidia-smi is optional (AMD / Intel / no NVIDIA driver).
    return new Map();
  }
}

function gpuNameFromDevice(
  layout: InventoryLayout,
  deviceDir: string,
  slot: string | undefined,
  vendorId: string | undefined,
  deviceId: string | undefined,
): string | undefined {
  if (slot) {
    const nvidia = nvidiaModelForSlot(layout, slot);
    if (nvidia) return nvidia;
  }
  const marketing = layout.readTextFile(`${deviceDir}/marketing_name`)?.trim();
  if (marketing) return marketing;
  const product = layout.readTextFile(`${deviceDir}/product_name`)?.trim();
  if (product) return product;
  if (vendorId && deviceId) return `${vendorId} ${deviceId}`;
  return undefined;
}

function gpuMemoryBytes(
  layout: InventoryLayout,
  deviceDir: string,
  slot: string | undefined,
  nvidiaMemory: Map<string, number>,
): number | undefined {
  const amd = parseSizeToBytes(
    layout.readTextFile(`${deviceDir}/mem_info_vram_total`) ?? "",
  );
  if (amd !== undefined && amd > 0) return amd;
  if (!slot) return undefined;
  return nvidiaMemory.get(normalizePciSlot(slot));
}

function readGpuFromCard(
  layout: InventoryLayout,
  cardIndex: number,
  nvidiaMemory: Map<string, number>,
): HostGpu | undefined {
  const deviceDir = `${layout.sysDrm}/card${cardIndex}/device`;
  const vendorRaw = layout.readTextFile(`${deviceDir}/vendor`)?.trim();
  const deviceRaw = layout.readTextFile(`${deviceDir}/device`)?.trim();
  if (!vendorRaw && !deviceRaw) return undefined;
  const uevent = parseUeventMap(layout.readTextFile(`${deviceDir}/uevent`));
  const slot = uevent.get("PCI_SLOT_NAME");
  const driver = uevent.get("DRIVER");
  const gpu: HostGpu = {};
  if (vendorRaw) gpu.vendorId = vendorRaw;
  if (driver) gpu.driver = driver;
  if (slot) gpu.pciSlot = slot;
  if (vendorRaw && deviceRaw) {
    gpu.pciId = `${stripPciHexPrefix(vendorRaw)}:${
      stripPciHexPrefix(deviceRaw)
    }`;
  }
  const name = gpuNameFromDevice(layout, deviceDir, slot, vendorRaw, deviceRaw);
  if (name) gpu.name = name;
  const memoryBytes = gpuMemoryBytes(layout, deviceDir, slot, nvidiaMemory);
  if (memoryBytes !== undefined) gpu.memoryBytes = memoryBytes;
  return Object.keys(gpu).length > 0 ? gpu : undefined;
}

function readHostGpus(layout: InventoryLayout): HostGpu[] | undefined {
  const cards = listDrmCardIndexes(layout);
  if (cards.length === 0) return undefined;
  const nvidiaMemory = readNvidiaMemoryMiBBySlot(layout);
  const gpus: HostGpu[] = [];
  for (const index of cards) {
    const gpu = readGpuFromCard(layout, index, nvidiaMemory);
    if (gpu) gpus.push(gpu);
  }
  return gpus.length > 0 ? gpus : undefined;
}

function combinedECpusList(layout: InventoryLayout): string | undefined {
  const atom = layout.readTextFile(layout.sysCpuAtom);
  const lowpower = layout.readTextFile(layout.sysCpuLowpower);
  const combined = new Set<number>();
  for (const text of [atom, lowpower]) {
    if (!text) continue;
    for (const n of parseCpulist(text)) combined.add(n);
  }
  if (combined.size === 0) return undefined;
  return [...combined].sort((a, b) => a - b).join(",");
}

function readLiveInventoryExtras(layout: InventoryLayout): HostInventoryExtras {
  const extras: HostInventoryExtras = {
    cacheForCpu: (cpuIndex) => readCpuCacheFromSysfs(layout, cpuIndex),
    freqForCpu: (cpuIndex) => readCpuFreqFromSysfs(layout, cpuIndex),
  };
  const pCpus = layout.readTextFile(layout.sysCpuCore);
  if (pCpus !== undefined) extras.pCpus = pCpus;
  const eCpus = combinedECpusList(layout);
  if (eCpus !== undefined) extras.eCpus = eCpus;
  const gpus = readHostGpus(layout);
  if (gpus) extras.gpus = gpus;
  return extras;
}

/**
 * Host capacity from `/proc` + `/sys` — process-cached after first successful
 * read. Safe under restricted read permissions (falls back to `cat`).
 *
 * Optional `io` remaps proc/sys roots (and nvidia-smi) for host-free tests;
 * injected reads are never written into the process cache.
 */
export function readHostResources(
  io?: HostInventoryIo,
): HostResources | undefined {
  if (!io && cached !== undefined) {
    return cached ?? undefined;
  }

  const layout = resolveInventoryLayout(io);
  const resources = hostResourcesFromProc(
    layout.readTextFile(layout.procStat),
    layout.readTextFile(layout.procMeminfo),
    layout.readTextFile(layout.procCpuinfo),
    layout.architecture,
    readLiveInventoryExtras(layout),
  );
  if (!io) {
    cached = resources ?? null;
  }
  return resources;
}

/** Test helper — clear process cache between fixture cases. */
export function resetHostResourcesCacheForTests(): void {
  cached = undefined;
}
