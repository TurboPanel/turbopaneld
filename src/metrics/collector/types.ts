import type { MetricsCapabilityPlan } from "../capability-plan.ts";
import type { MetricsSample } from "../contract.ts";
import type { TopologyOverrides, TopologySnapshot } from "../topology/types.ts";
import type { DatabaseProxyAdapterSet } from "./database-proxy/adapter.ts";
import type { DirectoryUsageSnapshot } from "./directory-usage.ts";
import type { DockerUsageReading } from "./docker-usage.ts";
import type { ManagedEngineCensusReading } from "./managed-engines.ts";
import type { TopLevelEventCollector } from "./events/index.ts";
import type { GpuAdapterSet } from "./gpu/adapter.ts";
import type { IngressAdapterSet } from "./ingress/adapter.ts";
import type { RouterAdapterSet } from "./router/adapter.ts";
import type { SensorIo } from "./sensors/discovery.ts";

/** Outcome of a single collect() invocation: an entity-grouped `MetricsSample`. */
export type MetricsCollectResult =
  | { supported: true; sample: MetricsSample }
  | { supported: false; reason: string };

/**
 * Host metrics collector seam for scheduler integration.
 *
 * The scheduler owns monotonic `sequence` generation; the collector only
 * consumes the value passed in `collect({ sequence })`. v6 dropped the
 * baseline/live `collectionMode` discriminator: a live lease changes the
 * scheduler's cadence, and the resulting `metadata.intervalSeconds` is the
 * only thing any consumer ever needed to tell the two apart.
 */
export interface MetricsCollector {
  collect(options: {
    sequence: number;
    nowMs?: number;
  }): Promise<MetricsCollectResult>;
}

/** Aggregate CPU jiffies from `/proc/stat` `cpu`/`cpuN` lines. */
export type CpuCounters = {
  user?: number;
  nice?: number;
  system?: number;
  idle?: number;
  iowait?: number;
  irq?: number;
  softirq?: number;
  steal?: number;
  /** Field 9 — ticks spent running a guest VM, already included in `user`. */
  guest?: number;
  /** Field 10 — ticks spent running a niced guest VM, already included in `nice`. */
  guestNice?: number;
  /** Sum of all present counter fields. */
  total: number;
  /** `total - idle - iowait` (missing idle/iowait treated as 0 for this sum only). */
  active: number;
};

export type DiskDeviceCounters = {
  readsCompleted: number;
  sectorsRead: number;
  writesCompleted: number;
  sectorsWritten: number;
  /** Milliseconds spent reading (`/proc/diskstats` field 4 after the name). */
  readTicksMs: number;
  /** Milliseconds spent writing (`/proc/diskstats` field 8 after the name). */
  writeTicksMs: number;
  /** `/proc/diskstats` field 9 after the name — I/Os currently in progress (a gauge, not a counter). */
  iosInProgress: number;
  /** `/proc/diskstats` field 10 after the name — cumulative ms spent doing I/Os, feeds `utilizationPercent`. */
  ioTicksMs: number;
  /** `/proc/diskstats` field 11 after the name — cumulative weighted ms, feeds `queueDepth`. */
  weightedIoTicksMs: number;
};

/** Filtered whole-disk counters keyed by stable device name. */
export type DiskCounters = {
  devices: Record<string, DiskDeviceCounters>;
};

export type NetInterfaceCounters = {
  receiveBytes: number;
  transmitBytes: number;
};

export type LoadGauges = {
  one: number;
  five: number;
  fifteen: number;
};

/** Raw `/proc/meminfo` byte gauges — no derived percentages. */
export type MemoryGauges = {
  totalBytes: number;
  availableBytes: number;
  /** `totalBytes - availableBytes` — what v5 reports, since "free" is misleading on Linux. */
  usedBytes: number;
  /** `Cached + Buffers + SReclaimable - Shmem` — reclaimable file-backed page cache. */
  cachedFilesBytes: number | null;
  freeBytes: number | null;
  /** `null` (never `0`) on swap-absent hosts. */
  swapTotalBytes: number | null;
  swapFreeBytes: number | null;
};

/** One `statfs` capacity probe (system `/`, hosting root, or Docker data root). */
export type StorageProbeResult = {
  totalBytes: number;
  availableBytes: number;
  /** Total inodes, when the `statfs` implementation exposes `files` (Linux does; not every platform does). */
  totalInodes?: number | null;
  /** Free inodes, when the `statfs` implementation exposes `ffree` (Linux does; not every platform does). */
  freeInodes?: number | null;
} | null;

/** Stable sensor identity — never a bare `hwmonN` index. */
export type SensorCandidate = {
  chip: string;
  label: string;
  path: string;
};

/** Admin-selected sensor path per measurement; overrides auto-detection. */
export type SensorOverrides = {
  cpuTemperature?: string;
  gpuTemperature?: string;
  cpuPower?: string;
  gpuPower?: string;
  /** Rides the same `gpuDevice` slot identity as `gpuTemperature`/`gpuPower`. */
  gpuUtilization?: string;
  gpuFan?: string;
  disk1Temperature?: string;
  disk2Temperature?: string;
  ambient1Temperature?: string;
  ambient2Temperature?: string;
  boardTemperature?: string;
  cpuFan?: string;
  systemFan1?: string;
  systemFan2?: string;
};

/**
 * Stable sensor identity for one hardware-profile slot — `chip` + `label`,
 * mirroring the control plane's `ServerSensorSlotAssignment`
 * (`src/lib/db/server-metadata.ts` in the client repo). Never a raw sysfs
 * path — those reindex across reboots.
 */
export type HardwareProfileSensorSlot = { chip: string; label: string };

/**
 * Operator-assigned hardware profile pushed from the control plane over the
 * cell socket (`topology-overrides-update`) and cached as daemon
 * state. `undefined` (key absent) = never configured; `null` = explicitly
 * unassigned; an assignment = pinned identity. Mirrors the control plane's
 * `ServerHardwareProfile`.
 */
export type HardwareProfile = {
  cpuTemperature?: HardwareProfileSensorSlot | null;
  cpuPower?: HardwareProfileSensorSlot | null;
  gpuDevice?: HardwareProfileSensorSlot | null;
  /**
   * Overrides the fan candidate `gpuDevice`'s fan-out otherwise selects —
   * only needed when a GPU's fan tachometer isn't discoverable from the same
   * device identity as its temperature/power (see `resolveAdminSensorOverrides`
   * in `overrides.ts`).
   */
  gpuFan?: HardwareProfileSensorSlot | null;
  disk1Temperature?: HardwareProfileSensorSlot | null;
  disk2Temperature?: HardwareProfileSensorSlot | null;
  ambient1Temperature?: HardwareProfileSensorSlot | null;
  ambient2Temperature?: HardwareProfileSensorSlot | null;
  boardTemperature?: HardwareProfileSensorSlot | null;
  cpuFan?: HardwareProfileSensorSlot | null;
  systemFan1?: HardwareProfileSensorSlot | null;
  systemFan2?: HardwareProfileSensorSlot | null;
  nic1?: string | null;
  nic2?: string | null;
  hostingPath?: string;
  drivetempEnabled?: boolean;
  /**
   * Topology-identity pins (`src/metrics/topology/`) — stable device/
   * filesystem ids, never raw interface names or paths. Distinct from
   * `nic1`/`nic2`/`hostingPath` above, which stay interface-name/path-typed
   * for `resolveHostingPath`; sensor-slot selection is a separate concern
   * from topology identity.
   *
   * `nicSlotDeviceIds` is the operator's monitored-NIC list in slot order
   * (see `topology/types.ts`'s `TopologyOverrides`); absent/empty means
   * "auto" (default-route uplink only). Only this list key is supported.
   */
  nicSlotDeviceIds?: string[];
  hostingFilesystemId?: string | null;
  generation?: number;
  generationAppliedAt?: string;
};

/** RAPL cumulative energy counter — power is a two-snapshot delta. */
export type CpuEnergyCounter = {
  energyMicrojoules: number;
  /** Wraparound modulus (`max_energy_range_uj`), when exposed. */
  maxEnergyRangeMicrojoules: number | null;
};

/** Intel DRM engine busy accumulating nanosecond counters. */
export type GpuBusyCounters = {
  engines: Record<string, number>;
};

/** Point-in-time sensor readings plus the resolved sensor identities. */
export type SensorReadings = {
  cpuTemperatureCelsius: number | null;
  gpuTemperatureCelsius: number | null;
  /** Instantaneous GPU power gauge (hwmon `power1_average`); `null` when unsupported. */
  gpuPowerWatts: number | null;
  /** Vendor busy-percent gauge (`amdgpu`); `null` when using {@link gpuBusy}. */
  gpuUtilizationPercent: number | null;
  /** Engine busy-ns for Intel i915/Xe; power-style two-snapshot delta in the orchestrator. */
  gpuBusy: GpuBusyCounters | null;
  gpuFanRpm: number | null;
  disk1TemperatureCelsius: number | null;
  disk2TemperatureCelsius: number | null;
  ambient1TemperatureCelsius: number | null;
  ambient2TemperatureCelsius: number | null;
  boardTemperatureCelsius: number | null;
  cpuFanRpm: number | null;
  systemFan1Rpm: number | null;
  systemFan2Rpm: number | null;
  /** Cumulative CPU energy counter for delta-based `cpuPowerWatts`. */
  cpuEnergy: CpuEnergyCounter | null;
  /** Resolved sensor identities — daemon-internal, never re-added to dimensions. */
  sensors: {
    cpuTemperatureSensor?: string;
    gpuTemperatureSensor?: string;
    cpuPowerSensor?: string;
    gpuPowerSensor?: string;
    gpuUtilizationSensor?: string;
    gpuFanSensor?: string;
    disk1TemperatureSensor?: string;
    disk2TemperatureSensor?: string;
    ambient1TemperatureSensor?: string;
    ambient2TemperatureSensor?: string;
    boardTemperatureSensor?: string;
    cpuFanSensor?: string;
    systemFan1Sensor?: string;
    systemFan2Sensor?: string;
  };
};

/** Operator-assigned NIC-slot interface names (`HardwareProfile.nic1`/`.nic2`); `null` = unassigned. */
export type NicSlots = {
  nic1: string | null;
  nic2: string | null;
};

export type StatfsResult = {
  blocks: number;
  bfree: number;
  bavail: number;
  bsize: number;
  /** Total/free inode counts, when the platform's `statfs` exposes them. */
  files?: number;
  ffree?: number;
};

export type CollectorDeps = {
  readProcFile: (
    path: string,
  ) => string | undefined | Promise<string | undefined>;
  statfs: (
    path: string,
  ) => StatfsResult | null | Promise<StatfsResult | null>;
  now: () => number;
  /** This tick's topology discovery — networks/filesystems/blockDevices identity, generation, boot generation. */
  collectTopology: () => Promise<TopologySnapshot>;
  /**
   * The operator's topology overrides (`topology/overrides.ts`'s
   * `resolveTopologyOverrides`), re-read each tick alongside
   * `collectTopology` so `linux-collector.ts` can recompute the same
   * `SlotMapping` the topology generation was stamped with and emit only the
   * monitored NICs (`normalNicSlots` in slot order, then fabric devices).
   * Optional: absent means `EMPTY_TOPOLOGY_OVERRIDES` — auto slot selection
   * (the default-route uplink only).
   */
  resolveTopologyOverrides?: () => Promise<TopologyOverrides>;
  /**
   * Persisted capability plan from the last `capability-plan-update`.
   * Optional: absent means no truncation — the collector sends the full
   * discovered sample (self-hosted, or before the first push lands).
   * Production `defaultDeps` wires `readCapabilityPlan`.
   */
  resolveCapabilityPlan?: () => Promise<
    { plan: MetricsCapabilityPlan; generation: number } | undefined
  >;
  /**
   * When true, never truncate the outbound sample even if a leftover
   * capability plan is persisted. Self-hosted ingest writes the full sample
   * on the operator's own disk; a finite plan must not start dropping
   * entities after enroll or reconnect.
   */
  skipCapabilityPlanTruncation?: boolean;
  /** Sysfs access for per-NIC directional stats (`network.ts`'s `buildNetworkDeviceSamples`). */
  io: SensorIo;
  sysRoot?: string;
  /** Host page size in bytes (`parse-vmstat.ts`'s `resolvePageSizeBytes`), resolved once at construction, never per tick. */
  pageSizeBytes: number;
  /**
   * Count running processes (`processes.ts`'s `countProcessesInProc`).
   * Optional: absent means a live `/proc` scan. Host-free scheduler tests
   * stub this so FakeClock microtask draining never waits on real directory
   * I/O (hundreds of PID entries, plus a possible `ls` fallback).
   */
  countProcesses?: () => number | null | Promise<number | null>;
  /**
   * GPU telemetry adapters (sysfs/NVML/DCGM), constructed once at daemon
   * startup — `gpu/index.ts`'s `buildGpuSamples`. Optional: absent means
   * `gpus` stays `[]`, matching this phase's prior behavior for hosts/tests
   * that don't wire GPU telemetry.
   */
  gpuAdapters?: GpuAdapterSet;
  /**
   * Ingress traffic adapters (the site Caddy loopback scrape), constructed
   * once at daemon startup — `ingress/index.ts`'s `buildIngressSources`.
   * Optional: absent means `ingressSources` stays `[]`, matching this
   * phase's prior behavior for hosts/tests that don't wire ingress
   * telemetry.
   */
  ingressAdapters?: IngressAdapterSet;
  /**
   * Shared HTTP-router adapters (the hosting Traefik loopback scrape),
   * constructed once at daemon startup — `router/index.ts`'s
   * `buildRouterSample`. Separate from {@link CollectorDeps.ingressAdapters}
   * because the router is host-wide and singleton, not one of many
   * `sourceId`-keyed ingress sources. Optional: absent means `router` is
   * omitted from the sample entirely, matching every other adapter set's
   * absent-default convention.
   */
  routerAdapters?: RouterAdapterSet;
  /**
   * Database-proxy traffic adapters (ProxySQL REST scrape), constructed once
   * at daemon startup — `database-proxy/index.ts`'s `buildDatabaseProxies`.
   * Optional: absent means `databaseProxies` stays `[]`, matching this
   * phase's prior behavior for hosts/tests that don't wire database-proxy
   * telemetry.
   */
  databaseProxyAdapters?: DatabaseProxyAdapterSet;
  /**
   * Event sub-collector aggregator (`events/index.ts`'s `EventCollectorSet`),
   * constructed once at daemon startup. Optional: absent means `events`
   * stays `[]`, matching every other adapter's absent-default convention.
   */
  eventCollectors?: TopLevelEventCollector;
  /**
   * Cached directory-usage reading for the hosting root, the backup root and
   * the log directory — the `managed.storage` family's byte fields.
   *
   * A *getter*, not a probe: the walk runs on
   * `directory-usage.ts`'s own slow interval, owned by whatever started the
   * daemon, and the tick only reads its last completed result. Wiring it as a
   * collect-time async call would put a full recursive tree walk on the 60 s
   * path, which is precisely what that module exists to avoid.
   *
   * Optional: absent means `storage` is omitted from the sample entirely,
   * matching every adapter set's absent-default convention.
   */
  directoryUsage?: () => DirectoryUsageSnapshot;
  /**
   * Cached Docker `GET /system/df` rollup — the `managed.docker` family, plus
   * the `dockerUsedBytes` total `managed.storage` carries. Same getter
   * discipline and the same reason as {@link CollectorDeps.directoryUsage}.
   *
   * Returns `null` when Docker is absent or the first poll has not landed, in
   * which case `dockerUsage` is omitted from the sample and
   * `storage.dockerUsedBytes` stays `null`.
   */
  dockerUsage?: () => DockerUsageReading | null;
  /**
   * Cached managed-engine census — the twelve per-engine fields of
   * `managed.storage` (`managed-engines.ts`'s `ManagedEngineSampler`). Same
   * getter discipline as {@link CollectorDeps.directoryUsage}: the census
   * costs a Docker listing plus one `docker exec` per running instance, so
   * it runs on its own slow timer and the tick only reads the last result.
   *
   * Returns `null` when Docker is absent or the first census has not landed,
   * in which case every engine group stays `null`. Optional: absent means
   * the same.
   */
  managedEngines?: () => ManagedEngineCensusReading | null;
};
