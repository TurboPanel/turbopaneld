/**
 * `/proc/pressure/{cpu,memory,io}` (PSI) parsing and percent-of-interval
 * conversion. PSI `total` fields are cumulative microsecond counters — a
 * percent reading needs a two-snapshot delta through the shared
 * `CounterBaselineTracker`, never a single-snapshot instantaneous value.
 */
import type { CounterBaselineTracker } from "./baseline.ts";

export type PsiKind = "some" | "full";

/**
 * Parse one `some`/`full` line's `total=<µs>` field. `null` when that line
 * (or the field) is absent — older kernels expose no `full` line for CPU.
 */
export function parsePsiLine(text: string, kind: PsiKind): number | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(`${kind} `) && trimmed !== kind) continue;
    const match = /total=(\d+)/.exec(trimmed);
    if (!match) return null;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

export type PsiTotals = {
  someTotalUs: number | null;
  fullTotalUs: number | null;
};

/**
 * Read and parse one PSI file (`/proc/pressure/{cpu,memory,io}`). When the
 * file itself is unreadable (PSI unsupported/disabled), both fields are
 * `null` — never a fabricated `0`.
 */
export async function readPsi(
  readProcFile: (
    path: string,
  ) => string | undefined | Promise<string | undefined>,
  path: string,
): Promise<PsiTotals> {
  const text = await readProcFile(path);
  if (text === undefined) return { someTotalUs: null, fullTotalUs: null };
  return {
    someTotalUs: parsePsiLine(text, "some"),
    fullTotalUs: parsePsiLine(text, "full"),
  };
}

function clampPercent(value: number): number {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

/**
 * Convert a two-snapshot `total` µs delta to a percent-of-interval reading.
 * `null` when the source was unreadable this tick, on first observation, or
 * across a reboot/counter reset — never `0` for "PSI unsupported".
 */
export function psiPercent(
  currTotalUs: number | null,
  seconds: number,
  tracker: CounterBaselineTracker,
  key: string,
  bootGeneration: number,
): number | null {
  if (currTotalUs === null) return null;
  const deltaUs = tracker.delta(key, currTotalUs, bootGeneration);
  if (deltaUs === null) return null;
  if (seconds <= 0) return null;
  const deltaMs = deltaUs / 1000;
  const intervalMs = seconds * 1000;
  return clampPercent((deltaMs / intervalMs) * 100);
}
