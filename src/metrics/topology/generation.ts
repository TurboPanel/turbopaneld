/**
 * Topology-generation tracking: persists `<daemonStateDir>/metrics/
 * topology-generation.json` (atomic write, same discipline as
 * `sensors/overrides.ts`'s `writeHardwareProfile`) and compares a
 * deterministic fingerprint of the slot-affecting identity — network device
 * id set, filesystem id set, service-device block-device id set, GPU id set,
 * physical-signal id set, and the resolved `SlotMapping` (which already
 * reflects any operator override that reassigns a slot) — against the
 * previous tick's fingerprint. Cosmetic changes (a renamed interface with the
 * same MAC, a signal's current reading) never touch this fingerprint, so they
 * never bump the generation.
 *
 * Sizes (memory, swap, CPU shape, filesystem capacities) are part of it only
 * until the control plane advertises `metrics-v8-sizes`. A control plane
 * without that feature divides live use by the totals of the generation's
 * first snapshot, so a resize must start a new generation or the old total
 * sticks. Once it is negotiated every sample carries the sizes it was
 * measured against (`extended.sizes`), nothing needs a generation for a
 * resize, and a flood of different sizes cannot grow the history.
 *
 * The persisted file carries the fingerprint (not just the bare generation
 * number) because an override can reassign a slot — flipping which of two
 * already-known devices is NIC1 — without changing any identity *set*;
 * only the resolved `SlotMapping` reflects that. Comparing the full
 * fingerprint (sets + slot mapping) in one pass covers both triggers with a
 * single stored value.
 */
import { join } from "@std/path";

import { resolveLayout } from "../../paths/layout.ts";
import { writeTextFileAtomic } from "../atomic-write.ts";
import { computeSlotMapping } from "../../contracts/topology-slot-mapping.ts";
import type {
  SlotMapping,
  TopologyOverrides,
  TopologySnapshotInputs,
} from "../../contracts/topology-types.ts";

export const TOPOLOGY_GENERATION_RELATIVE_PATH =
  "metrics/topology-generation.json";

export function topologyGenerationPath(daemonStateDir: string): string {
  return join(daemonStateDir, TOPOLOGY_GENERATION_RELATIVE_PATH);
}

export type TopologyFingerprint = {
  networkDeviceIds: string[];
  filesystemIds: string[];
  serviceBlockDeviceIds: string[];
  gpuIds: string[];
  hardwareSignalIds: string[];
  slotMapping: SlotMapping;
  /**
   * Machine size, present only while `metrics-v8-sizes` is not negotiated.
   * Memory and swap totals are compared with a tolerance of
   * `MEMORY_TOTAL_TOLERANCE_BYTES` (32 MiB): `/proc/meminfo` totals move by a
   * few KB to a few MB across kernels, boots and balloon, which must never bump
   * the generation; a real resize is hundreds of MB at least.
   */
  sizes?: TopologySizes;
};

export type TopologySizes = {
  memoryTotalBytes: number | null;
  swapTotalBytes: number | null;
  filesystemCapacities: Array<{
    filesystemId: string;
    totalBytes: number | null;
    totalInodes: number | null;
  }>;
  cpuShape: {
    sockets: number;
    coresPerSocket: number;
    threadsPerSocket: number;
    logicalCores: number;
  };
};

export const MEMORY_TOTAL_TOLERANCE_BYTES = 32 * 1024 * 1024;

/**
 * Sizes reach the wire only with both features (a panel listing the sizes
 * without `metrics-v8` gets stamp 6 and no sizes), so both gate the fingerprint.
 */
export function sizesFeaturesNegotiated(features: readonly string[]): boolean {
  return features.includes("metrics-v8") &&
    features.includes("metrics-v8-sizes");
}

let sizesNegotiated = false;

/** Set from the control-plane attach: `true` once it advertises `metrics-v8-sizes`. */
export function setTopologySizesNegotiated(value: boolean): void {
  sizesNegotiated = value;
}

export type TopologyGenerationState = {
  generation: number;
  appliedAt: string;
  fingerprint: TopologyFingerprint;
};

function sortedIds<T>(items: T[], idOf: (item: T) => string): string[] {
  return items.map(idOf).sort((a, b) => a.localeCompare(b));
}

/** Deterministic slot-affecting identity snapshot — the sole input to generation comparison. */
export function computeTopologyFingerprint(
  current: TopologySnapshotInputs,
  overrides: TopologyOverrides,
  includeSizes = false,
): TopologyFingerprint {
  const fingerprint: TopologyFingerprint = {
    networkDeviceIds: sortedIds(current.networks, (n) => n.deviceId),
    filesystemIds: sortedIds(current.filesystems, (fs) => fs.filesystemId),
    serviceBlockDeviceIds: sortedIds(
      current.blockDevices.filter((device) => device.isServiceDevice),
      (device) => device.deviceId,
    ),
    gpuIds: sortedIds(current.gpus, (g) => g.gpuId),
    hardwareSignalIds: sortedIds(current.hardwareSignals, (s) => s.signalId),
    slotMapping: computeSlotMapping({ ...current, generation: 0 }, overrides),
  };
  if (includeSizes) fingerprint.sizes = sizesOf(current);
  return fingerprint;
}

function sizesOf(current: TopologySnapshotInputs): TopologySizes {
  return {
    memoryTotalBytes: current.memoryTotalBytes,
    swapTotalBytes: current.swapTotalBytes,
    filesystemCapacities: current.filesystems
      .map((fs) => ({
        filesystemId: fs.filesystemId,
        totalBytes: fs.totalBytes,
        totalInodes: fs.totalInodes,
      }))
      .sort((a, b) => a.filesystemId.localeCompare(b.filesystemId)),
    cpuShape: {
      sockets: current.cpu.sockets,
      coresPerSocket: current.cpu.coresPerSocket,
      threadsPerSocket: current.cpu.threadsPerSocket,
      logicalCores: current.cpu.cores.length,
    },
  };
}

function totalWithinTolerance(a: unknown, b: unknown): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a !== "number" || typeof b !== "number") return false;
  return Math.abs(a - b) <= MEMORY_TOTAL_TOLERANCE_BYTES;
}

/**
 * `a` may carry no sizes (stored while `metrics-v8-sizes` was negotiated, or
 * by an earlier build): there is nothing to compare, so it counts as equal and
 * the caller stores a size baseline.
 */
function sizesEqual(a: TopologySizes | undefined, b: TopologySizes): boolean {
  if (!a) return true;
  if (!totalWithinTolerance(a.memoryTotalBytes, b.memoryTotalBytes)) {
    return false;
  }
  if (!totalWithinTolerance(a.swapTotalBytes, b.swapTotalBytes)) return false;
  return JSON.stringify([a.filesystemCapacities, a.cpuShape]) ===
    JSON.stringify([b.filesystemCapacities, b.cpuShape]);
}

/**
 * Compares the identity fields, and the sizes only when `b` (this tick's
 * fingerprint) carries them, i.e. while `metrics-v8-sizes` is not negotiated.
 * Extra fields on a persisted record are ignored.
 */
function fingerprintsEqual(
  a: TopologyFingerprint,
  b: TopologyFingerprint,
): boolean {
  const identity = (f: TopologyFingerprint) =>
    JSON.stringify([
      f.networkDeviceIds,
      f.filesystemIds,
      f.serviceBlockDeviceIds,
      f.gpuIds,
      f.hardwareSignalIds,
      f.slotMapping,
    ]);
  if (identity(a) !== identity(b)) return false;
  return b.sizes === undefined || sizesEqual(a.sizes, b.sizes);
}

/** Pure comparison: `previous`'s generation is reused when the fingerprint is unchanged, else incremented. `null` (no prior state) starts at `0`. */
export function computeTopologyGeneration(
  previous: { generation: number; fingerprint: TopologyFingerprint } | null,
  fingerprint: TopologyFingerprint,
): number {
  if (!previous) return 0;
  return fingerprintsEqual(previous.fingerprint, fingerprint)
    ? previous.generation
    : previous.generation + 1;
}

async function readPersistedState(
  path: string,
): Promise<TopologyGenerationState | null> {
  try {
    const text = await Deno.readTextFile(path);
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.generation !== "number" ||
      typeof record.appliedAt !== "string" ||
      typeof record.fingerprint !== "object" || record.fingerprint === null
    ) {
      return null;
    }
    return record as unknown as TopologyGenerationState;
  } catch {
    return null;
  }
}

async function writePersistedState(
  path: string,
  state: TopologyGenerationState,
): Promise<void> {
  await writeTextFileAtomic(path, JSON.stringify(state));
}

export type ResolveTopologyGenerationDeps = {
  daemonStateDir?: string;
  now?: () => string;
  /** Override the negotiated flag (tests); defaults to {@link setTopologySizesNegotiated}. */
  sizesNegotiated?: boolean;
};

/**
 * Resolve and persist this tick's topology generation. Reuses the previous
 * `appliedAt` when the generation didn't change; stamps a fresh one only on
 * an actual bump — the same discipline `HardwareProfile.generationAppliedAt`
 * follows.
 */
export async function resolveTopologyGeneration(
  current: TopologySnapshotInputs,
  overrides: TopologyOverrides,
  deps: ResolveTopologyGenerationDeps = {},
): Promise<number> {
  const stateDir = deps.daemonStateDir ??
    resolveLayout(Deno.env.toObject()).daemonStateDir;
  const path = topologyGenerationPath(stateDir);
  const now = deps.now ?? (() => new Date().toISOString());

  const [previous, fingerprint] = await Promise.all([
    readPersistedState(path),
    Promise.resolve(
      computeTopologyFingerprint(
        current,
        overrides,
        !(deps.sizesNegotiated ?? sizesNegotiated),
      ),
    ),
  ]);

  const generation = computeTopologyGeneration(previous, fingerprint);
  const appliedAt = previous?.generation === generation
    ? previous.appliedAt
    : now();

  // On a reused generation keep the stored fingerprint, so tolerated jitter
  // in the memory totals cannot drift the baseline tick by tick.
  const stored = previous?.generation === generation &&
      fingerprint.sizes && previous.fingerprint.sizes
    ? previous.fingerprint
    : fingerprint;
  await writePersistedState(path, {
    generation,
    appliedAt,
    fingerprint: stored,
  });
  return generation;
}
