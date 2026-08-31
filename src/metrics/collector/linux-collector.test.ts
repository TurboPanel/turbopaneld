import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import { LinuxMetricsCollector } from "./linux-collector.ts";
import type { CollectorDeps, SensorReadings, StatfsResult } from "./types.ts";
import { METRICS_SCHEMA_VERSION } from "../contract.ts";

function fixture(name: string): string {
  return Deno.readTextFileSync(
    new URL(`./testdata/${name}`, import.meta.url),
  );
}

const DISKSTATS_1 =
  "   8       0 sda 1000 200 30000 400 500 600 70000 800 0 0 0 0 0 0\n";
const DISKSTATS_2 =
  "   8       0 sda 1600 200 60000 700 800 600 100000 1100 0 0 0 0 0 0\n";
const DISKSTATS_2_SDB_APPEARS = DISKSTATS_2 +
  "   8      16 sdb 500 100 15000 200 250 300 35000 400 0 0 0 0 0 0\n";

const NET_DEV_1 = fixture("proc-net-dev-with-fabric-tunnel.txt");
const NET_DEV_2 = NET_DEV_1
  .replace("  eth0: 5000000", "  eth0: 5600000")
  .replace("3000000    2000", "3300000    2100")
  .replace("   tp0: 400000", "   tp0: 460000")
  .replace("300000      150", "330000      160");
const NET_DEV_2_NO_VETH = NET_DEV_2
  .split("\n")
  .filter((line) => !line.includes("veth123"))
  .join("\n");

const STATFS_BY_PATH: Record<string, StatfsResult> = {
  "/": { blocks: 1_000_000, bfree: 400_000, bavail: 350_000, bsize: 4096 },
  "/srv/users": {
    blocks: 500_000,
    bfree: 200_000,
    bavail: 150_000,
    bsize: 4096,
  },
  "/var/lib/docker": {
    blocks: 250_000,
    bfree: 100_000,
    bavail: 50_000,
    bsize: 4096,
  },
  "/mnt/docker-data": {
    blocks: 2_000_000,
    bfree: 1_000_000,
    bavail: 900_000,
    bsize: 4096,
  },
};

function expectedStorage(path: string): {
  totalBytes: number;
  availableBytes: number;
} {
  // Raw-capacity contract: normalize first (blocks * bsize), aggregate later.
  const stat = STATFS_BY_PATH[path]!;
  return {
    totalBytes: stat.blocks * stat.bsize,
    availableBytes: stat.bavail * stat.bsize,
  };
}

function sensorReadings(energyMicrojoules: number): SensorReadings {
  return {
    cpuTemperatureCelsius: 45,
    gpuTemperatureCelsius: 61,
    gpuPowerWatts: 37,
    cpuEnergy: { energyMicrojoules, maxEnergyRangeMicrojoules: null },
    sensors: {
      cpuTemperatureSensor: "coretemp:Package id 0",
      gpuTemperatureSensor: "amdgpu:edge",
      cpuPowerSensor: "intel-rapl:package-0",
      gpuPowerSensor: "amdgpu:PPT",
    },
  };
}

type FixtureState = {
  statText: string;
  diskText: string;
  netText: string;
  memText: string;
  bootText: string;
  energyMicrojoules: number;
  dockerRoot: string | null;
  mountsText?: string;
};

function createDeps(
  state: FixtureState,
  overrides?: Partial<CollectorDeps>,
): CollectorDeps {
  return {
    readProcFile(path: string) {
      if (path === "/proc/stat") return state.statText;
      if (path === "/proc/meminfo") return state.memText;
      if (path === "/proc/loadavg") return fixture("proc-loadavg.txt");
      if (path === "/proc/uptime") return fixture("proc-uptime.txt");
      if (path === "/proc/diskstats") return state.diskText;
      if (path === "/proc/net/dev") return state.netText;
      if (path === "/proc/mounts") return state.mountsText;
      if (path === "/proc/sys/kernel/random/boot_id") return state.bootText;
      return undefined;
    },
    statfs: (path: string) => STATFS_BY_PATH[path] ?? null,
    now: () => 1_000_000,
    countProcesses: () => 42,
    resolveDimensions: () => ({
      schemaVersion: METRICS_SCHEMA_VERSION,
      daemonVersion: "testcommit",
      operatingSystem: "Test OS",
      architecture: "aarch64",
      kernelRelease: "6.1.0-amd64",
    }),
    resolveDockerDataRoot: () => Promise.resolve(state.dockerRoot),
    resolveHostingPath: () => "/srv/users",
    readSensors: () => Promise.resolve(sensorReadings(state.energyMicrojoules)),
    resolveFabricInterfaces: () => Promise.resolve(["tp0"]),
    resolveAdminSensorOverrides: () => Promise.resolve({}),
    ...overrides,
  };
}

function defaultState(): FixtureState {
  return {
    statText: fixture("proc-stat-full-fields-1.txt"),
    diskText: DISKSTATS_1,
    netText: NET_DEV_1,
    memText: fixture("proc-meminfo.txt"),
    bootText: fixture("proc-boot-id.txt"),
    energyMicrojoules: 1_000_000_000,
    dockerRoot: "/var/lib/docker",
  };
}

function advanceState(state: FixtureState): void {
  state.statText = fixture("proc-stat-full-fields-2.txt");
  state.diskText = DISKSTATS_2;
  state.netText = NET_DEV_2;
  state.energyMicrojoules = 1_600_000_000;
}

it("first sample carries every gauge but null rates and percentages", async () => {
  const state = defaultState();
  const collector = new LinuxMetricsCollector(createDeps(state), {
    nominalIntervalSeconds: 60,
  });

  const result = await collector.collect({ sequence: 1, nowMs: 1_000_000 });
  assertEquals(result.supported, true);
  if (!result.supported) return;

  const { metrics, dimensions } = result.sample;
  // Rates and percentages: null on first sample, never 0.
  assertEquals(metrics.cpuUserPercent, null);
  assertEquals(metrics.cpuIdlePercent, null);
  assertEquals(metrics.cpuStealPercent, null);
  assertEquals(metrics.diskReadBytesPerSecond, null);
  assertEquals(metrics.diskReadLatencyMs, null);
  assertEquals(metrics.uplinkReceiveBytesPerSecond, null);
  assertEquals(metrics.fabricReceiveBytesPerSecond, null);
  assertEquals(metrics.cpuPowerWatts, null);

  // Gauges report immediately.
  assertEquals(metrics.load1, 1.25);
  assertEquals(metrics.load5, 0.75);
  assertEquals(metrics.load15, 0.5);
  assertEquals(metrics.memoryTotalBytes, 8000000 * 1024);
  assertEquals(metrics.memoryAvailableBytes, 4000000 * 1024);
  assertEquals(metrics.memoryFreeBytes, 2000000 * 1024);
  assertEquals(metrics.swapTotalBytes, 2000000 * 1024);
  assertEquals(metrics.swapFreeBytes, 1000000 * 1024);
  assertEquals(
    metrics.systemStorageTotalBytes,
    expectedStorage("/").totalBytes,
  );
  assertEquals(
    metrics.systemStorageAvailableBytes,
    expectedStorage("/").availableBytes,
  );
  assertEquals(
    metrics.hostingStorageTotalBytes,
    expectedStorage("/srv/users").totalBytes,
  );
  assertEquals(
    metrics.hostingStorageAvailableBytes,
    expectedStorage("/srv/users").availableBytes,
  );
  assertEquals(
    metrics.dockerStorageTotalBytes,
    expectedStorage("/var/lib/docker").totalBytes,
  );
  assertEquals(
    metrics.dockerStorageAvailableBytes,
    expectedStorage("/var/lib/docker").availableBytes,
  );
  assertEquals(metrics.cpuTemperatureCelsius, 45);
  assertEquals(metrics.gpuTemperatureCelsius, 61);
  assertEquals(metrics.gpuPowerWatts, 37);
  assertEquals(metrics.processCount, 42);
  assertEquals(metrics.uptimeSeconds, 12345);

  assertEquals(dimensions.collectionMode, "baseline");
  assertEquals(dimensions.schemaVersion, METRICS_SCHEMA_VERSION);
  assertEquals(dimensions.cpuTemperatureSensor, "coretemp:Package id 0");
  assertEquals(dimensions.gpuTemperatureSensor, "amdgpu:edge");
  assertEquals(dimensions.cpuPowerSensor, "intel-rapl:package-0");
  assertEquals(dimensions.gpuPowerSensor, "amdgpu:PPT");
  assertEquals(dimensions.uplinkInterfaces, ["eth0"]);
  assertEquals(dimensions.fabricInterfaces, ["tp0"]);
  assertEquals(result.sample.intervalSeconds, 60);
  assertEquals(result.sample.sequence, 1);
});

it("second sample computes CPU, disk, network, and power deltas", async () => {
  const state = defaultState();
  const deps = createDeps(state);
  const collector = new LinuxMetricsCollector(deps, {
    nominalIntervalSeconds: 60,
  });

  await collector.collect({ sequence: 1, nowMs: 1_000_000 });
  advanceState(state);
  const result = await collector.collect({ sequence: 2, nowMs: 1_060_000 });
  assertEquals(result.supported, true);
  if (!result.supported) return;

  const { metrics } = result.sample;
  // CPU deltas from proc-stat-full-fields-1/2: total 8800.
  assertEquals(metrics.cpuUserPercent, (900 / 8800) * 100);
  assertEquals(metrics.cpuNicePercent, (50 / 8800) * 100);
  assertEquals(metrics.cpuSystemPercent, (300 / 8800) * 100);
  assertEquals(metrics.cpuIdlePercent, (7200 / 8800) * 100);
  assertEquals(metrics.cpuIowaitPercent, (180 / 8800) * 100);
  assertEquals(metrics.cpuIrqPercent, (50 / 8800) * 100);
  assertEquals(metrics.cpuSoftirqPercent, (80 / 8800) * 100);
  assertEquals(metrics.cpuStealPercent, (40 / 8800) * 100);

  // Disk deltas over 60 s: Δreads 600, Δsectors 30000 each way, Δticks 300.
  assertEquals(metrics.diskReadBytesPerSecond, (30000 * 512) / 60);
  assertEquals(metrics.diskWriteBytesPerSecond, (30000 * 512) / 60);
  assertEquals(metrics.diskReadOpsPerSecond, 10);
  assertEquals(metrics.diskWriteOpsPerSecond, 5);
  assertEquals(metrics.diskReadLatencyMs, 300 / 600);
  assertEquals(metrics.diskWriteLatencyMs, 300 / 300);

  // Uplink (eth0) and fabric (tp0) aggregate independently.
  assertEquals(metrics.uplinkReceiveBytesPerSecond, 600_000 / 60);
  assertEquals(metrics.uplinkTransmitBytesPerSecond, 300_000 / 60);
  assertEquals(metrics.fabricReceiveBytesPerSecond, 60_000 / 60);
  assertEquals(metrics.fabricTransmitBytesPerSecond, 30_000 / 60);

  // RAPL energy delta: 600 J over 60 s.
  assertEquals(metrics.cpuPowerWatts, 10);
  assertEquals(result.sample.intervalSeconds, 60);
});

it("boot_id change nulls rate, CPU, and power metrics for the interval", async () => {
  const state = defaultState();
  const collector = new LinuxMetricsCollector(createDeps(state));

  await collector.collect({ sequence: 1, nowMs: 1_000_000 });
  advanceState(state);
  state.bootText = fixture("proc-boot-id-2.txt");
  const result = await collector.collect({ sequence: 2, nowMs: 1_060_000 });
  assertEquals(result.supported, true);
  if (!result.supported) return;

  const { metrics } = result.sample;
  assertEquals(metrics.cpuIdlePercent, null);
  assertEquals(metrics.diskReadBytesPerSecond, null);
  assertEquals(metrics.diskReadLatencyMs, null);
  assertEquals(metrics.uplinkReceiveBytesPerSecond, null);
  assertEquals(metrics.fabricReceiveBytesPerSecond, null);
  assertEquals(metrics.cpuPowerWatts, null);
  // Gauges survive the reset.
  assertEquals(metrics.load1, 1.25);
  assertEquals(metrics.cpuTemperatureCelsius, 45);
});

it("disk device membership churn nulls only the disk rates", async () => {
  const state = defaultState();
  const collector = new LinuxMetricsCollector(createDeps(state));

  await collector.collect({ sequence: 1, nowMs: 1_000_000 });
  advanceState(state);
  state.diskText = DISKSTATS_2_SDB_APPEARS;
  const result = await collector.collect({ sequence: 2, nowMs: 1_060_000 });
  assertEquals(result.supported, true);
  if (!result.supported) return;
  assertEquals(result.sample.metrics.diskReadBytesPerSecond, null);
  assertEquals(result.sample.metrics.diskWriteOpsPerSecond, null);
  assertEquals(result.sample.metrics.diskReadLatencyMs, null);
  assertEquals(
    result.sample.metrics.uplinkReceiveBytesPerSecond,
    600_000 / 60,
  );
});

it("mount-backed disk preference survives unrelated-disk churn", async () => {
  // With a mount table resolving every probed path to sda, an unrelated sdb
  // appearing mid-interval neither pollutes the totals nor nulls the rates.
  const state = defaultState();
  state.mountsText = [
    "/dev/sda1 / ext4 rw,relatime 0 0",
    "/dev/sda1 /srv/users ext4 rw,relatime 0 0",
    "/dev/sda1 /var/lib/docker ext4 rw,relatime 0 0",
  ].join("\n");
  const collector = new LinuxMetricsCollector(createDeps(state), {
    nominalIntervalSeconds: 60,
  });

  await collector.collect({ sequence: 1, nowMs: 1_000_000 });
  advanceState(state);
  state.diskText = DISKSTATS_2_SDB_APPEARS;
  const result = await collector.collect({ sequence: 2, nowMs: 1_060_000 });
  assertEquals(result.supported, true);
  if (!result.supported) return;
  // sda-only aggregation: same deltas as the churn-free case.
  assertEquals(
    result.sample.metrics.diskReadBytesPerSecond,
    (30000 * 512) / 60,
  );
  assertEquals(result.sample.metrics.diskReadOpsPerSecond, 10);
  assertEquals(result.sample.metrics.diskReadLatencyMs, 300 / 600);
});

it("veth churn nulls neither uplink nor fabric rates", async () => {
  const state = defaultState();
  const collector = new LinuxMetricsCollector(createDeps(state));

  await collector.collect({ sequence: 1, nowMs: 1_000_000 });
  advanceState(state);
  state.netText = NET_DEV_2_NO_VETH;
  const result = await collector.collect({ sequence: 2, nowMs: 1_060_000 });
  assertEquals(result.supported, true);
  if (!result.supported) return;
  assertEquals(
    result.sample.metrics.uplinkReceiveBytesPerSecond,
    600_000 / 60,
  );
  assertEquals(
    result.sample.metrics.fabricTransmitBytesPerSecond,
    30_000 / 60,
  );
});

it("Docker on a dedicated mount probes that mount's filesystem", async () => {
  const state = defaultState();
  state.dockerRoot = "/mnt/docker-data";
  const collector = new LinuxMetricsCollector(createDeps(state));
  const result = await collector.collect({ sequence: 1, nowMs: 1_000_000 });
  assertEquals(result.supported, true);
  if (!result.supported) return;
  assertEquals(
    result.sample.metrics.dockerStorageTotalBytes,
    expectedStorage("/mnt/docker-data").totalBytes,
  );
  assertEquals(
    result.sample.metrics.dockerStorageAvailableBytes,
    expectedStorage("/mnt/docker-data").availableBytes,
  );
});

it("Docker absence nulls the docker storage fields only", async () => {
  const state = defaultState();
  state.dockerRoot = null;
  const collector = new LinuxMetricsCollector(createDeps(state));
  const result = await collector.collect({ sequence: 1, nowMs: 1_000_000 });
  assertEquals(result.supported, true);
  if (!result.supported) return;
  assertEquals(result.sample.metrics.dockerStorageTotalBytes, null);
  assertEquals(result.sample.metrics.dockerStorageAvailableBytes, null);
  assertEquals(
    result.sample.metrics.systemStorageTotalBytes,
    expectedStorage("/").totalBytes,
  );
});

it("swap-absent hosts report null swap bytes, never 0", async () => {
  const state = defaultState();
  state.memText = fixture("proc-meminfo-no-swap.txt");
  const collector = new LinuxMetricsCollector(createDeps(state));
  const result = await collector.collect({ sequence: 1, nowMs: 1_000_000 });
  assertEquals(result.supported, true);
  if (!result.supported) return;
  assertEquals(result.sample.metrics.swapTotalBytes, null);
  assertEquals(result.sample.metrics.swapFreeBytes, null);
  assertEquals(result.sample.metrics.memoryTotalBytes, 8000000 * 1024);
});

it("collect passes an explicit live collectionMode into dimensions", async () => {
  const state = defaultState();
  const collector = new LinuxMetricsCollector(createDeps(state));
  const result = await collector.collect({
    sequence: 1,
    nowMs: 1_000_000,
    collectionMode: "live",
  });
  assertEquals(result.supported, true);
  if (!result.supported) return;
  assertEquals(result.sample.dimensions.collectionMode, "live");
});

it("tolerates throwing statfs, sensors, and fabric resolution", async () => {
  const state = defaultState();
  const collector = new LinuxMetricsCollector(createDeps(state, {
    statfs: () => {
      throw new Error("statfs unavailable");
    },
    readSensors: () => Promise.reject(new Error("sysfs boom")),
    resolveFabricInterfaces: () => Promise.reject(new Error("fabric boom")),
  }));
  const result = await collector.collect({ sequence: 1, nowMs: 1_000_000 });
  assertEquals(result.supported, true);
  if (!result.supported) return;
  const { metrics, dimensions } = result.sample;
  assertEquals(metrics.systemStorageTotalBytes, null);
  assertEquals(metrics.cpuTemperatureCelsius, null);
  assertEquals(metrics.gpuPowerWatts, null);
  assertEquals(dimensions.cpuTemperatureSensor, undefined);
  assertEquals(dimensions.fabricInterfaces, undefined);
  // With no fabric registration tp0 falls back to uplink classification.
  assertEquals(dimensions.uplinkInterfaces, ["eth0", "tp0"]);
  assertEquals(metrics.load1, 1.25);
});

it("nulls processCount when countProcesses throws", async () => {
  const state = defaultState();
  const collector = new LinuxMetricsCollector(createDeps(state, {
    countProcesses: () => {
      throw new Error("ps unavailable");
    },
  }));
  const result = await collector.collect({ sequence: 1, nowMs: 1_000_000 });
  assertEquals(result.supported, true);
  if (!result.supported) return;
  assertEquals(result.sample.metrics.processCount, null);
});

it("falls back with current-schema dimensions when construction throws", async () => {
  const state = defaultState();
  const collector = new LinuxMetricsCollector(createDeps(state, {
    resolveDimensions: () => {
      throw new Error("dimensions boom");
    },
  }));
  const result = await collector.collect({ sequence: 7, nowMs: 1_000_000 });
  assertEquals(result.supported, true);
  if (!result.supported) return;
  assertEquals(result.sample.sequence, 7);
  assertEquals(result.sample.dimensions.daemonVersion, "unknown");
  assertEquals(
    result.sample.dimensions.schemaVersion,
    METRICS_SCHEMA_VERSION,
  );
  assertEquals(result.sample.dimensions.collectionMode, "baseline");
});

it("uses deps.now when nowMs is omitted", async () => {
  const state = defaultState();
  const collector = new LinuxMetricsCollector(createDeps(state, {
    now: () => 5_000_000,
  }));
  const result = await collector.collect({ sequence: 1 });
  assertEquals(result.supported, true);
  if (!result.supported) return;
  assertEquals(result.sample.at, new Date(5_000_000).toISOString());
});

it("uses elapsed seconds between samples", async () => {
  const state = defaultState();
  const collector = new LinuxMetricsCollector(createDeps(state), {
    nominalIntervalSeconds: 60,
  });
  await collector.collect({ sequence: 1, nowMs: 1_000_000 });
  const result = await collector.collect({ sequence: 2, nowMs: 1_030_000 });
  assertEquals(result.supported, true);
  if (!result.supported) return;
  assertEquals(result.sample.intervalSeconds, 30);
});

it("keeps nominal interval when elapsed is non-positive", async () => {
  const state = defaultState();
  const collector = new LinuxMetricsCollector(createDeps(state), {
    nominalIntervalSeconds: 60,
  });
  await collector.collect({ sequence: 1, nowMs: 2_000_000 });
  const result = await collector.collect({ sequence: 2, nowMs: 1_999_000 });
  assertEquals(result.supported, true);
  if (!result.supported) return;
  assertEquals(result.sample.intervalSeconds, 60);
});
