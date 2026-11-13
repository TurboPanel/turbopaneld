/**
 * The CPU and memory limits of one build.
 *
 * The control plane sends the smallest limit set for the build among the
 * organization, the server and the service (`buildLimits`:
 * `{ cores?: { cores, source }, memory?: { bytes, source } }`).
 *
 * Cores: with none set, half the host's cores, rounded down, at least 1; a
 * limit above the host's core count is capped to it; fractions are allowed.
 *
 * Memory: with none set, the host's RAM minus 1 GiB kept for the system, at
 * least 1 GiB and never more than the RAM; a limit above the RAM is capped.
 *
 * `tp-host build-run` takes both numbers as optional arguments, validates them
 * again and clamps them with the host's own figures, so this module decides the
 * numbers and says them in the deploy log.
 */

import {
  type BuildLimits,
  type BuildLimitSource,
  roundCores,
} from "../../contracts/build-limits.ts";

export type { BuildLimits, BuildLimitSource };

const GIB = 1024 ** 3;
/** RAM left to the system when no memory limit is set. */
export const SYSTEM_RESERVED_BYTES = GIB;
/** The smallest default memory limit. */
export const MIN_DEFAULT_BUILD_MEMORY_BYTES = GIB;

/**
 * What the host has: the figures the limits are clamped against. `memoryBytes`
 * is 0 when the RAM could not be read (the daemon's Deno grants allow reading
 * `/proc/meminfo` but not `systemMemoryInfo`); `tp-host` then decides alone.
 */
export type HostCapacity = { cores: number; memoryBytes: number };

/** One resolved limit: the level that set it, and whether it was lowered to fit the host. */
export type ResolvedLimit = {
  source: BuildLimitSource | "default";
  capped: boolean;
};

export type ResolvedBuildLimits = {
  cores: number;
  coresInfo: ResolvedLimit;
  /** Whether a core limit is passed to `tp-host` (else it uses its default). */
  coresSet: boolean;
  /** 0 when the host's RAM is unknown and no memory limit was set. */
  memoryBytes: number;
  memoryInfo: ResolvedLimit;
  /** Whether a memory limit is passed to `tp-host` (else it uses its default). */
  memorySet: boolean;
};

/** `MemTotal` of `/proc/meminfo` text in bytes, or 0. */
export function parseMemTotalBytes(meminfo: string): number {
  const match = /^MemTotal:\s+(\d+)\s+kB/m.exec(meminfo);
  return match ? Number(match[1]) * 1024 : 0;
}

/** The host's capacity as the daemon sees it. */
export async function readHostCapacity(): Promise<HostCapacity> {
  const count = navigator.hardwareConcurrency;
  let memoryBytes = 0;
  try {
    memoryBytes = parseMemTotalBytes(
      await Deno.readTextFile("/proc/meminfo"),
    );
  } catch {
    // Unreadable: memory stays unknown.
  }
  return {
    cores: Number.isInteger(count) && count >= 1 ? count : 1,
    memoryBytes,
  };
}

/** The default memory limit for a host with this much RAM. */
export function defaultBuildMemoryBytes(totalBytes: number): number {
  return Math.min(
    totalBytes,
    Math.max(
      MIN_DEFAULT_BUILD_MEMORY_BYTES,
      totalBytes - SYSTEM_RESERVED_BYTES,
    ),
  );
}

function resolveCores(
  requested: number | undefined,
  hostCores: number,
  capped: boolean,
): number {
  if (requested === undefined) return Math.max(1, Math.floor(hostCores / 2));
  return roundCores(capped ? hostCores : requested);
}

export function resolveBuildLimits(
  limits: BuildLimits | undefined,
  host: HostCapacity,
): ResolvedBuildLimits {
  const hostCores = Math.max(1, Math.floor(host.cores));
  const total = Math.max(0, Math.floor(host.memoryBytes));
  const coreLimit = limits?.cores;
  const memoryLimit = limits?.memory;

  const requestedCores = coreLimit === undefined
    ? undefined
    : Math.max(1, coreLimit.cores);
  const coresCapped = requestedCores !== undefined &&
    requestedCores > hostCores;
  const cores = resolveCores(requestedCores, hostCores, coresCapped);

  const memory = resolveMemory(memoryLimit?.bytes, total);

  return {
    cores,
    coresInfo: { source: coreLimit?.source ?? "default", capped: coresCapped },
    coresSet: coreLimit !== undefined,
    memoryBytes: memory.bytes,
    memoryInfo: {
      source: memoryLimit?.source ?? "default",
      capped: memory.capped,
    },
    memorySet: memoryLimit !== undefined,
  };
}

/** The memory limit: the request clamped to 1 GiB..the RAM, else the default. */
function resolveMemory(
  requested: number | undefined,
  total: number,
): { bytes: number; capped: boolean } {
  if (requested === undefined) {
    return {
      bytes: total > 0 ? defaultBuildMemoryBytes(total) : 0,
      capped: false,
    };
  }
  const raised = Math.max(requested, MIN_DEFAULT_BUILD_MEMORY_BYTES);
  if (total === 0) return { bytes: raised, capped: false };
  return { bytes: Math.min(raised, total), capped: raised > total };
}

/**
 * `tp-host build-run`'s fourth argument: plain decimal, no exponent; `-` when
 * no core limit was set, so `tp-host` applies its own default.
 */
export function buildCoresArg(resolved: ResolvedBuildLimits): string {
  return resolved.coresSet ? String(roundCores(resolved.cores)) : "-";
}

/** The fifth argument: whole bytes, or `-` when no memory limit was set. */
export function buildMemoryArg(resolved: ResolvedBuildLimits): string {
  return resolved.memorySet ? String(Math.floor(resolved.memoryBytes)) : "-";
}

function coresText(cores: number): string {
  return `${cores} ${cores === 1 ? "core" : "cores"}`;
}

/** "2.8 GB": 1024-based, one decimal (none when whole). */
export function formatBuildMemory(bytes: number): string {
  const gb = bytes / GIB;
  if (gb >= 1) return `${Math.round(gb * 10) / 10} GB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function why(info: ResolvedLimit, what: string): string {
  if (info.source === "default") return "default";
  return info.capped
    ? `${info.source} limit, capped to ${what}`
    : `${info.source} limit`;
}

/**
 * The deploy-log line: "Build limited to 2 cores (server limit) and 2.8 GB
 * memory (default)".
 */
export function describeBuildLimits(
  resolved: ResolvedBuildLimits,
  host: HostCapacity,
): string {
  const coresWhy = why(
    resolved.coresInfo,
    "the server's " + coresText(host.cores),
  );
  const memoryWhy = why(
    resolved.memoryInfo,
    "the server's " + formatBuildMemory(host.memoryBytes),
  );
  const cores = `${coresText(resolved.cores)} (${coresWhy})`;
  const amount = resolved.memoryBytes > 0
    ? `${formatBuildMemory(resolved.memoryBytes)} memory`
    : "the default memory";
  const memory = `${amount} (${memoryWhy})`;
  return `Build limited to ${cores} and ${memory}`;
}

/** The out-of-memory message for a build that hit its limit. */
export function buildOutOfMemoryMessage(memoryBytes: number): string {
  const limit = memoryBytes > 0
    ? " (limit " + formatBuildMemory(memoryBytes) + ")"
    : "";
  return `The build ran out of memory${limit}. Raise Build Memory or reduce the build's memory use.`;
}
