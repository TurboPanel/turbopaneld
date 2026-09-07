/**
 * Block-device domain: per-device diskstats samples + host aggregates, keyed
 * by topology `deviceId` and scoped to `isServiceDevice === true` devices
 * only (the dedicated `block` detail family with broader device coverage is
 * a later, capability-gated phase).
 *
 * Sectors are 512 bytes per kernel convention.
 */
import type { CounterBaselineTracker } from "./baseline.ts";
import { type BlockDeviceSampleV5, clampPercent } from "../contract-v5.ts";
import type { BlockDeviceTopology } from "../topology/types.ts";
import type { DiskDeviceCounters } from "./types.ts";

const SECTOR_BYTES_V5 = 512;

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

const EMPTY_BLOCK_DEVICE_SAMPLE: Omit<BlockDeviceSampleV5, "deviceId"> = {
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

/**
 * One `BlockDeviceSampleV5` per topology device flagged `isServiceDevice`
 * (mirrors the ticket's "per selected service device"). `temperatureCelsius`
 * is joined from the hardware-signal catalog by kernel name — see
 * {@link BlockDeviceTemperatures}.
 *
 * A device whose diskstats row is missing this tick reports every rate
 * `null` for that tick but **keeps its baseline**. v4 invalidated here,
 * which cost two ticks of nulls for one bad read — the tick itself, then
 * the re-origin tick — i.e. a two-minute hole in the chart at the 60 s
 * cadence from a single transient failure. The baseline is only genuinely
 * invalid when the counter goes backwards or the host rebooted, and
 * `CounterBaselineTracker.delta` already detects both, so carrying it
 * across a missing read is safe: the next successful read diffs against the
 * older origin and divides by the real elapsed time.
 */
export function buildBlockDeviceSamples(
  topology: BlockDeviceTopology[],
  currentCounters: Record<string, DiskDeviceCounters>,
  tracker: CounterBaselineTracker,
  bootGeneration: number,
  seconds: number,
  temperatures?: BlockDeviceTemperatures,
): BlockDeviceSampleV5[] {
  return topology
    .filter((device) => device.isServiceDevice)
    .map((device): BlockDeviceSampleV5 => {
      const counters = currentCounters[device.kernelName];
      const key = (field: string) => `block:${device.deviceId}:${field}`;
      if (!counters) {
        // Baselines are deliberately kept — see this function's doc comment.
        return {
          deviceId: device.deviceId,
          ...EMPTY_BLOCK_DEVICE_SAMPLE,
          temperatureCelsius: temperatures?.[device.kernelName] ?? null,
        };
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
          readSectorsDelta === null ? null : readSectorsDelta * SECTOR_BYTES_V5,
          seconds,
        ),
        writeBytesPerSecond: toRate(
          writeSectorsDelta === null
            ? null
            : writeSectorsDelta * SECTOR_BYTES_V5,
          seconds,
        ),
        readOpsPerSecond: toRate(readOpsDelta, seconds),
        writeOpsPerSecond: toRate(writeOpsDelta, seconds),
        readLatencyMs: latencyMs(readTicksDelta, readOpsDelta),
        writeLatencyMs: latencyMs(writeTicksDelta, writeOpsDelta),
        utilizationPercent,
        temperatureCelsius: temperatures?.[device.kernelName] ?? null,
        queueDepth,
      };
    });
}

/**
 * Per-kernel-name drive temperature, keyed the way `/proc/diskstats` names
 * devices (`nvme0n1`, `sda`) so it joins straight onto block topology.
 */
export type BlockDeviceTemperatures = Record<string, number | null>;

/** NVMe's own composite reading — the drive-level temperature, not one internal probe. */
const NVME_COMPOSITE_LABEL = "Composite";

/**
 * Build the block-device ↔ sensor temperature join.
 *
 * Disk temperatures arrive as hardware signals keyed
 * `signal:<kernelName>:<label>` — `discovery.ts` already resolves an NVMe or
 * `drivetemp` hwmon chip down to its backing block device, which is exactly
 * the `kernelName` block topology uses. v4 never closed this loop and left
 * `BlockDeviceSampleV5.temperatureCelsius` hardcoded `null`, so drive temps
 * existed only as loose sensor rows and never reached the drive itself.
 *
 * NVMe exposes several probes per drive (`Composite`, `Sensor 1` …
 * `Sensor 8`); `Composite` is the vendor-computed whole-drive value the NVMe
 * spec defines and the one that drives the drive's own thermal throttling,
 * so it wins outright. Otherwise the hottest reading for that device is used
 * — a `drivetemp` SATA disk only ever reports one.
 */
export function buildBlockDeviceTemperatures(
  signals: readonly { signalId: string; kind: string; value: number | null }[],
): BlockDeviceTemperatures {
  const out: BlockDeviceTemperatures = {};
  const fromComposite = new Set<string>();
  for (const signal of signals) {
    if (signal.kind !== "temperature" || signal.value === null) continue;
    const parts = signal.signalId.split(":");
    if (parts.length < 3 || parts[0] !== "signal") continue;
    const kernelName = parts[1]!;
    const label = parts.slice(2).join(":");
    if (label === NVME_COMPOSITE_LABEL) {
      out[kernelName] = signal.value;
      fromComposite.add(kernelName);
      continue;
    }
    // A composite reading is authoritative: never let a hotter internal
    // probe overwrite it, whichever order the signals arrive in.
    if (fromComposite.has(kernelName)) continue;
    const current = out[kernelName];
    if (current === undefined || current === null || signal.value > current) {
      out[kernelName] = signal.value;
    }
  }
  return out;
}

export type HostDiskAggregates = {
  diskReadBytesPerSecond: number | null;
  diskWriteBytesPerSecond: number | null;
  /**
   * Combined read+write service time, Σticks/Σops across the service set.
   * v5 collapses v4's separate read/write host latencies into one: per-disk
   * read and write latency both ride the storage row now, so the host-level
   * split was duplicating a breakdown that is directly available.
   */
  diskLatencyMs: number | null;
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
      ? toRate(read.sectors * SECTOR_BYTES_V5, seconds)
      : null,
    diskWriteBytesPerSecond: sawWriteDelta
      ? toRate(write.sectors * SECTOR_BYTES_V5, seconds)
      : null,
    diskLatencyMs: sawReadDelta || sawWriteDelta
      ? latencyMs(read.ticks + write.ticks, read.ops + write.ops)
      : null,
  };
}
