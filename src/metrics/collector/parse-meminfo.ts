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

export function parseMeminfo(text: string): MemoryGauges | null {
  const lines = text.split("\n");
  const memTotal = readKbField(lines, "MemTotal");
  const memAvailable = readKbField(lines, "MemAvailable");
  const swapTotal = readKbField(lines, "SwapTotal");
  const swapFree = readKbField(lines, "SwapFree");

  if (memTotal === undefined || memAvailable === undefined) return null;

  const memoryUsedBytes = memTotal - memAvailable;
  const memoryAvailableBytes = memAvailable;
  const memoryUsedPercent = memTotal > 0
    ? (memoryUsedBytes / memTotal) * 100
    : 0;

  let swapUsedPercent: number | null = null;
  if (
    swapTotal !== undefined && swapFree !== undefined && swapTotal > 0
  ) {
    swapUsedPercent = ((swapTotal - swapFree) / swapTotal) * 100;
  }

  return {
    memoryUsedBytes,
    memoryAvailableBytes,
    memoryUsedPercent,
    swapUsedPercent,
  };
}
