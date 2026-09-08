import type { MemoryGauges } from "./types.ts";

const KB_LINE_PATTERN = /^(\w+):\s+(\d+)\s+kB/;

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
  return Math.max(0, total);
}

/**
 * Raw `/proc/meminfo` byte gauges feeding the memory half of
 * `DiagnosticsSample` — every field `null` (never `0`) when its line is
 * absent.
 *
 * v6 dropped seven gauges v5 collected here: `PageTables`, `KernelStack`,
 * and `CommitLimit` (near-static or derivable), and the four
 * `Active(anon)`/`Inactive(anon)`/`Active(file)`/`Inactive(file)` LRU
 * gauges, which nothing charted and which the retained `AnonPages`/`Cached`
 * pair already summarizes. Dropping them is what lets the merged
 * `host.diagnostics` family fit one 19-slot row.
 */
export type MeminfoDiagnosticsGauges = {
  memoryFreeBytes: number | null;
  cachedBytes: number | null;
  anonPagesBytes: number | null;
  slabReclaimableBytes: number | null;
  slabUnreclaimableBytes: number | null;
  dirtyBytes: number | null;
  writebackBytes: number | null;
  shmemBytes: number | null;
  committedAsBytes: number | null;
};

/** Parse the diagnostics memory gauge fields from `/proc/meminfo` text. */
export function parseMeminfoDiagnostics(
  text: string,
): MeminfoDiagnosticsGauges {
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
    committedAsBytes: readKbField(lines, "Committed_AS") ?? null,
  };
}
