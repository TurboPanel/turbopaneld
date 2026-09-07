import type { MemoryGauges } from "./types.ts";

const KB_LINE_PATTERN = /^(\w+):\s+(\d+)\s+kB/;
// `Active(anon)`/`Inactive(file)`-style keys carry parentheses the plain
// `\w+` pattern above can't match.
const KB_LINE_PATTERN_WITH_PARENS = /^([\w()]+):\s+(\d+)\s+kB/;

function readKbField(
  lines: string[],
  key: string,
): number | undefined {
  for (const line of lines) {
    const match = KB_LINE_PATTERN.exec(line);
    if (match?.[1] !== key) continue;
    const bytes = Number(match[2]) * 1024;
    return Number.isFinite(bytes) ? bytes : undefined;
  }
  return undefined;
}

function readKbFieldWithParens(
  lines: string[],
  key: string,
): number | undefined {
  for (const line of lines) {
    const match = KB_LINE_PATTERN_WITH_PARENS.exec(line);
    if (match?.[1] !== key) continue;
    const bytes = Number(match[2]) * 1024;
    return Number.isFinite(bytes) ? bytes : undefined;
  }
  return undefined;
}

/**
 * Parse `/proc/meminfo` into raw byte gauges — no derived percentages
 * (used/percent math is an API-side concern in the v2 contract).
 *
 * Swap-absent hosts (missing `SwapTotal`/`SwapFree` lines, or a zero
 * `SwapTotal`) yield `null` for both swap fields, never `0`.
 */
export function parseMeminfo(text: string): MemoryGauges | null {
  const lines = text.split("\n");
  const memTotal = readKbField(lines, "MemTotal");
  const memAvailable = readKbField(lines, "MemAvailable");
  const memFree = readKbField(lines, "MemFree");
  const cached = readKbField(lines, "Cached");
  const buffers = readKbField(lines, "Buffers");
  const slabReclaimable = readKbField(lines, "SReclaimable");
  const shmem = readKbField(lines, "Shmem");
  const swapTotal = readKbField(lines, "SwapTotal");
  const swapFree = readKbField(lines, "SwapFree");

  if (memTotal === undefined || memAvailable === undefined) return null;

  const swapAbsent = swapTotal === undefined || swapFree === undefined ||
    swapTotal <= 0;

  return {
    totalBytes: memTotal,
    availableBytes: memAvailable,
    usedBytes: memTotal - memAvailable,
    cachedFilesBytes: cachedFilesBytes(cached, buffers, slabReclaimable, shmem),
    freeBytes: memFree ?? null,
    swapTotalBytes: swapAbsent ? null : swapTotal,
    swapFreeBytes: swapAbsent ? null : swapFree,
  };
}

/**
 * Reclaimable page cache backing files — the "Cached files" figure.
 *
 * `Cached + Buffers + SReclaimable - Shmem`. `Buffers` is block-device
 * buffer cache, which `Cached` excludes. `SReclaimable` is the reclaimable
 * half of slab (mostly dentry/inode cache), which is file-backed in
 * everything but name. `Shmem` is subtracted because tmpfs/shared pages are
 * counted inside `Cached` but are *not* reclaimable file cache — leaving
 * them in overstates what the kernel could hand back under pressure.
 *
 * `null` when `Cached` is absent; the other three are optional and treated
 * as `0` only once `Cached` proved the source is a real meminfo.
 */
function cachedFilesBytes(
  cached: number | undefined,
  buffers: number | undefined,
  slabReclaimable: number | undefined,
  shmem: number | undefined,
): number | null {
  if (cached === undefined) return null;
  const total = cached + (buffers ?? 0) + (slabReclaimable ?? 0) - (shmem ?? 0);
  return total < 0 ? 0 : total;
}

/** Raw `/proc/meminfo` byte gauges feeding `MemoryDetailSampleV5` — every field `null` (never `0`) when its line is absent. */
export type MeminfoDetailGauges = {
  memoryFreeBytes: number | null;
  cachedBytes: number | null;
  anonPagesBytes: number | null;
  slabReclaimableBytes: number | null;
  slabUnreclaimableBytes: number | null;
  dirtyBytes: number | null;
  writebackBytes: number | null;
  shmemBytes: number | null;
  pageTablesBytes: number | null;
  kernelStackBytes: number | null;
  committedAsBytes: number | null;
  commitLimitBytes: number | null;
  activeAnonBytes: number | null;
  inactiveAnonBytes: number | null;
  activeFileBytes: number | null;
  inactiveFileBytes: number | null;
};

/** Parse the §40 `MemoryDetailSampleV5` gauge fields from `/proc/meminfo` text. */
export function parseMeminfoDetail(text: string): MeminfoDetailGauges {
  const lines = text.split("\n");
  return {
    memoryFreeBytes: readKbField(lines, "MemFree") ?? null,
    cachedBytes: readKbField(lines, "Cached") ?? null,
    anonPagesBytes: readKbField(lines, "AnonPages") ?? null,
    slabReclaimableBytes: readKbField(lines, "SReclaimable") ?? null,
    slabUnreclaimableBytes: readKbField(lines, "SUnreclaim") ?? null,
    dirtyBytes: readKbField(lines, "Dirty") ?? null,
    writebackBytes: readKbField(lines, "Writeback") ?? null,
    shmemBytes: readKbField(lines, "Shmem") ?? null,
    pageTablesBytes: readKbField(lines, "PageTables") ?? null,
    kernelStackBytes: readKbField(lines, "KernelStack") ?? null,
    committedAsBytes: readKbField(lines, "Committed_AS") ?? null,
    commitLimitBytes: readKbField(lines, "CommitLimit") ?? null,
    activeAnonBytes: readKbFieldWithParens(lines, "Active(anon)") ?? null,
    inactiveAnonBytes: readKbFieldWithParens(lines, "Inactive(anon)") ?? null,
    activeFileBytes: readKbFieldWithParens(lines, "Active(file)") ?? null,
    inactiveFileBytes: readKbFieldWithParens(lines, "Inactive(file)") ?? null,
  };
}
