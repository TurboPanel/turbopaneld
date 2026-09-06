/**
 * Topology orchestrator — the module's public entry point. Composes every
 * `*-topology.ts` discovery module (in parallel where independent), then
 * stamps the result with this tick's topology generation via
 * `generation.ts`.
 *
 * Discovery only: no telemetry (GPU utilization, hardware-signal readings)
 * is collected here — that's a later phase's job (see `../AGENTS.md`).
 */
import { statfs } from "node:fs/promises";

import { resolveDockerDataRoot } from "../../host/docker.ts";
import { FABRIC_INTERFACE_NAME } from "../../instance/commands/fabric.ts";
import { resolveHostingPath } from "../collector/hosting.ts";
import { backingDeviceNames, parseProcMounts } from "../collector/mounts.ts";
import { defaultSensorIo } from "../collector/sensors/discovery.ts";
import { parseMeminfo } from "../collector/parse-meminfo.ts";
import { readProcFile } from "../collector/proc-read.ts";
import type { StatfsResult } from "../collector/types.ts";

import { resolveBootGeneration } from "./boot-generation.ts";
import { collectBlockTopology } from "./block-topology.ts";
import { collectCpuTopology } from "./cpu-topology.ts";
import { collectFilesystemTopology } from "./filesystem-topology.ts";
import { collectGpuTopology } from "./gpu-topology.ts";
import { collectHardwareSignals as defaultCollectHardwareSignals } from "./hardware-signal-topology.ts";
import type { IdentityIo } from "./identity.ts";
import { collectNetworkTopology } from "./network-topology.ts";
import { collectNumaTopology } from "./numa-topology.ts";
import { resolveTopologyOverrides } from "./overrides.ts";
import { isPhysicalMachine } from "./physical-classifier.ts";
import { resolveTopologyGeneration } from "./generation.ts";
import type {
  PhysicalSignalTopology,
  TopologyOverrides,
  TopologySnapshot,
  TopologySnapshotInputs,
} from "./types.ts";

async function defaultStatfs(path: string): Promise<StatfsResult | null> {
  try {
    const result = await statfs(path);
    return {
      blocks: Number(result.blocks),
      bfree: Number(result.bfree),
      bavail: Number(result.bavail),
      bsize: Number(result.bsize),
      files: Number(result.files),
      ffree: Number(result.ffree),
    };
  } catch {
    return null;
  }
}

export type TopologyDeps = {
  readProcFile: (
    path: string,
  ) => string | undefined | Promise<string | undefined>;
  statfs: (
    path: string,
  ) => StatfsResult | null | Promise<StatfsResult | null>;
  resolveDockerDataRoot: () => Promise<string | null>;
  resolveHostingPath: () => string | Promise<string>;
  resolveFabricInterfaces: () => Promise<string[]>;
  io: IdentityIo;
  sysRoot?: string;
  daemonStateDir?: string;
  resolveTopologyOverrides: () => Promise<TopologyOverrides>;
  resolveBootGeneration: () => Promise<number>;
  /**
   * Physical (non-VM) hardware signals — hwmon/RAPL temperature, power, and
   * fan candidates re-shaped into stable topology identity. Takes the same
   * `io`/`sysRoot` this tick resolved (never re-reads `defaultSensorIo()`/
   * `/sys` directly) so a test overriding `io`/`sysRoot` without overriding
   * this dep still reads the fixture, not the real host.
   */
  collectHardwareSignals: (
    deps: { io: IdentityIo; sysRoot: string },
  ) => Promise<PhysicalSignalTopology[]>;
};

function defaultDeps(): TopologyDeps {
  return {
    readProcFile,
    statfs: defaultStatfs,
    resolveDockerDataRoot: async () => (await resolveDockerDataRoot()) ?? null,
    resolveHostingPath: () => resolveHostingPath(),
    resolveFabricInterfaces: () => Promise.resolve([FABRIC_INTERFACE_NAME]),
    io: defaultSensorIo(),
    resolveTopologyOverrides: () => resolveTopologyOverrides(),
    resolveBootGeneration: () => resolveBootGeneration(),
    collectHardwareSignals: (deps) => defaultCollectHardwareSignals(deps),
  };
}

/** Discover every topology entity, without stamping a generation yet. */
export async function collectTopologyInputs(
  deps?: Partial<TopologyDeps>,
): Promise<TopologySnapshotInputs> {
  const merged: TopologyDeps = { ...defaultDeps(), ...deps };
  const root = merged.sysRoot ?? "/sys";

  const [
    mountsText,
    hostingPath,
    dockerRoot,
    bootGeneration,
    meminfoText,
    isPhysical,
  ] = await Promise.all([
    merged.readProcFile("/proc/mounts"),
    Promise.resolve().then(() => merged.resolveHostingPath()).catch(() => null),
    merged.resolveDockerDataRoot().catch(() => null),
    merged.resolveBootGeneration(),
    merged.readProcFile("/proc/meminfo"),
    isPhysicalMachine({ readFile: merged.io.readFile, sysRoot: root }),
  ]);

  const mountEntries = mountsText ? parseProcMounts(mountsText) : [];
  const serviceDeviceNames = await backingDeviceNames(
    mountEntries,
    ["/", hostingPath, dockerRoot].filter((p): p is string => p !== null),
    merged.io,
    root,
  );
  const meminfo = meminfoText ? parseMeminfo(meminfoText) : null;

  const [
    networks,
    filesystems,
    blockDevices,
    gpus,
    cpu,
    numaNodes,
    hardwareSignals,
  ] = await Promise.all([
    collectNetworkTopology({
      readProcFile: merged.readProcFile,
      resolveFabricInterfaces: merged.resolveFabricInterfaces,
      io: merged.io,
      sysRoot: root,
    }),
    collectFilesystemTopology({
      readProcFile: merged.readProcFile,
      statfs: merged.statfs,
      resolveHostingPath: merged.resolveHostingPath,
      resolveDockerDataRoot: merged.resolveDockerDataRoot,
      io: merged.io,
      sysRoot: root,
    }),
    collectBlockTopology({
      readProcFile: merged.readProcFile,
      io: merged.io,
      sysRoot: root,
      serviceDeviceNames,
    }),
    collectGpuTopology({ io: merged.io, sysRoot: root }),
    collectCpuTopology({ readProcFile: merged.readProcFile }),
    collectNumaTopology({ io: merged.io, sysRoot: root }),
    // GPU enumeration above and physical classification earlier are
    // independent calls sharing no state — a GPU-passthrough VM never
    // reads as bare metal (see `physical-classifier.ts`).
    isPhysical
      ? merged.collectHardwareSignals({ io: merged.io, sysRoot: root })
      : Promise.resolve([]),
  ]);

  return {
    bootGeneration,
    networks,
    filesystems,
    blockDevices,
    gpus,
    hardwareSignals,
    cpu,
    numaNodes,
    memoryTotalBytes: meminfo?.totalBytes ?? null,
    swapTotalBytes: meminfo?.swapTotalBytes ?? null,
  };
}

/** Discover topology and stamp it with this tick's generation, persisting the comparison state. */
export async function collectTopology(
  deps?: Partial<TopologyDeps>,
): Promise<TopologySnapshot> {
  const merged: TopologyDeps = { ...defaultDeps(), ...deps };
  const [inputs, overrides] = await Promise.all([
    collectTopologyInputs(merged),
    merged.resolveTopologyOverrides(),
  ]);
  const generation = await resolveTopologyGeneration(inputs, overrides, {
    daemonStateDir: merged.daemonStateDir,
  });
  return { ...inputs, generation };
}
