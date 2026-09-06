import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import { CounterBaselineTracker } from "./baseline.ts";
import {
  buildBlockDeviceSamples,
  hostDiskAggregates,
  maxBlockDeviceUtilPercent,
} from "./block-devices.ts";
import { parseDiskstatsRows } from "./parse-diskstats.ts";
import type { BlockDeviceTopology } from "../topology/types.ts";

function fixture(name: string): string {
  return Deno.readTextFileSync(
    new URL(`./testdata/${name}`, import.meta.url),
  );
}

function serviceDevice(
  overrides: Partial<BlockDeviceTopology> = {},
): BlockDeviceTopology {
  return {
    deviceId: `blk:${overrides.kernelName ?? "vda"}`,
    kernelName: overrides.kernelName ?? "vda",
    deviceType: "physical",
    isServiceDevice: true,
    ...overrides,
  };
}

it("buildBlockDeviceSamples computes per-device rate/latency/utilization/queue-depth math (single virtio disk)", () => {
  const tracker = new CounterBaselineTracker();
  const topology = [serviceDevice({ kernelName: "vda", deviceId: "blk:vda" })];

  const first = parseDiskstatsRows(fixture("proc-diskstats-v4-virtio-1.txt"));
  buildBlockDeviceSamples(topology, first, tracker, 0, 60);

  const second = parseDiskstatsRows(fixture("proc-diskstats-v4-virtio-2.txt"));
  const samples = buildBlockDeviceSamples(topology, second, tracker, 0, 60);

  assertEquals(samples, [{
    deviceId: "blk:vda",
    readBytesPerSecond: (3000 * 512) / 60,
    writeBytesPerSecond: (14000 * 512) / 60,
    readOpsPerSecond: 100 / 60,
    writeOpsPerSecond: 100 / 60,
    readLatencyMs: 60 / 100,
    writeLatencyMs: 180 / 100,
    utilizationPercent: (900 / (60 * 1000)) * 100,
    temperatureCelsius: null,
    queueDepth: 1800 / (60 * 1000),
  }]);
});

it("buildBlockDeviceSamples computes correct math for NVMe naming", () => {
  const tracker = new CounterBaselineTracker();
  const topology = [
    serviceDevice({ kernelName: "nvme0n1", deviceId: "blk:nvme0n1" }),
  ];

  buildBlockDeviceSamples(
    topology,
    parseDiskstatsRows(fixture("proc-diskstats-v4-nvme-1.txt")),
    tracker,
    0,
    60,
  );
  const samples = buildBlockDeviceSamples(
    topology,
    parseDiskstatsRows(fixture("proc-diskstats-v4-nvme-2.txt")),
    tracker,
    0,
    60,
  );

  assertEquals(samples[0].readBytesPerSecond, (6000 * 512) / 60);
  assertEquals(samples[0].writeBytesPerSecond, (28000 * 512) / 60);
  assertEquals(samples[0].utilizationPercent, (1800 / (60 * 1000)) * 100);
  assertEquals(samples[0].queueDepth, 3600 / (60 * 1000));
});

it("buildBlockDeviceSamples reports null latency (not 0) on a genuinely idle interval", () => {
  const tracker = new CounterBaselineTracker();
  const topology = [serviceDevice({ kernelName: "sdb", deviceId: "blk:sdb" })];

  buildBlockDeviceSamples(
    topology,
    parseDiskstatsRows(fixture("proc-diskstats-v4-idle-1.txt")),
    tracker,
    0,
    60,
  );
  const samples = buildBlockDeviceSamples(
    topology,
    parseDiskstatsRows(fixture("proc-diskstats-v4-idle-2.txt")),
    tracker,
    0,
    60,
  );

  assertEquals(samples[0].readOpsPerSecond, 0);
  assertEquals(samples[0].readLatencyMs, null);
  assertEquals(samples[0].writeLatencyMs, null);
});

it("buildBlockDeviceSamples excludes partitions from the detailed array", () => {
  const tracker = new CounterBaselineTracker();
  const topology = [
    serviceDevice({ kernelName: "sda", deviceId: "blk:sda" }),
    serviceDevice({
      kernelName: "sda1",
      deviceId: "blk:sda1",
      deviceType: "partition",
      isServiceDevice: false,
      parentDeviceId: "blk:sda",
    }),
  ];

  const samples = buildBlockDeviceSamples(
    topology,
    parseDiskstatsRows(fixture("proc-diskstats-v4-partition-1.txt")),
    tracker,
    0,
    60,
  );
  assertEquals(samples.map((s) => s.deviceId), ["blk:sda"]);
});

it("buildBlockDeviceSamples keeps an entry present with null fields when the diskstats row is missing", () => {
  const tracker = new CounterBaselineTracker();
  const topology = [
    serviceDevice({ kernelName: "missing", deviceId: "blk:missing" }),
  ];
  const samples = buildBlockDeviceSamples(topology, {}, tracker, 0, 60);
  assertEquals(samples, [{
    deviceId: "blk:missing",
    readBytesPerSecond: null,
    writeBytesPerSecond: null,
    readOpsPerSecond: null,
    writeOpsPerSecond: null,
    readLatencyMs: null,
    writeLatencyMs: null,
    utilizationPercent: null,
    temperatureCelsius: null,
    queueDepth: null,
  }]);
});

it("buildBlockDeviceSamples nulls the interval right after a missing-row gap, then resumes real rates the interval after that", () => {
  const tracker = new CounterBaselineTracker();
  const topology = [serviceDevice({ kernelName: "vda", deviceId: "blk:vda" })];

  // Tick 1: normal reading — establishes the baseline.
  buildBlockDeviceSamples(
    topology,
    parseDiskstatsRows(fixture("proc-diskstats-v4-virtio-1.txt")),
    tracker,
    0,
    60,
  );

  // Tick 2: the diskstats row is missing this tick (simulated gap) — the
  // baseline is invalidated, not just skipped.
  const gapTick = buildBlockDeviceSamples(topology, {}, tracker, 0, 60);
  assertEquals(gapTick[0].readBytesPerSecond, null);

  const virtio2 = parseDiskstatsRows(fixture("proc-diskstats-v4-virtio-2.txt"));

  // Tick 3: the row reappears, but this is the first observation after the
  // invalidated baseline — null, re-baselined, never a rate compressing the
  // (unknown) elapsed gap into one interval.
  const firstResumedTick = buildBlockDeviceSamples(
    topology,
    virtio2,
    tracker,
    0,
    60,
  );
  assertEquals(firstResumedTick[0].readBytesPerSecond, null);
  assertEquals(firstResumedTick[0].readOpsPerSecond, null);
  assertEquals(firstResumedTick[0].readLatencyMs, null);

  // Tick 4: the interval after that computes a real (here zero-delta, since
  // the fixture is unchanged) rate/latency against the tick-3 baseline.
  const secondResumedTick = buildBlockDeviceSamples(
    topology,
    virtio2,
    tracker,
    0,
    60,
  );
  assertEquals(secondResumedTick[0].readBytesPerSecond, 0);
  assertEquals(secondResumedTick[0].readOpsPerSecond, 0);
  assertEquals(secondResumedTick[0].readLatencyMs, null);
});

it("maxBlockDeviceUtilPercent picks the correct max and returns null on an empty/all-null set", () => {
  assertEquals(maxBlockDeviceUtilPercent([]), null);
  assertEquals(
    maxBlockDeviceUtilPercent([
      {
        deviceId: "a",
        readBytesPerSecond: null,
        writeBytesPerSecond: null,
        readOpsPerSecond: null,
        writeOpsPerSecond: null,
        readLatencyMs: null,
        writeLatencyMs: null,
        utilizationPercent: null,
        temperatureCelsius: null,
        queueDepth: null,
      },
    ]),
    null,
  );
  assertEquals(
    maxBlockDeviceUtilPercent([
      {
        deviceId: "a",
        readBytesPerSecond: null,
        writeBytesPerSecond: null,
        readOpsPerSecond: null,
        writeOpsPerSecond: null,
        readLatencyMs: null,
        writeLatencyMs: null,
        utilizationPercent: 12,
        temperatureCelsius: null,
        queueDepth: null,
      },
      {
        deviceId: "b",
        readBytesPerSecond: null,
        writeBytesPerSecond: null,
        readOpsPerSecond: null,
        writeOpsPerSecond: null,
        readLatencyMs: null,
        writeLatencyMs: null,
        utilizationPercent: 87,
        temperatureCelsius: null,
        queueDepth: null,
      },
    ]),
    87,
  );
});

it("hostDiskAggregates sums correctly across the service-device set, excluding non-service devices", () => {
  const tracker = new CounterBaselineTracker();
  const topology = [
    serviceDevice({ kernelName: "sda", deviceId: "blk:sda" }),
    serviceDevice({
      kernelName: "sda1",
      deviceId: "blk:sda1",
      deviceType: "partition",
      isServiceDevice: false,
      parentDeviceId: "blk:sda",
    }),
  ];

  hostDiskAggregates(
    topology,
    parseDiskstatsRows(fixture("proc-diskstats-v4-partition-1.txt")),
    tracker,
    0,
    60,
  );
  const aggregates = hostDiskAggregates(
    topology,
    parseDiskstatsRows(fixture("proc-diskstats-v4-partition-2.txt")),
    tracker,
    0,
    60,
  );

  // Only sda (the service device) contributes — sda1 (a partition, never a
  // service device) is excluded even though its counters also moved.
  assertEquals(aggregates.diskReadBytesPerSecond, (3000 * 512) / 60);
  assertEquals(aggregates.diskWriteBytesPerSecond, (14000 * 512) / 60);
  assertEquals(aggregates.diskReadLatencyMs, 60 / 100);
  assertEquals(aggregates.diskWriteLatencyMs, 180 / 100);
});

it("hostDiskAggregates nulls the interval right after a missing-row gap, then resumes real rates the interval after that", () => {
  const tracker = new CounterBaselineTracker();
  const topology = [serviceDevice({ kernelName: "sda", deviceId: "blk:sda" })];

  // Tick 1: normal reading — establishes the baseline.
  hostDiskAggregates(
    topology,
    parseDiskstatsRows(fixture("proc-diskstats-v4-partition-1.txt")),
    tracker,
    0,
    60,
  );

  // Tick 2: the diskstats row is missing this tick (simulated gap) — the
  // baseline is invalidated, not just skipped.
  const gapTick = hostDiskAggregates(topology, {}, tracker, 0, 60);
  assertEquals(gapTick.diskReadBytesPerSecond, null);
  assertEquals(gapTick.diskWriteBytesPerSecond, null);

  const partition2 = parseDiskstatsRows(
    fixture("proc-diskstats-v4-partition-2.txt"),
  );

  // Tick 3: the row reappears, but this is the first observation after the
  // invalidated baseline — null, never a rate compressing the (unknown)
  // elapsed gap into one interval.
  const firstResumedTick = hostDiskAggregates(
    topology,
    partition2,
    tracker,
    0,
    60,
  );
  assertEquals(firstResumedTick.diskReadBytesPerSecond, null);
  assertEquals(firstResumedTick.diskWriteBytesPerSecond, null);

  // Tick 4: the interval after that computes a real (here zero-delta, since
  // the fixture is unchanged) rate against the tick-3 baseline.
  const secondResumedTick = hostDiskAggregates(
    topology,
    partition2,
    tracker,
    0,
    60,
  );
  assertEquals(secondResumedTick.diskReadBytesPerSecond, 0);
  assertEquals(secondResumedTick.diskWriteBytesPerSecond, 0);
});
