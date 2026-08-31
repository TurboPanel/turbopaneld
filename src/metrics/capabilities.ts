/**
 * Host metrics capabilities: what this host can measure and where.
 *
 * Answers the daemon-side `metrics-capabilities-request` correlated cell
 * round trip (see `src/instance/client.ts`) with the same discovery /
 * storage-probe / interface-classification building blocks the collector
 * uses — discovery is never re-implemented here.
 */
import { statfs } from "node:fs/promises";

import { resolveDockerDataRoot } from "../host/docker.ts";
import { FABRIC_INTERFACE_NAME } from "../instance/commands/fabric.ts";
import { probeStorage } from "./collector/filesystem.ts";
import { resolveHostingPath } from "./collector/hosting.ts";
import { parseProcMounts, storageMountCandidates } from "./collector/mounts.ts";
import { classifyInterface } from "./collector/network.ts";
import { parseNetDev } from "./collector/parse-net-dev.ts";
import { readProcFile } from "./collector/proc-read.ts";
import {
  discoverSensors,
  type SensorCapabilities,
} from "./collector/sensors/index.ts";
import type {
  NetInterfaceClassification,
  StatfsResult,
} from "./collector/types.ts";

export type StorageMountCapability = {
  path: string;
  totalBytes: number;
  availableBytes: number;
} | null;

/**
 * One block-backed mount an administrator could select as the hosting
 * filesystem — discovered from the host mount table, probed for capacity.
 */
export type StorageMountCandidate = {
  path: string;
  /** Mount source, e.g. `/dev/nvme0n1p2`. */
  source: string;
  /** Filesystem type, e.g. `ext4`. */
  fsType: string;
  totalBytes: number;
  availableBytes: number;
};

export type NetworkInterfaceCapability = {
  name: string;
  classification: NetInterfaceClassification;
};

export type MetricsCapabilities = {
  sensors: SensorCapabilities;
  storageMounts: {
    system: StorageMountCapability;
    hosting: StorageMountCapability;
    docker: StorageMountCapability;
    /** Selectable hosting filesystems for the control plane to present/persist. */
    candidates: StorageMountCandidate[];
  };
  networkInterfaces: NetworkInterfaceCapability[];
};

/** Injectable I/O seams mirroring the collector's `CollectorDeps` boundaries. */
export type MetricsCapabilityDeps = {
  readProcFile: (
    path: string,
  ) => string | undefined | Promise<string | undefined>;
  statfs: (
    path: string,
  ) => StatfsResult | null | Promise<StatfsResult | null>;
  resolveDockerDataRoot: () => Promise<string | null>;
  resolveHostingPath: () => string | Promise<string>;
  resolveFabricInterfaces: () => Promise<string[]>;
  discoverSensors: () => Promise<SensorCapabilities>;
};

async function defaultStatfs(path: string): Promise<StatfsResult | null> {
  try {
    const result = await statfs(path);
    return {
      blocks: Number(result.blocks),
      bfree: Number(result.bfree),
      bavail: Number(result.bavail),
      bsize: Number(result.bsize),
    };
  } catch {
    return null;
  }
}

function defaultDeps(): MetricsCapabilityDeps {
  return {
    readProcFile,
    statfs: defaultStatfs,
    resolveDockerDataRoot: async () => (await resolveDockerDataRoot()) ?? null,
    resolveHostingPath: () => resolveHostingPath(),
    resolveFabricInterfaces: () => Promise.resolve([FABRIC_INTERFACE_NAME]),
    discoverSensors: () => discoverSensors(),
  };
}

async function probeMount(
  path: string | null,
  statfs: MetricsCapabilityDeps["statfs"],
): Promise<StorageMountCapability> {
  if (!path) return null;
  const probe = await probeStorage(path, { statfs });
  if (!probe) return null;
  return { path, ...probe };
}

/** Probe every discovered mount candidate; unprobeable candidates are dropped. */
async function probeMountCandidates(
  mountsText: string | undefined,
  statfs: MetricsCapabilityDeps["statfs"],
): Promise<StorageMountCandidate[]> {
  if (!mountsText) return [];
  const discovered = storageMountCandidates(parseProcMounts(mountsText));
  const probed = await Promise.all(
    discovered.map(async (entry): Promise<StorageMountCandidate | null> => {
      const probe = await probeStorage(entry.mountPoint, { statfs });
      if (!probe) return null;
      return {
        path: entry.mountPoint,
        source: entry.source,
        fsType: entry.fsType,
        ...probe,
      };
    }),
  );
  return probed.filter((c): c is StorageMountCandidate => c !== null);
}

/** Enumerate sensors, storage mounts, and classified network interfaces. */
export async function collectMetricsCapabilities(
  deps?: Partial<MetricsCapabilityDeps>,
): Promise<MetricsCapabilities> {
  const merged: MetricsCapabilityDeps = { ...defaultDeps(), ...deps };

  const [sensors, fabricInterfaces, dockerRoot, hostingPath, netDevText] =
    await Promise.all([
      merged.discoverSensors(),
      merged.resolveFabricInterfaces().catch(() => [] as string[]),
      merged.resolveDockerDataRoot().catch(() => null),
      Promise.resolve()
        .then(() => merged.resolveHostingPath())
        .catch(() => null),
      merged.readProcFile("/proc/net/dev"),
    ]);
  const mountsText = await merged.readProcFile("/proc/mounts");

  const [system, hosting, docker, candidates] = await Promise.all([
    probeMount("/", merged.statfs),
    probeMount(hostingPath, merged.statfs),
    probeMount(dockerRoot, merged.statfs),
    probeMountCandidates(mountsText, merged.statfs),
  ]);

  const parsed = netDevText ? parseNetDev(netDevText) : null;
  const networkInterfaces: NetworkInterfaceCapability[] = Object.keys(
    parsed ?? {},
  )
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      name,
      classification: classifyInterface(name, fabricInterfaces),
    }));

  return {
    sensors,
    storageMounts: { system, hosting, docker, candidates },
    networkInterfaces,
  };
}
