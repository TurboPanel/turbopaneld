import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import { CounterBaselineTracker } from "./baseline.ts";
import {
  buildBlockDeviceSamples,
  buildBlockDeviceTemperatures,
  hostDiskAggregates,
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

  const first = parseDiskstatsRows(fixture("proc-diskstats-v5-virtio-1.txt"));
  buildBlockDeviceSamples(topology, first, tracker, 0, 60);

  const second = parseDiskstatsRows(fixture("proc-diskstats-v5-virtio-2.txt"));
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
    parseDiskstatsRows(fixture("proc-diskstats-v5-nvme-1.txt")),
    tracker,
    0,
    60,
  );
  const samples = buildBlockDeviceSamples(
    topology,
    parseDiskstatsRows(fixture("proc-diskstats-v5-nvme-2.txt")),
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
    parseDiskstatsRows(fixture("proc-diskstats-v5-idle-1.txt")),
    tracker,
    0,
    60,
  );
  const samples = buildBlockDeviceSamples(
    topology,
    parseDiskstatsRows(fixture("proc-diskstats-v5-idle-2.txt")),
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
    parseDiskstatsRows(fixture("proc-diskstats-v5-partition-1.txt")),
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

it("buildBlockDeviceSamples keeps the baseline across a missing row, so one bad read costs one interval and not two", () => {
  const tracker = new CounterBaselineTracker();
  const topology = [serviceDevice({ kernelName: "vda", deviceId: "blk:vda" })];

  // Tick 1: normal reading — establishes the baseline.
  buildBlockDeviceSamples(
    topology,
    parseDiskstatsRows(fixture("proc-diskstats-v5-virtio-1.txt")),
    tracker,
    0,
    60,
  );

  // Tick 2: the diskstats row is missing this tick (simulated gap). Rates
  // are null for this interval, but the baseline is deliberately *kept* —
  // v4 invalidated here, which turned one transient read failure into two
  // consecutive null samples (a two-minute hole at the 60 s cadence).
  const gapTick = buildBlockDeviceSamples(topology, {}, tracker, 0, 60);
  assertEquals(gapTick[0].readBytesPerSecond, null);

  const virtio2 = parseDiskstatsRows(fixture("proc-diskstats-v5-virtio-2.txt"));

  // Tick 3: the row reappears and immediately produces a real rate, diffed
  // against the tick-1 baseline. No second wasted interval.
  const resumedTick = buildBlockDeviceSamples(
    topology,
    virtio2,
    tracker,
    0,
    60,
  );
  assertEquals(resumedTick[0].readBytesPerSecond !== null, true);
  assertEquals(resumedTick[0].readOpsPerSecond !== null, true);
});

it("buildBlockDeviceSamples still nulls a rate when the counter actually goes backwards", () => {
  const tracker = new CounterBaselineTracker();
  const topology = [serviceDevice({ kernelName: "vda", deviceId: "blk:vda" })];
  const virtio1 = parseDiskstatsRows(fixture("proc-diskstats-v5-virtio-1.txt"));
  const virtio2 = parseDiskstatsRows(fixture("proc-diskstats-v5-virtio-2.txt"));

  // Baseline at the *higher* counters, then hand back the lower ones: a
  // device replacement or counter wrap, which must still re-origin rather
  // than emit a negative or wrapped rate.
  buildBlockDeviceSamples(topology, virtio2, tracker, 0, 60);
  const wrapped = buildBlockDeviceSamples(topology, virtio1, tracker, 0, 60);
  assertEquals(wrapped[0].readBytesPerSecond, null);
});

it("buildBlockDeviceSamples joins drive temperature onto the device by kernel name", () => {
  const tracker = new CounterBaselineTracker();
  const topology = [serviceDevice({ kernelName: "vda", deviceId: "blk:vda" })];
  const samples = buildBlockDeviceSamples(
    topology,
    parseDiskstatsRows(fixture("proc-diskstats-v5-virtio-1.txt")),
    tracker,
    0,
    60,
    { vda: 41 },
  );
  assertEquals(samples[0].temperatureCelsius, 41);
});

it("buildBlockDeviceTemperatures prefers NVMe Composite over the numbered internal sensors", () => {
  const temps = buildBlockDeviceTemperatures([
    { signalId: "signal:nvme0n1:Sensor 1", kind: "temperature", value: 58 },
    { signalId: "signal:nvme0n1:Composite", kind: "temperature", value: 44 },
    { signalId: "signal:nvme0n1:Sensor 8", kind: "temperature", value: 61 },
  ]);
  assertEquals(temps["nvme0n1"], 44);
});

it("buildBlockDeviceTemperatures falls back to the hottest probe when there is no Composite", () => {
  const temps = buildBlockDeviceTemperatures([
    { signalId: "signal:sda:temp1", kind: "temperature", value: 33 },
    { signalId: "signal:sda:temp2", kind: "temperature", value: 37 },
  ]);
  assertEquals(temps["sda"], 37);
});

it("buildBlockDeviceTemperatures ignores non-temperature signals and null readings", () => {
  const temps = buildBlockDeviceTemperatures([
    { signalId: "signal:cpu:package-0", kind: "power", value: 34 },
    { signalId: "signal:nvme0n1:Composite", kind: "temperature", value: null },
  ]);
  assertEquals(temps["cpu"], undefined);
  assertEquals(temps["nvme0n1"], undefined);
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
    parseDiskstatsRows(fixture("proc-diskstats-v5-partition-1.txt")),
    tracker,
    0,
    60,
  );
  const aggregates = hostDiskAggregates(
    topology,
    parseDiskstatsRows(fixture("proc-diskstats-v5-partition-2.txt")),
    tracker,
    0,
    60,
  );

  // Only sda (the service device) contributes — sda1 (a partition, never a
  // service device) is excluded even though its counters also moved.
  assertEquals(aggregates.diskReadBytesPerSecond, (3000 * 512) / 60);
  assertEquals(aggregates.diskWriteBytesPerSecond, (14000 * 512) / 60);
  // v5 reports one combined service time: (Σread + Σwrite ticks) over
  // (Σread + Σwrite ops), rather than v4's separate read/write host figures
  // — the per-drive split now rides the storage row directly.
  assertEquals(aggregates.diskLatencyMs, (60 + 180) / (100 + 100));
});

it("hostDiskAggregates nulls the interval right after a missing-row gap, then resumes real rates the interval after that", () => {
  const tracker = new CounterBaselineTracker();
  const topology = [serviceDevice({ kernelName: "sda", deviceId: "blk:sda" })];

  // Tick 1: normal reading — establishes the baseline.
  hostDiskAggregates(
    topology,
    parseDiskstatsRows(fixture("proc-diskstats-v5-partition-1.txt")),
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
    fixture("proc-diskstats-v5-partition-2.txt"),
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
