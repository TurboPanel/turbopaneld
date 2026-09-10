/**
 * Metrics collector factory — the scheduler imports from here.
 *
 * Per-filesystem / per-interface series stay future event types; the v2
 * host-summary sample carries classified aggregates (uplink vs fabric
 * network, three storage probes, one selected sensor per measurement).
 */
import { statfs } from "node:fs/promises";

import { runDocker } from "../../deploy/docker-cli.ts";
import { DockerClient } from "../../docker/client.ts";
import { getManagedEngineRuntime } from "../../managed/engines/index.ts";
import { resolveDockerDataRoot } from "../../host/docker.ts";
import { resolveLayout } from "../../paths/layout.ts";
import { collectTopology } from "../topology/topology.ts";
import { resolveTopologyOverrides } from "../topology/overrides.ts";
import { readCapabilityPlan } from "./capability-plan-store.ts";
import type { DatabaseProxyAdapterSet } from "./database-proxy/adapter.ts";
import { ProxySqlDatabaseProxyAdapter } from "./database-proxy/proxysql.ts";
import { EventCollectorSet } from "./events/index.ts";
import type { GpuAdapterSet } from "./gpu/adapter.ts";
import { DcgmGpuAdapter } from "./gpu/dcgm-adapter.ts";
import { NvmlGpuAdapter } from "./gpu/nvml-adapter.ts";
import { SysfsGpuAdapter } from "./gpu/sysfs-adapter.ts";
import type { IngressAdapterSet } from "./ingress/adapter.ts";
import { CaddyIngressAdapter } from "./ingress/caddy.ts";
import type { RouterAdapterSet } from "./router/adapter.ts";
import { TraefikRouterAdapter } from "./router/traefik.ts";
import {
  createDirectoryUsageWalker,
  type DirectoryUsageWalker,
} from "./directory-usage.ts";
import { DockerUsageSampler } from "./docker-usage.ts";
import { ManagedEngineSampler } from "./managed-engines.ts";
import { resolveHostingPath } from "./hosting.ts";
import { defaultSensorIo } from "./sensors/discovery.ts";
import { LinuxMetricsCollector } from "./linux-collector.ts";
import { resolvePageSizeBytes } from "./parse-vmstat.ts";
import { countProcessesInProc } from "./processes.ts";
import { readProcFile } from "./proc-read.ts";
import type {
  CollectorDeps,
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
  collectDirectoryUsage,
  createDirectoryUsageWalker,
  DIRECTORY_USAGE_WALK_INTERVAL_MS,
  type DirectoryUsageReading,
  type DirectoryUsageSnapshot,
  DirectoryUsageWalker,
  emptyDirectoryUsageSnapshot,
  measureDirectoryUsage,
  storageBytesFromSnapshot,
  walkDirectoryBytes,
} from "./directory-usage.ts";
export {
  DOCKER_USAGE_REFRESH_INTERVAL_MS,
  type DockerUsageReading,
  DockerUsageSampler,
  reduceDockerSystemDf,
} from "./docker-usage.ts";
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
  SITE_CADDY_ADMIN_ADDR,
} from "./ingress/index.ts";
export type {
  RouterAdapter,
  RouterAdapterId,
  RouterAdapterSet,
  RouterReadContext,
  RouterReading,
} from "./router/index.ts";
export {
  buildRouterSample,
  TRAEFIK_METRICS_ADDR,
  TraefikRouterAdapter,
} from "./router/index.ts";
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
 * than once even if `defaultDeps` is called again.
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
    };
  }
  return cachedIngressAdapters;
}

/**
 * The shared hosting router, constructed once at daemon startup like every
 * other adapter set. Separate from {@link defaultIngressAdapters} since v6:
 * Traefik reports the host-wide `managed.router` family, not an entry in
 * `ingressSources[]`.
 */
let cachedRouterAdapters: RouterAdapterSet | undefined;
function defaultRouterAdapters(): RouterAdapterSet {
  if (!cachedRouterAdapters) {
    cachedRouterAdapters = {
      traefik: new TraefikRouterAdapter(),
    };
  }
  return cachedRouterAdapters;
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

/**
 * The two host-storage samplers, constructed once at daemon startup and
 * started immediately — never per tick, never per attach.
 *
 * Module-level singletons for the same reason {@link defaultGpuAdapters} is
 * one: a second `defaultDeps()` call must not open a second Docker socket or
 * start a second recursive walk of the hosting tree. They keep running across
 * a control-plane reconnect because what they measure is a property of the
 * host, not of the connection — throwing away a completed walk on every
 * reconnect would leave `sample.storage` absent for up to
 * `DIRECTORY_USAGE_WALK_INTERVAL_MS` after every blip.
 *
 * {@link stopHostStorageSamplers} stops both on daemon shutdown.
 */
let cachedDirectoryUsageWalker: DirectoryUsageWalker | undefined;
function defaultDirectoryUsageWalker(): DirectoryUsageWalker {
  if (!cachedDirectoryUsageWalker) {
    cachedDirectoryUsageWalker = createDirectoryUsageWalker({
      resolveHostingPath: () => resolveHostingPath(),
      resolveBackupPath: () => resolveLayout(Deno.env.toObject()).backupDir,
      resolveLogsPath: () => resolveLayout(Deno.env.toObject()).logDir,
    });
    cachedDirectoryUsageWalker.start();
  }
  return cachedDirectoryUsageWalker;
}

let cachedDockerUsageSampler: DockerUsageSampler | undefined;
function defaultDockerUsageSampler(): DockerUsageSampler {
  if (!cachedDockerUsageSampler) {
    // One client for the sampler's own lifetime. An absent socket is not an
    // error here: `systemDf()` rejects and the sampler keeps reporting `null`,
    // which omits the family rather than reporting zero bytes of Docker.
    const client = new DockerClient();
    cachedDockerUsageSampler = new DockerUsageSampler({
      systemDf: () => client.systemDf(),
    });
    cachedDockerUsageSampler.start();
  }
  return cachedDockerUsageSampler;
}

/**
 * The managed-engine census sampler — the third `managed.storage` source,
 * with the same singleton lifecycle as the two above. Discovery goes over
 * the Docker socket; the per-instance probe is `docker exec` through
 * `runDocker`, the same path the managed apply/lifecycle handlers use, on
 * the sampler's own 5-minute timer rather than the metrics tick.
 */
let cachedManagedEngineSampler: ManagedEngineSampler | undefined;
function defaultManagedEngineSampler(): ManagedEngineSampler {
  if (!cachedManagedEngineSampler) {
    const client = new DockerClient();
    cachedManagedEngineSampler = new ManagedEngineSampler({
      listContainers: () => client.listContainers(true),
      runtimeFor: (engine) => {
        try {
          return getManagedEngineRuntime(engine);
        } catch {
          return null;
        }
      },
      exec: async (containerId, argv, input) => {
        const result = await runDocker(
          ["exec", "-i", containerId, ...argv],
          input === undefined ? undefined : { input },
        );
        return {
          success: result.success,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      },
    });
    cachedManagedEngineSampler.start();
  }
  return cachedManagedEngineSampler;
}

/**
 * Stop the host-storage samplers. Called on daemon shutdown so their
 * intervals do not keep the process alive; safe to call when none was ever
 * constructed.
 */
export function stopHostStorageSamplers(): void {
  cachedDirectoryUsageWalker?.stop();
  cachedDockerUsageSampler?.stop();
  cachedManagedEngineSampler?.stop();
}

function defaultDeps(): CollectorDeps {
  return {
    readProcFile,
    statfs: defaultStatfs,
    now: () => Date.now(),
    collectTopology: () => collectTopology(),
    resolveTopologyOverrides: () => resolveTopologyOverrides(),
    resolveCapabilityPlan: () => readCapabilityPlan(),
    // Colocated Deno instance — never truncate even if a leftover plan file
    // remains from an earlier push. Remote daemons that reconnect to a
    // self-hosted control plane receive `capability-plan-clear` and delete
    // the file; do not treat TURBOPANEL_INSTANCE_RUNTIME as that signal
    // (it is not set on remote hosts).
    skipCapabilityPlanTruncation:
      Deno.env.get("TURBOPANEL_INSTANCE_RUNTIME")?.trim() === "deno",
    io: defaultSensorIo(),
    // Resolved once here (construction time), never per tick.
    pageSizeBytes: resolvePageSizeBytes(),
    countProcesses: () => countProcessesInProc(),
    gpuAdapters: defaultGpuAdapters(),
    ingressAdapters: defaultIngressAdapters(),
    routerAdapters: defaultRouterAdapters(),
    databaseProxyAdapters: defaultDatabaseProxyAdapters(),
    eventCollectors: defaultEventCollectors(),
    directoryUsage: () => defaultDirectoryUsageWalker().latest(),
    dockerUsage: () => defaultDockerUsageSampler().latest(),
    managedEngines: () => defaultManagedEngineSampler().latest(),
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
  deps?: Partial<CollectorDeps>,
  options?: { os?: string },
): MetricsCollector {
  const os = options?.os ?? Deno.build.os;
  if (os !== "linux") {
    return new UnsupportedMetricsCollector(
      `unsupported_os:${os}`,
    );
  }

  const merged: CollectorDeps = { ...defaultDeps(), ...deps };
  return new LinuxMetricsCollector(merged);
}
