import type {
  MetricsCollectionModeV4 as MetricsCollectionMode,
  MetricsSampleV4,
} from "../contract-v4.ts";

/** Outcome of a single collect() invocation: an entity-grouped `MetricsSampleV4`. */
export type MetricsCollectResult =
  | { supported: true; sample: MetricsSampleV4 }
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
   */
  nicSlot1DeviceId?: string | null;
  nicSlot2DeviceId?: string | null;
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
