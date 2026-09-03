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
 * cell socket (`metrics-sensor-overrides-update`) and cached as daemon
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
  generation?: number;
  generationAppliedAt?: string;
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
  /** Vendor busy-percent gauge (`amdgpu`/i915); `null` on NVIDIA (unsupported). */
  gpuUtilizationPercent: number | null;
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

/**
 * One scrape of the site Caddy's Prometheus exposition (`/metrics` on its
 * admin listener). Counter fields are cumulative-since-process-start, exactly
 * as Caddy reports them — the collector derives per-interval deltas via
 * `counterDelta`. `requestsInFlight` is the only gauge.
 */
export type CaddyCounters = {
  requestsTotal: number;
  responses2xxTotal: number;
  responses3xxTotal: number;
  responses4xxTotal: number;
  responses5xxTotal: number;
  requestBytesTotal: number;
  responseBytesTotal: number;
  requestDurationSecondsSum: number;
  requestsUnder100msTotal: number;
  requestsUnder1sTotal: number;
  requestsInFlight: number;
};

/**
 * One scrape of ProxySQL's REST API (`admin-restapi_enabled`) `/metrics`
 * endpoint. `queriesTotal`/`slowQueriesTotal`/`connectionErrorsTotal` are
 * cumulative counters (delta'd by the collector); the connection-count and
 * backend fields are point-in-time gauges.
 */
export type ProxySqlCounters = {
  queriesTotal: number;
  slowQueriesTotal: number;
  connectionErrorsTotal: number;
  clientConnections: number;
  backendConnections: number;
  backendsUp: number;
};

/**
 * Combined traffic-sidecar scrape for one tick. Each source is independently
 * `null` when its process is absent or unreachable — a host running only
 * ProxySQL (no site Caddy) still reports `proxysql` fields.
 */
export type ProxyCounters = {
  caddy: CaddyCounters | null;
  proxysql: ProxySqlCounters | null;
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
  nicSlots: NicSlots;
  proxy: ProxyCounters | null;
};

export type StatfsResult = {
  blocks: number;
  bfree: number;
  bavail: number;
  bsize: number;
};

/**
 * Static per-sample dimensions the collector cannot know from its own I/O:
 * everything but `collectionMode` (per-collect), `hardwareProfileGeneration`
 * (stamped from the resolved `HardwareProfile.generation`), and
 * `trafficSources` (stamped from the tick's `readProxyCounters()` result) —
 * sensor/interface identities live in Postgres via the hardware-profile round
 * trip, never on the wire sample itself.
 */
export type StaticDimensions = Omit<
  HostMetricsDimensions,
  "collectionMode" | "hardwareProfileGeneration" | "trafficSources"
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
  /** Resolved hardware-profile generation for `dimensions.hardwareProfileGeneration`; `0` when unset. */
  resolveHardwareProfileGeneration: () => number | Promise<number>;
  /** Operator-assigned NIC-slot interface names (`HardwareProfile.nic1`/`.nic2`); `null` slot when unset. */
  resolveNicSlots: () => Promise<NicSlots>;
  /**
   * Traffic-sidecar scrape (site Caddy + ProxySQL REST `/metrics`). Never
   * throws — each source resolves independently to `null` on any
   * network/parse failure.
   */
  readProxyCounters: () => Promise<ProxyCounters>;
};
