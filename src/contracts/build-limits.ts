/**
 * The wire shape of a build's resource limits (`build-limits-v1`), shared
 * by the deploy contract and the build code. Semantics:
 * `../deploy/release/build-limits.ts`.
 */

/** Which level set the limit that won (the smallest one set). */
export type BuildLimitSource = "organization" | "server" | "service";

/** The most CPU cores one build may use, as the control plane resolved it. */
export type BuildCoreLimit = { cores: number; source: BuildLimitSource };

/** The most memory one build may use, in bytes. */
export type BuildMemoryLimit = { bytes: number; source: BuildLimitSource };

/** Whether a build may use swap (off unless a level opts in). */
export type BuildSwapLimit = { allowed: boolean; source: BuildLimitSource };

/** What the control plane resolved for one build; any part may be absent. */
export type BuildLimits = {
  cores?: BuildCoreLimit;
  memory?: BuildMemoryLimit;
  swap?: BuildSwapLimit;
};

const SOURCES: ReadonlySet<string> = new Set([
  "organization",
  "server",
  "service",
]);

/** `tp-host`'s rule: at most 3 digits before the point and 2 after. */
export const MAX_BUILD_CORES = 999;
/**
 * The smallest memory limit a level may set. `tp-host`, the daemon and this
 * contract share it: a smaller request is raised to it (never above the RAM).
 */
export const MIN_BUILD_MEMORY_BYTES = 1024 ** 3;
/** One tebibyte: far above any host, and 13 digits for `tp-host`. */
export const MAX_BUILD_MEMORY_BYTES = 1024 ** 4;

export function roundCores(cores: number): number {
  return Math.round(cores * 100) / 100;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`Invalid ${field}`);
  }
  return value as Record<string, unknown>;
}

function parseSource(value: unknown, field: string): BuildLimitSource {
  if (typeof value !== "string" || !SOURCES.has(value)) {
    throw new TypeError(`Invalid ${field} source`);
  }
  return value as BuildLimitSource;
}

function parseCores(value: unknown, field: string): BuildCoreLimit | undefined {
  if (value === undefined) return undefined;
  const { cores, source } = asRecord(value, `${field} cores`);
  if (
    typeof cores !== "number" || !Number.isFinite(cores) || cores < 1 ||
    cores > MAX_BUILD_CORES
  ) {
    throw new TypeError(`Invalid ${field} cores`);
  }
  return { cores: roundCores(cores), source: parseSource(source, field) };
}

function parseMemory(
  value: unknown,
  field: string,
): BuildMemoryLimit | undefined {
  if (value === undefined) return undefined;
  const { bytes, source } = asRecord(value, `${field} memory`);
  if (
    typeof bytes !== "number" || !Number.isInteger(bytes) ||
    bytes < MIN_BUILD_MEMORY_BYTES || bytes > MAX_BUILD_MEMORY_BYTES
  ) {
    throw new TypeError(`Invalid ${field} memory`);
  }
  return { bytes, source: parseSource(source, field) };
}

function parseSwap(value: unknown, field: string): BuildSwapLimit | undefined {
  if (value === undefined) return undefined;
  const { allowed, source } = asRecord(value, `${field} swap`);
  if (typeof allowed !== "boolean") {
    throw new TypeError(`Invalid ${field} swap`);
  }
  return { allowed, source: parseSource(source, field) };
}

/** Parse the wire value; `undefined` when missing, a TypeError when malformed. */
export function parseBuildLimits(
  value: unknown,
  field = "buildLimits",
): BuildLimits | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value, field);
  const cores = parseCores(record.cores, field);
  const memory = parseMemory(record.memory, field);
  const swap = parseSwap(record.swap, field);
  if (cores === undefined && memory === undefined && swap === undefined) {
    return undefined;
  }
  return {
    ...(cores === undefined ? {} : { cores }),
    ...(memory === undefined ? {} : { memory }),
    ...(swap === undefined ? {} : { swap }),
  };
}
