/**
 * Memory domain: raw v2 byte gauges straight from `/proc/meminfo`.
 *
 * `parse-meminfo.ts` stays the pure line parser; this module is the domain
 * seam the orchestrator consumes. All five fields are raw pass-throughs —
 * percent math never happens in the collector.
 */
import { parseMeminfo } from "./parse-meminfo.ts";
import type { MemoryGauges } from "./types.ts";

/** Raw memory gauges from `/proc/meminfo` text, or `null` when unparsable. */
export function readMemoryGauges(text: string): MemoryGauges | null {
  return parseMeminfo(text);
}
