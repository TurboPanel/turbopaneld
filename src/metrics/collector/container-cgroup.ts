/**
 * cgroup v2 readers for the dedicated container parent slice.
 *
 * `daemon.json` carries `"cgroup-parent": "turbopanel-containers.slice"`
 * (orchestration `docker` role), so every container created since sits under
 * one cgroup and a handful of file reads give the whole fleet's CPU, memory
 * and OOM totals — no per-container Engine `stats` calls (expensive) and no
 * dependence on the events stream (which drops events across a reconnect).
 *
 * Containers created before the setting landed stay in the default slice
 * until recreated, so the totals under-count until the next deploy. A host
 * with cgroup v1, or without the slice yet, reads `null` — never `0`.
 */

/** Slice Docker is told to parent every container under (systemd driver). */
export const CONTAINER_CGROUP_PARENT = "turbopanel-containers.slice";

export const CGROUP_V2_ROOT = "/sys/fs/cgroup";

function keyedNumber(text: string, key: string): number | null {
  for (const line of text.split("\n")) {
    const [name, value] = line.trim().split(/\s+/);
    if (name !== key) continue;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

/** `cpu.stat` `usage_usec` — cumulative CPU time of the slice and its descendants. */
export function parseCpuUsageUsec(text: string): number | null {
  return keyedNumber(text, "usage_usec");
}

/** `memory.events` `oom_kill` — cumulative OOM kills in the slice's subtree. */
export function parseOomKills(text: string): number | null {
  return keyedNumber(text, "oom_kill");
}

/** `memory.stat` `inactive_file` — reclaimable page cache, excluded from "used". */
export function parseInactiveFile(text: string): number | null {
  return keyedNumber(text, "inactive_file");
}

/** Single-number file such as `memory.current`; `max` or garbage is `null`. */
export function parseSingleNumber(text: string): number | null {
  const parsed = Number(text.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** Working-set memory: `memory.current` minus `inactive_file`, floored at 0. */
export function containerMemoryBytes(
  memoryCurrentText: string | undefined,
  memoryStatText: string | undefined,
): number | null {
  if (memoryCurrentText === undefined) return null;
  const current = parseSingleNumber(memoryCurrentText);
  if (current === null) return null;
  const inactive = memoryStatText === undefined
    ? 0
    : parseInactiveFile(memoryStatText) ?? 0;
  return Math.max(0, current - inactive);
}

/**
 * CPU share of the WHOLE host, 0-100 — comparable with host CPU busy. Uses
 * the counter's own elapsed time, so a missed tick never doubles the value.
 */
export function containerCpuPercent(
  prev: { usageUsec: number; atMs: number } | undefined,
  usageUsec: number,
  atMs: number,
  cpuCount: number,
): number | null {
  if (!prev || cpuCount <= 0) return null;
  const elapsedUs = (atMs - prev.atMs) * 1000;
  const deltaUs = usageUsec - prev.usageUsec;
  if (elapsedUs <= 0 || deltaUs < 0) return null;
  return Math.min(100, Math.max(0, (deltaUs / (elapsedUs * cpuCount)) * 100));
}
