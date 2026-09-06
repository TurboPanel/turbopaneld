/**
 * Block-device domain: per-device diskstats samples + host aggregates, keyed
 * by topology `deviceId` and scoped to `isServiceDevice === true` devices
 * only (the dedicated `block` detail family with broader device coverage is
 * a later, capability-gated phase).
 *
 * Sectors are 512 bytes per kernel convention.
 */
import type { CounterBaselineTracker } from "./baseline.ts";
import { type BlockDeviceSampleV4, clampPercent } from "../contract-v4.ts";
import type { BlockDeviceTopology } from "../topology/types.ts";
import type { DiskDeviceCounters } from "./types.ts";

const SECTOR_BYTES_V4 = 512;

function toRate(delta: number | null, seconds: number): number | null {
  if (delta === null || seconds <= 0) return null;
  return delta / seconds;
}

/** `Δticks / Δops`; `null` on an idle interval (`Δops === 0`) — never a fabricated `0ms` latency. */
function latencyMs(
  ticksDelta: number | null,
  opsDelta: number | null,
): number | null {
  if (ticksDelta === null || opsDelta === null || opsDelta <= 0) return null;
  return ticksDelta / opsDelta;
}

const EMPTY_BLOCK_DEVICE_SAMPLE: Omit<BlockDeviceSampleV4, "deviceId"> = {
  readBytesPerSecond: null,
  writeBytesPerSecond: null,
  readOpsPerSecond: null,
  writeOpsPerSecond: null,
  readLatencyMs: null,
  writeLatencyMs: null,
  utilizationPercent: null,
  temperatureCelsius: null,
  queueDepth: null,
};

/** Every baseline field `buildBlockDeviceSamples`/`hostDiskAggregates` track per device. */
const DISKSTATS_BASELINE_FIELDS = [
  "readOps",
  "readSectors",
  "readTicks",
  "writeOps",
  "writeSectors",
  "writeTicks",
] as const;

/** `buildBlockDeviceSamples`-only baseline fields, beyond {@link DISKSTATS_BASELINE_FIELDS}. */
const BLOCK_DEVICE_ONLY_BASELINE_FIELDS = [
  "ioTicks",
  "weightedIoTicks",
] as const;

/**
 * One `BlockDeviceSampleV4` per topology device flagged `isServiceDevice`
 * (mirrors the ticket's "per selected service device"). `temperatureCelsius`
 * is always `null` here — sensor correlation is a later phase's job. A
 * device whose diskstats row is missing this tick stays present with every
 * field `null`, and its baseline entries are explicitly invalidated so the
 * next tick a diskstats row reappears re-origins (`null` again) instead of
 * diffing across the gap into one fabricated rate.
 */
export function buildBlockDeviceSamples(
  topology: BlockDeviceTopology[],
  currentCounters: Record<string, DiskDeviceCounters>,
  tracker: CounterBaselineTracker,
  bootGeneration: number,
  seconds: number,
): BlockDeviceSampleV4[] {
  return topology
    .filter((device) => device.isServiceDevice)
    .map((device): BlockDeviceSampleV4 => {
      const counters = currentCounters[device.kernelName];
      const key = (field: string) => `block:${device.deviceId}:${field}`;
      if (!counters) {
        for (const field of DISKSTATS_BASELINE_FIELDS) {
          tracker.invalidate(key(field));
        }
        for (const field of BLOCK_DEVICE_ONLY_BASELINE_FIELDS) {
          tracker.invalidate(key(field));
        }
        return { deviceId: device.deviceId, ...EMPTY_BLOCK_DEVICE_SAMPLE };
      }

      const readOpsDelta = tracker.delta(
        key("readOps"),
        counters.readsCompleted,
        bootGeneration,
      );
      const readSectorsDelta = tracker.delta(
        key("readSectors"),
        counters.sectorsRead,
        bootGeneration,
      );
      const readTicksDelta = tracker.delta(
        key("readTicks"),
        counters.readTicksMs,
        bootGeneration,
      );
      const writeOpsDelta = tracker.delta(
        key("writeOps"),
        counters.writesCompleted,
        bootGeneration,
      );
      const writeSectorsDelta = tracker.delta(
        key("writeSectors"),
        counters.sectorsWritten,
        bootGeneration,
      );
      const writeTicksDelta = tracker.delta(
        key("writeTicks"),
        counters.writeTicksMs,
        bootGeneration,
      );
      const ioTicksDelta = tracker.delta(
        key("ioTicks"),
        counters.ioTicksMs,
        bootGeneration,
      );
      const weightedIoTicksDelta = tracker.delta(
        key("weightedIoTicks"),
        counters.weightedIoTicksMs,
        bootGeneration,
      );

      const utilizationPercent = ioTicksDelta === null || seconds <= 0
        ? null
        : clampPercent((ioTicksDelta / (seconds * 1000)) * 100);
      const queueDepth = weightedIoTicksDelta === null || seconds <= 0
        ? null
        : weightedIoTicksDelta / (seconds * 1000);

      return {
        deviceId: device.deviceId,
        readBytesPerSecond: toRate(
          readSectorsDelta === null ? null : readSectorsDelta * SECTOR_BYTES_V4,
          seconds,
        ),
        writeBytesPerSecond: toRate(
          writeSectorsDelta === null
            ? null
            : writeSectorsDelta * SECTOR_BYTES_V4,
          seconds,
        ),
        readOpsPerSecond: toRate(readOpsDelta, seconds),
        writeOpsPerSecond: toRate(writeOpsDelta, seconds),
        readLatencyMs: latencyMs(readTicksDelta, readOpsDelta),
        writeLatencyMs: latencyMs(writeTicksDelta, writeOpsDelta),
        utilizationPercent,
        temperatureCelsius: null,
        queueDepth,
      };
    });
}

/** Max `utilizationPercent` across `samples`; `null` when empty or every entry is `null`. */
export function maxBlockDeviceUtilPercent(
  samples: BlockDeviceSampleV4[],
): number | null {
  let max: number | null = null;
  for (const sample of samples) {
    if (sample.utilizationPercent === null) continue;
    if (max === null || sample.utilizationPercent > max) {
      max = sample.utilizationPercent;
    }
  }
  return max;
}

export type HostDiskAggregates = {
  diskReadBytesPerSecond: number | null;
  diskWriteBytesPerSecond: number | null;
  diskReadLatencyMs: number | null;
  diskWriteLatencyMs: number | null;
};

function invalidateDiskHostBaselines(
  tracker: CounterBaselineTracker,
  deviceId: string,
): void {
  const prefix = `diskhost:${deviceId}:`;
  for (const field of DISKSTATS_BASELINE_FIELDS) {
    tracker.invalidate(`${prefix}${field}`);
  }
}

type DirectionSums = {
  ops: number;
  sectors: number;
  ticks: number;
};

function addCompleteDirection(
  sums: DirectionSums,
  ops: number | null,
  sectors: number | null,
  ticks: number | null,
): boolean {
  if (ops === null || sectors === null || ticks === null) {
    return false;
  }
  sums.ops += ops;
  sums.sectors += sectors;
  sums.ticks += ticks;
  return true;
}

/**
 * Host-wide disk aggregates summed across the same service-device set
 * `buildBlockDeviceSamples` uses — never double-counting partitions/dm
 * layers, matching v3's `diskRates` membership-safe summation pattern.
 * Host-level latency is `Σticks / Σops` across that set (same weighting v3
 * uses today). Uses its own tracker key namespace (`diskhost:` vs.
 * `buildBlockDeviceSamples`'s `block:`) so the two independent consumers of
 * the same raw counters never share — and corrupt — one baseline entry.
 */
export function hostDiskAggregates(
  topology: BlockDeviceTopology[],
  currentCounters: Record<string, DiskDeviceCounters>,
  tracker: CounterBaselineTracker,
  bootGeneration: number,
  seconds: number,
): HostDiskAggregates {
  const serviceDevices = topology.filter((device) => device.isServiceDevice);
  const read: DirectionSums = { ops: 0, sectors: 0, ticks: 0 };
  const write: DirectionSums = { ops: 0, sectors: 0, ticks: 0 };
  let sawReadDelta = false;
  let sawWriteDelta = false;

  for (const device of serviceDevices) {
    const counters = currentCounters[device.kernelName];
    if (!counters) {
      invalidateDiskHostBaselines(tracker, device.deviceId);
      continue;
    }
    const key = (field: string) => `diskhost:${device.deviceId}:${field}`;

    if (
      addCompleteDirection(
        read,
        tracker.delta(key("readOps"), counters.readsCompleted, bootGeneration),
        tracker.delta(key("readSectors"), counters.sectorsRead, bootGeneration),
        tracker.delta(key("readTicks"), counters.readTicksMs, bootGeneration),
      )
    ) {
      sawReadDelta = true;
    }
    if (
      addCompleteDirection(
        write,
        tracker.delta(
          key("writeOps"),
          counters.writesCompleted,
          bootGeneration,
        ),
        tracker.delta(
          key("writeSectors"),
          counters.sectorsWritten,
          bootGeneration,
        ),
        tracker.delta(key("writeTicks"), counters.writeTicksMs, bootGeneration),
      )
    ) {
      sawWriteDelta = true;
    }
  }

  return {
    diskReadBytesPerSecond: sawReadDelta
      ? toRate(read.sectors * SECTOR_BYTES_V4, seconds)
      : null,
    diskWriteBytesPerSecond: sawWriteDelta
      ? toRate(write.sectors * SECTOR_BYTES_V4, seconds)
      : null,
    diskReadLatencyMs: sawReadDelta ? latencyMs(read.ticks, read.ops) : null,
    diskWriteLatencyMs: sawWriteDelta
      ? latencyMs(write.ticks, write.ops)
      : null,
  };
}
