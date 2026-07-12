import type { CpuCounters } from "./types.ts";

function parseOptionalField(parts: string[], index: number): number | undefined {
  if (index >= parts.length) return undefined;
  const value = Number(parts[index]);
  return Number.isFinite(value) ? value : undefined;
}

/** Number of jiffies fields on the aggregate `cpu` line (excludes the `cpu` label). */
export function cpuLineFieldCount(line: string): number | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2 || parts[0] !== "cpu") return null;
  return parts.length - 1;
}

/**
 * Parse the aggregate `cpu` line from `/proc/stat`.
 * Missing trailing fields are tolerated (distro/kernel variance).
 */
export function parseStatCpuLine(line: string): CpuCounters | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 5 || parts[0] !== "cpu") return null;

  const fields = parts.slice(1);
  const user = parseOptionalField(fields, 0);
  const nice = parseOptionalField(fields, 1);
  const system = parseOptionalField(fields, 2);
  const idle = parseOptionalField(fields, 3);
  const iowait = parseOptionalField(fields, 4);
  const irq = parseOptionalField(fields, 5);
  const softirq = parseOptionalField(fields, 6);
  const steal = parseOptionalField(fields, 7);

  if (user === undefined && nice === undefined && system === undefined &&
    idle === undefined) {
    return null;
  }

  let total = 0;
  for (const value of [user, nice, system, idle, iowait, irq, softirq, steal]) {
    if (value !== undefined) total += value;
  }

  const idleValue = idle ?? 0;
  const iowaitValue = iowait ?? 0;
  const active = total - idleValue - iowaitValue;

  return {
    user,
    nice,
    system,
    idle,
    iowait,
    irq,
    softirq,
    steal,
    total,
    active,
  };
}

/** Extract aggregate `cpu` counters from full `/proc/stat` text. */
export function parseStat(text: string): CpuCounters | null {
  const firstLine = text.split("\n")[0];
  if (!firstLine) return null;
  return parseStatCpuLine(firstLine);
}
