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
