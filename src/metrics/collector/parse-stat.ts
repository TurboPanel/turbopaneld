import type { CpuCounters } from "./types.ts";

function parseOptionalField(
  parts: string[],
  index: number,
): number | undefined {
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
 * Parse one `cpu`/`cpuN`-labeled line from `/proc/stat`. Missing trailing
 * fields are tolerated (distro/kernel variance). `guest`/`guest_nice` (fields
 * 9/10) are captured but never added into `total`/`active` — the kernel
 * already folds guest ticks into `user`/`nice`, so summing them again would
 * double-count.
 */
function parseStatCounterLine(
  label: string,
  line: string,
): CpuCounters | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 5 || parts[0] !== label) return null;

  const fields = parts.slice(1);
  const user = parseOptionalField(fields, 0);
  const nice = parseOptionalField(fields, 1);
  const system = parseOptionalField(fields, 2);
  const idle = parseOptionalField(fields, 3);
  const iowait = parseOptionalField(fields, 4);
  const irq = parseOptionalField(fields, 5);
  const softirq = parseOptionalField(fields, 6);
  const steal = parseOptionalField(fields, 7);
  const guest = parseOptionalField(fields, 8);
  const guestNice = parseOptionalField(fields, 9);

  if (
    user === undefined && nice === undefined && system === undefined &&
    idle === undefined
  ) {
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
    guest,
    guestNice,
    total,
    active,
  };
}

/** Parse the aggregate `cpu` line from `/proc/stat`. */
export function parseStatCpuLine(line: string): CpuCounters | null {
  return parseStatCounterLine("cpu", line);
}

/** Extract aggregate `cpu` counters from full `/proc/stat` text. */
export function parseStat(text: string): CpuCounters | null {
  const firstLine = text.split("\n")[0];
  if (!firstLine) return null;
  return parseStatCpuLine(firstLine);
}

/** Every `cpuN` per-core counter line, keyed by core index string (`"0"`, `"1"`, ...). */
export function parseStatPerCoreLines(
  text: string,
): Record<string, CpuCounters> {
  const cores: Record<string, CpuCounters> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const match = /^cpu(\d+)\s/.exec(trimmed);
    if (!match) continue;
    const counters = parseStatCounterLine(`cpu${match[1]}`, trimmed);
    if (counters) cores[match[1]] = counters;
  }
  return cores;
}

/** `procs_running`/`procs_blocked` gauges; `null` when a field is absent. */
export function parseStatProcs(
  text: string,
): { running: number | null; blocked: number | null } {
  let running: number | null = null;
  let blocked: number | null = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("procs_running ")) {
      const value = Number(trimmed.slice("procs_running ".length).trim());
      running = Number.isFinite(value) ? value : null;
    } else if (trimmed.startsWith("procs_blocked ")) {
      const value = Number(trimmed.slice("procs_blocked ".length).trim());
      blocked = Number.isFinite(value) ? value : null;
    }
  }
  return { running, blocked };
}

/**
 * Scalar cumulative counters (`ctxt`/`processes`/`intr`) from `/proc/stat`.
 * Parsed now (free from the same file read) but reserved for a future
 * `host.diagnostics` family (`collector/diagnostics.ts`).
 */
export function parseStatScalarCounters(
  text: string,
): { ctxt: number | null; processes: number | null; intr: number | null } {
  let ctxt: number | null = null;
  let processes: number | null = null;
  let intr: number | null = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("ctxt ")) {
      const value = Number(trimmed.slice("ctxt ".length).trim());
      ctxt = Number.isFinite(value) ? value : null;
    } else if (trimmed.startsWith("processes ")) {
      const value = Number(trimmed.slice("processes ".length).trim());
      processes = Number.isFinite(value) ? value : null;
    } else if (trimmed.startsWith("intr ")) {
      const value = Number(
        trimmed.slice("intr ".length).trim().split(/\s+/)[0],
      );
      intr = Number.isFinite(value) ? value : null;
    }
  }
  return { ctxt, processes, intr };
}
