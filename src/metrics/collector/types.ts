import type { HostMetricsDimensions, HostMetricsSample } from "../contract.ts";

/** Outcome of a single collect() invocation. */
export type MetricsCollectResult =
  | { supported: true; sample: HostMetricsSample }
  | { supported: false; reason: string };

/**
 * Host metrics collector seam for Phase 3 scheduler integration.
 *
 * The scheduler owns monotonic `sequence` generation; the collector only
 * consumes the value passed in `collect({ sequence })`.
 */
export interface MetricsCollector {
  collect(options: {
    sequence: number;
    nowMs?: number;
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
};

/** Filtered whole-disk counters keyed by stable device name. */
export type DiskCounters = {
  devices: Record<string, DiskDeviceCounters>;
};

export type NetInterfaceCounters = {
  receiveBytes: number;
  transmitBytes: number;
};

/** Filtered physical interface counters keyed by stable interface name. */
export type NetCounters = {
  interfaces: Record<string, NetInterfaceCounters>;
};

export type LoadGauges = {
  one: number;
  five: number;
  fifteen: number;
};

export type MemoryGauges = {
  memoryUsedBytes: number;
  memoryAvailableBytes: number;
  memoryUsedPercent: number;
  swapUsedPercent: number | null;
};

export type DiskCapacityGauges = {
  diskUsedPercent: number;
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
  diskCapacity: DiskCapacityGauges | null;
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
  resolveDimensions: () =>
    | HostMetricsDimensions
    | Promise<HostMetricsDimensions>;
};
