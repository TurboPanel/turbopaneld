import type {
  HostMetricsDimensions,
  HostMetricsSample,
  MetricsCollectionMode,
} from "../contract.ts";

/** Outcome of a single collect() invocation. */
export type MetricsCollectResult =
  | { supported: true; sample: HostMetricsSample }
  | { supported: false; reason: string };

/**
 * Host metrics collector seam for scheduler integration.
 *
 * The scheduler owns monotonic `sequence` generation; the collector only
 * consumes the value passed in `collect({ sequence })`. `collectionMode`
 * defaults to `"baseline"` — the live-leases phase passes `"live"` without
 * touching the collector internals.
 */
export interface MetricsCollector {
  collect(options: {
    sequence: number;
    nowMs?: number;
    collectionMode?: MetricsCollectionMode;
  }): Promise<MetricsCollectResult>;
}

/** Aggregate CPU jiffies from `/proc/stat` `cpu` line. */
export type CpuCounters = {
  user?: number;
  nice?: number;
  system?: number;
  idle?: number;
  iowait?: number;
  irq?: number;
  softirq?: number;
  steal?: number;
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
};

/** Filtered whole-disk counters keyed by stable device name. */
export type DiskCounters = {
  devices: Record<string, DiskDeviceCounters>;
};

export type NetInterfaceCounters = {
  receiveBytes: number;
  transmitBytes: number;
};

/**
 * Traffic-bearing role of a network interface. Aggregation happens after
 * classification — uplink and fabric totals are independent, never combined.
 */
export type NetInterfaceClassification =
  | "loopback"
  | "container-bridge"
  | "fabric"
  | "uplink";

/** Every parsed interface, with its classification, keyed by stable name. */
export type NetCounters = {
  interfaces: Record<
    string,
    NetInterfaceCounters & { classification: NetInterfaceClassification }
  >;
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
  freeBytes: number | null;
  /** `null` (never `0`) on swap-absent hosts. */
  swapTotalBytes: number | null;
  swapFreeBytes: number | null;
};

/** One `statfs` capacity probe (system `/`, hosting root, or Docker data root). */
export type StorageProbeResult = {
  totalBytes: number;
  availableBytes: number;
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
};

/** RAPL cumulative energy counter — power is a two-snapshot delta. */
export type CpuEnergyCounter = {
  energyMicrojoules: number;
  /** Wraparound modulus (`max_energy_range_uj`), when exposed. */
  maxEnergyRangeMicrojoules: number | null;
};

/** Point-in-time sensor readings plus the resolved sensor identities. */
export type SensorReadings = {
  cpuTemperatureCelsius: number | null;
  gpuTemperatureCelsius: number | null;
  /** Instantaneous GPU power gauge (hwmon `power1_average`); `null` when unsupported. */
  gpuPowerWatts: number | null;
  /** Cumulative CPU energy counter for delta-based `cpuPowerWatts`. */
  cpuEnergy: CpuEnergyCounter | null;
  sensors: {
    cpuTemperatureSensor?: string;
    gpuTemperatureSensor?: string;
    cpuPowerSensor?: string;
    gpuPowerSensor?: string;
  };
};

/** Point-in-time snapshot used for delta/rate computation on the next collect. */
export type RawSnapshot = {
  atMs: number;
  bootId: string | null;
  cpu: CpuCounters | null;
  disk: DiskCounters | null;
  net: NetCounters | null;
  load: LoadGauges | null;
  memory: MemoryGauges | null;
  storage: {
    system: StorageProbeResult;
    hosting: StorageProbeResult;
    docker: StorageProbeResult;
  };
  sensors: SensorReadings | null;
  processCount: number | null;
  uptimeSeconds: number | null;
};

export type StatfsResult = {
  blocks: number;
  bfree: number;
  bavail: number;
  bsize: number;
};

/**
 * Static per-sample dimensions the collector cannot know: everything but
 * `collectionMode` and the sensor/interface identities, which the collector
 * fills in from its own resolution results.
 */
export type StaticDimensions = Omit<
  HostMetricsDimensions,
  | "collectionMode"
  | "cpuTemperatureSensor"
  | "gpuTemperatureSensor"
  | "cpuPowerSensor"
  | "gpuPowerSensor"
  | "uplinkInterfaces"
  | "fabricInterfaces"
>;

/**
 * Injectable I/O boundaries for fixture-driven tests.
 *
 * Production deps are async (non-blocking). Tests may return sync values;
 * the collector always `await`s so the event loop can interleave other work.
 */
export type CollectorDeps = {
  readProcFile: (
    path: string,
  ) => string | undefined | Promise<string | undefined>;
  statfs: (
    path: string,
  ) => StatfsResult | null | Promise<StatfsResult | null>;
  now: () => number;
  countProcesses: () => number | null | Promise<number | null>;
  resolveDimensions: () => StaticDimensions | Promise<StaticDimensions>;
  /** Filesystem backing TurboPanel Docker volumes; `null` when Docker is absent. */
  resolveDockerDataRoot: () => Promise<string | null>;
  /** Canonical hosting storage path (admin override, else principal home root). */
  resolveHostingPath: () => string | Promise<string>;
  /** Point-in-time sensor readings, honoring admin overrides when passed. */
  readSensors: (overrides?: SensorOverrides) => Promise<SensorReadings>;
  /** TurboFabric interface names (seeded with `tp0`). */
  resolveFabricInterfaces: () => Promise<string[]>;
  /** Operator-selected sensors from daemon state; `{}` when unset. */
  resolveAdminSensorOverrides: () => Promise<SensorOverrides>;
};
