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
  const swapTotal = readKbField(lines, "SwapTotal");
  const swapFree = readKbField(lines, "SwapFree");

  if (memTotal === undefined || memAvailable === undefined) return null;

  const swapAbsent = swapTotal === undefined || swapFree === undefined ||
    swapTotal <= 0;

  return {
    totalBytes: memTotal,
    availableBytes: memAvailable,
    freeBytes: memFree ?? null,
    swapTotalBytes: swapAbsent ? null : swapTotal,
    swapFreeBytes: swapAbsent ? null : swapFree,
  };
}

/** Raw `/proc/meminfo` byte gauges feeding `MemoryDetailSampleV4` — every field `null` (never `0`) when its line is absent. */
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

/** Parse the §40 `MemoryDetailSampleV4` gauge fields from `/proc/meminfo` text. */
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
