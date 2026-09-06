/**
 * Topology-generation tracking: persists `<daemonStateDir>/metrics/
 * topology-generation.json` (atomic write, same discipline as
 * `sensors/overrides.ts`'s `writeHardwareProfile`) and compares a
 * deterministic fingerprint of the slot-affecting identity — network device
 * id set, filesystem id set, service-device block-device id set, GPU id
 * set, physical-signal id set, and the resolved `SlotMapping` (which
 * already reflects any operator override that reassigns a slot) — against
 * the previous tick's fingerprint. Cosmetic changes (a renamed interface
 * with the same MAC, a signal's current reading) never touch this
 * fingerprint, so they never bump the generation.
 *
 * The persisted file carries the fingerprint (not just the bare generation
 * number) because an override can reassign a slot — flipping which of two
 * already-known devices is NIC1 — without changing any identity *set*;
 * only the resolved `SlotMapping` reflects that. Comparing the full
 * fingerprint (sets + slot mapping) in one pass covers both triggers with a
 * single stored value.
 */
import { dirname, join } from "@std/path";

import { resolveLayout } from "../../paths/layout.ts";
import { computeSlotMapping } from "./slot-mapping.ts";
import type {
  SlotMapping,
  TopologyOverrides,
  TopologySnapshotInputs,
} from "./types.ts";

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
};

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
): TopologyFingerprint {
  return {
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
}

function fingerprintsEqual(
  a: TopologyFingerprint,
  b: TopologyFingerprint,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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
  await Deno.mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  await Deno.writeTextFile(tmpPath, JSON.stringify(state));
  await Deno.rename(tmpPath, path);
}

export type ResolveTopologyGenerationDeps = {
  daemonStateDir?: string;
  now?: () => string;
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
    Promise.resolve(computeTopologyFingerprint(current, overrides)),
  ]);

  const generation = computeTopologyGeneration(previous, fingerprint);
  const appliedAt = previous?.generation === generation
    ? previous.appliedAt
    : now();

  await writePersistedState(path, { generation, appliedAt, fingerprint });
  return generation;
}
