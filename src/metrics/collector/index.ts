/**
 * Metrics collector factory — the scheduler imports from here.
 *
 * Per-filesystem / per-interface series stay future event types; the v2
 * host-summary sample carries classified aggregates (uplink vs fabric
 * network, three storage probes, one selected sensor per measurement).
 */
import { statfs } from "node:fs/promises";

import { resolveDockerDataRoot } from "../../host/docker.ts";
import { collectTopology } from "../topology/topology.ts";
import { resolveTopologyOverrides } from "../topology/overrides.ts";
import type { DatabaseProxyAdapterSet } from "./database-proxy/adapter.ts";
import { ProxySqlDatabaseProxyAdapter } from "./database-proxy/proxysql-v5.ts";
import { EventCollectorSet } from "./events/index.ts";
import type { GpuAdapterSet } from "./gpu/adapter.ts";
import { DcgmGpuAdapter } from "./gpu/dcgm-adapter.ts";
import { NvmlGpuAdapter } from "./gpu/nvml-adapter.ts";
import { SysfsGpuAdapter } from "./gpu/sysfs-adapter.ts";
import type { IngressAdapterSet } from "./ingress/adapter.ts";
import { CaddyIngressAdapter } from "./ingress/caddy-v5.ts";
import { TraefikIngressAdapter } from "./ingress/traefik.ts";
import { defaultSensorIo } from "./sensors/discovery.ts";
import { LinuxMetricsCollector } from "./linux-collector.ts";
import { resolvePageSizeBytes } from "./parse-vmstat.ts";
import { countProcessesInProc } from "./processes.ts";
import { readProcFile } from "./proc-read.ts";
import type { CollectorDepsV5 } from "./types-v5.ts";
import type {
  MetricsCollector,
  MetricsCollectResult,
  StatfsResult,
} from "./types.ts";

export type {
  CpuCounters,
  CpuEnergyCounter,
  DiskCounters,
  DiskDeviceCounters,
  MemoryGauges,
  MetricsCollector,
  MetricsCollectResult,
  NicSlots,
  SensorCandidate,
  SensorOverrides,
  SensorReadings,
  StatfsResult,
  StorageProbeResult,
} from "./types.ts";

export { LinuxMetricsCollector } from "./linux-collector.ts";
export { readProcFile } from "./proc-read.ts";
export { readMemoryGauges } from "./memory.ts";
export { probeStorage } from "./filesystem.ts";
export {
  backingDeviceNames,
  type MountEntry,
  mountForPath,
  parseProcMounts,
  storageMountCandidates,
} from "./mounts.ts";
export { resolveHostingPath } from "./hosting.ts";
export {
  cpuPowerFromEnergy,
  defaultSensorIo,
  discoverSensors,
  readCpuEnergy,
  readGpuPower,
  readHostSensors,
  resolveAdminSensorOverrides,
  resolveNicSlots,
  resolveTemperature,
  type SensorCapabilities,
  sensorId,
  type SensorIo,
} from "./sensors/index.ts";
export type {
  GpuAdapter,
  GpuAdapterId,
  GpuAdapterSet,
  GpuReadContext,
  GpuReading,
} from "./gpu/index.ts";
export {
  buildGpuSamples,
  DCGM_EXPORTER_ADDR,
  DcgmGpuAdapter,
  NvmlGpuAdapter,
  SysfsGpuAdapter,
} from "./gpu/index.ts";
export type {
  IngressAdapter,
  IngressAdapterId,
  IngressAdapterSet,
  IngressReadContext,
  IngressReading,
} from "./ingress/index.ts";
export {
  buildIngressSources,
  CaddyIngressAdapter,
  TRAEFIK_METRICS_ADDR,
  TraefikIngressAdapter,
} from "./ingress/index.ts";
export type {
  DatabaseProxyAdapter,
  DatabaseProxyAdapterId,
  DatabaseProxyAdapterSet,
  DatabaseProxyReadContext,
  DatabaseProxyReading,
} from "./database-proxy/index.ts";
export {
  buildDatabaseProxies,
  ProxySqlDatabaseProxyAdapter,
} from "./database-proxy/index.ts";
export { buildHardwareSignalSamples } from "./hardware-signals.ts";
export type { HardwareSignalSamplesResult } from "./hardware-signals.ts";
export type {
  EventCollector,
  EventCollectorSetDeps,
  EventDetectContext,
  TopLevelEventCollector,
} from "./events/index.ts";
export {
  EventCollectorSet,
  MAX_EVENTS_PER_DETECT_TICK,
} from "./events/index.ts";

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

/** Minimum wait before re-probing the Docker Engine after a failed data-root read. */
export const DOCKER_DATA_ROOT_RETRY_MS = 5 * 60_000;

/**
 * Docker data-root resolution with a bounded cache: a successful Engine-API
 * (`/info`) read is cached for the life of the collector, and failures are
 * only re-probed after {@link DOCKER_DATA_ROOT_RETRY_MS} — never once per
 * interval, so a present-but-unhealthy daemon cannot reintroduce steady
 * per-tick discovery work. Exported for host-free tests.
 */
export function createCachedDockerDataRoot(
  resolve: () => Promise<string | undefined> = () => resolveDockerDataRoot(),
  now: () => number = () => Date.now(),
): () => Promise<string | null> {
  let cached: string | null = null;
  let lastFailureAtMs: number | null = null;
  return async () => {
    if (cached !== null) return cached;
    if (
      lastFailureAtMs !== null &&
      now() - lastFailureAtMs < DOCKER_DATA_ROOT_RETRY_MS
    ) {
      return null;
    }
    cached = (await resolve()) ?? null;
    lastFailureAtMs = cached === null ? now() : null;
    return cached;
  };
}

/**
 * Constructed once at daemon startup (never per tick) — each adapter's own
 * `probe()`/memoized-unavailable fast path keeps a GPU-less host from
 * paying FFI/scrape cost every interval. Module-level singleton so a
 * process never opens `libnvidia-ml.so.1` (or dials dcgm-exporter) more
 * than once even if `defaultDepsV5` is called again.
 */
let cachedGpuAdapters: GpuAdapterSet | undefined;
function defaultGpuAdapters(): GpuAdapterSet {
  if (!cachedGpuAdapters) {
    cachedGpuAdapters = {
      dcgm: new DcgmGpuAdapter(),
      nvml: new NvmlGpuAdapter(),
      sysfs: new SysfsGpuAdapter(),
    };
  }
  return cachedGpuAdapters;
}

/**
 * Constructed once at daemon startup (never per tick) — each adapter's own
 * retry-bounded scrape keeps an absent sidecar from being re-dialed every
 * interval. Module-level singleton, mirroring {@link defaultGpuAdapters}.
 */
let cachedIngressAdapters: IngressAdapterSet | undefined;
function defaultIngressAdapters(): IngressAdapterSet {
  if (!cachedIngressAdapters) {
    cachedIngressAdapters = {
      caddy: new CaddyIngressAdapter(),
      traefik: new TraefikIngressAdapter(),
    };
  }
  return cachedIngressAdapters;
}

let cachedDatabaseProxyAdapters: DatabaseProxyAdapterSet | undefined;
function defaultDatabaseProxyAdapters(): DatabaseProxyAdapterSet {
  if (!cachedDatabaseProxyAdapters) {
    cachedDatabaseProxyAdapters = {
      proxysql: new ProxySqlDatabaseProxyAdapter(),
    };
  }
  return cachedDatabaseProxyAdapters;
}

/**
 * Constructed once at daemon startup (never per tick), mirroring
 * {@link defaultGpuAdapters}/{@link defaultIngressAdapters}. Its GPU-health
 * reader is wired to the *same* cached `NvmlGpuAdapter` instance
 * {@link defaultGpuAdapters} already constructed — never a second
 * `dlopen`/`nvmlInit` of its own.
 */
let cachedEventCollectors: EventCollectorSet | undefined;
function defaultEventCollectors(): EventCollectorSet {
  if (!cachedEventCollectors) {
    const nvml = defaultGpuAdapters().nvml;
    cachedEventCollectors = new EventCollectorSet({
      gpuHealthReader: (gpu) =>
        nvml instanceof NvmlGpuAdapter
          ? nvml.readHealthSignals(gpu)
          : Promise.resolve({
            eccDoubleBitAggregateTotal: null,
            lastXidErrorCode: null,
            remappedRows: null,
            retiredPagesPending: null,
          }),
    });
  }
  return cachedEventCollectors;
}

function defaultDepsV5(): CollectorDepsV5 {
  return {
    readProcFile,
    statfs: defaultStatfs,
    now: () => Date.now(),
    collectTopology: () => collectTopology(),
    resolveTopologyOverrides: () => resolveTopologyOverrides(),
    io: defaultSensorIo(),
    // Resolved once here (construction time), never per tick.
    pageSizeBytes: resolvePageSizeBytes(),
    countProcesses: () => countProcessesInProc(),
    gpuAdapters: defaultGpuAdapters(),
    ingressAdapters: defaultIngressAdapters(),
    databaseProxyAdapters: defaultDatabaseProxyAdapters(),
    eventCollectors: defaultEventCollectors(),
  };
}

class UnsupportedMetricsCollector implements MetricsCollector {
  readonly #reason: string;

  constructor(reason: string) {
    this.#reason = reason;
  }

  collect(): Promise<MetricsCollectResult> {
    return Promise.resolve({ supported: false, reason: this.#reason });
  }
}

/**
 * Build the platform metrics collector.
 *
 * Optional `options.os` overrides `Deno.build.os` so host-free tests can
 * exercise the unsupported-OS path without leaving Linux.
 */
export function createMetricsCollector(
  deps?: Partial<CollectorDepsV5>,
  options?: { os?: string },
): MetricsCollector {
  const os = options?.os ?? Deno.build.os;
  if (os !== "linux") {
    return new UnsupportedMetricsCollector(
      `unsupported_os:${os}`,
    );
  }

  const merged: CollectorDepsV5 = { ...defaultDepsV5(), ...deps };
  return new LinuxMetricsCollector(merged);
}
