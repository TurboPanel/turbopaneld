import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import { fromFileUrl } from "@std/path";
import { LinuxMetricsCollector } from "./linux-collector.ts";
import type {
  CaddyCounters,
  CollectorDeps,
  ProxyCounters,
  ProxySqlCounters,
  SensorReadings,
  StatfsResult,
} from "./types.ts";
import { METRICS_SCHEMA_VERSION } from "../contract.ts";
import { readHostSensors } from "./sensors/index.ts";
import {
  resolveAdminSensorOverrides,
  writeHardwareProfile,
} from "./sensors/overrides.ts";

function fixture(name: string): string {
  return Deno.readTextFileSync(
    new URL(`./testdata/${name}`, import.meta.url),
  );
}

function sensorsFixtureRoot(name: string): string {
  return fromFileUrl(new URL(`./testdata/${name}`, import.meta.url));
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
    gpuUtilizationPercent: null,
    gpuFanRpm: null,
    disk1TemperatureCelsius: null,
    disk2TemperatureCelsius: null,
    ambient1TemperatureCelsius: null,
    ambient2TemperatureCelsius: null,
    boardTemperatureCelsius: null,
    cpuFanRpm: null,
    systemFan1Rpm: null,
    systemFan2Rpm: null,
    cpuEnergy: { energyMicrojoules, maxEnergyRangeMicrojoules: null },
    sensors: {
      cpuTemperatureSensor: "coretemp:Package id 0",
      gpuTemperatureSensor: "amdgpu:edge",
      cpuPowerSensor: "intel-rapl:package-0",
      gpuPowerSensor: "amdgpu:PPT",
    },
  };
}

/** A full sensor-assignment sample — every slot resolves to a reading. */
function fullSensorReadings(): SensorReadings {
  return {
    cpuTemperatureCelsius: 45,
    gpuTemperatureCelsius: 61,
    gpuPowerWatts: 37,
    gpuUtilizationPercent: 42,
    gpuFanRpm: 1800,
    disk1TemperatureCelsius: 36.85,
    disk2TemperatureCelsius: 33,
    ambient1TemperatureCelsius: 32,
    ambient2TemperatureCelsius: 45,
    boardTemperatureCelsius: 32,
    cpuFanRpm: 1200,
    systemFan1Rpm: 800,
    systemFan2Rpm: 750,
    cpuEnergy: {
      energyMicrojoules: 1_000_000_000,
      maxEnergyRangeMicrojoules: null,
    },
    sensors: {
      cpuTemperatureSensor: "coretemp:Package id 0",
      gpuTemperatureSensor: "amdgpu:edge",
      cpuPowerSensor: "intel-rapl:package-0",
      gpuPowerSensor: "amdgpu:PPT",
      gpuUtilizationSensor: "amdgpu:gpu_busy_percent",
      gpuFanSensor: "amdgpu:fan1",
      disk1TemperatureSensor: "nvme0n1:Composite",
      disk2TemperatureSensor: "nvme0n1:Sensor 1",
      ambient1TemperatureSensor: "nct6775:SYSTIN",
      ambient2TemperatureSensor: "nct6775:AUXTIN",
      boardTemperatureSensor: "nct6775:SYSTIN",
      cpuFanSensor: "coretemp:cpu_fan",
      systemFan1Sensor: "nct6775:sys_fan1",
      systemFan2Sensor: "nct6775:sys_fan2",
    },
  };
}

/** VM-shaped sensor readings — every field null, no candidates at all. */
function noSensorReadings(): SensorReadings {
  return {
    cpuTemperatureCelsius: null,
    gpuTemperatureCelsius: null,
    gpuPowerWatts: null,
    gpuUtilizationPercent: null,
    gpuFanRpm: null,
    disk1TemperatureCelsius: null,
    disk2TemperatureCelsius: null,
    ambient1TemperatureCelsius: null,
    ambient2TemperatureCelsius: null,
    boardTemperatureCelsius: null,
    cpuFanRpm: null,
    systemFan1Rpm: null,
    systemFan2Rpm: null,
    cpuEnergy: null,
    sensors: {},
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
    }),
    resolveDockerDataRoot: () => Promise.resolve(state.dockerRoot),
    resolveHostingPath: () => "/srv/users",
    readSensors: () => Promise.resolve(sensorReadings(state.energyMicrojoules)),
    resolveFabricInterfaces: () => Promise.resolve(["tp0"]),
    resolveAdminSensorOverrides: () => Promise.resolve({}),
    resolveHardwareProfileGeneration: () => 0,
    resolveNicSlots: () => Promise.resolve({ nic1: null, nic2: null }),
    readProxyCounters: () => Promise.resolve({ caddy: null, proxysql: null }),
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
  assertEquals(metrics.interfaceReceiveBytesPerSecond, null);
  assertEquals(metrics.fabricReceiveBytesPerSecond, null);
  assertEquals(metrics.cpuPowerWatts, null);

  // Gauges report immediately.
  assertEquals(metrics.load1, 1.25);
  assertEquals(metrics.load5, 0.75);
  assertEquals(metrics.load15, 0.5);
  assertEquals(metrics.memoryTotalBytes, 8000000 * 1024);
  assertEquals(metrics.memoryAvailableBytes, 4000000 * 1024);
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
  assertEquals(dimensions.hardwareProfileGeneration, 0);
  assertEquals(result.sample.intervalSeconds, 60);
  assertEquals(result.sample.sequence, 1);
  // sensorReadings() resolves a non-null cpuTemperatureCelsius, and that
  // field now lives in the sensors part itself, so "sensors" is declared
  // even though cpuPowerWatts (a delta) is still null on this first sample.
  assertEquals(result.sample.parts, ["core", "extended", "sensors"]);
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
  assertEquals(metrics.interfaceReceiveBytesPerSecond, 600_000 / 60);
  assertEquals(metrics.interfaceTransmitBytesPerSecond, 300_000 / 60);
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
  assertEquals(metrics.interfaceReceiveBytesPerSecond, null);
  assertEquals(metrics.fabricReceiveBytesPerSecond, null);
  assertEquals(metrics.cpuPowerWatts, null);
  // Gauges survive the reset.
  assertEquals(metrics.load1, 1.25);
  assertEquals(metrics.cpuTemperatureCelsius, 45);
});

it("fan RPM and GPU utilization gauges are unaffected by boot-id resets", async () => {
  const state = defaultState();
  const collector = new LinuxMetricsCollector(createDeps(state, {
    readSensors: () => Promise.resolve(fullSensorReadings()),
  }));

  await collector.collect({ sequence: 1, nowMs: 1_000_000 });
  advanceState(state);
  state.bootText = fixture("proc-boot-id-2.txt");
  const result = await collector.collect({ sequence: 2, nowMs: 1_060_000 });
  assertEquals(result.supported, true);
  if (!result.supported) return;

  const { metrics } = result.sample;
  // Unlike cpuPowerWatts (a delta), these are point-in-time gauges — the
  // boot-id reset guard never applies to them.
  assertEquals(metrics.gpuUtilizationPercent, 42);
  assertEquals(metrics.gpuFanRpm, 1800);
  assertEquals(metrics.cpuFanRpm, 1200);
  assertEquals(metrics.systemFan1Rpm, 800);
  assertEquals(metrics.systemFan2Rpm, 750);
  assertEquals(metrics.disk1TemperatureCelsius, 36.85);
  assertEquals(metrics.ambient1TemperatureCelsius, 32);
  assertEquals(metrics.boardTemperatureCelsius, 32);
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
    result.sample.metrics.interfaceReceiveBytesPerSecond,
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
    result.sample.metrics.interfaceReceiveBytesPerSecond,
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
  const { metrics } = result.sample;
  assertEquals(metrics.systemStorageTotalBytes, null);
  // readSensors threw, so no sensors-part field resolved: "sensors" is
  // absent and cpuTemperatureCelsius (now a sensors-part key) is omitted
  // entirely rather than reported as a validated null.
  assertEquals(metrics.cpuTemperatureCelsius, undefined);
  assertEquals(metrics.gpuPowerWatts, null);
  assertEquals(metrics.load1, 1.25);
  assertEquals(result.sample.parts, ["core", "extended"]);
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
  assertEquals(
    result.sample.dimensions.schemaVersion,
    METRICS_SCHEMA_VERSION,
  );
  assertEquals(result.sample.dimensions.collectionMode, "baseline");
  assertEquals(result.sample.dimensions.hardwareProfileGeneration, 0);
  assertEquals(result.sample.parts, ["core", "extended"]);
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

it("a VM sample with no sensor readings omits the sensors part entirely", async () => {
  const state = defaultState();
  const collector = new LinuxMetricsCollector(createDeps(state, {
    readSensors: () => Promise.resolve(noSensorReadings()),
  }));
  const result = await collector.collect({ sequence: 1, nowMs: 1_000_000 });
  assertEquals(result.supported, true);
  if (!result.supported) return;
  assertEquals(result.sample.parts, ["core", "extended"]);
  assertEquals(result.sample.metrics.gpuUtilizationPercent, undefined);
  assertEquals(result.sample.metrics.cpuFanRpm, undefined);
  // No NIC slot is assigned (createDeps defaults resolveNicSlots to both
  // null) — the unassigned pair alone must not force "sensors" into parts,
  // so these sensors-part keys are omitted entirely (undefined), just like
  // every other sensors-part field on this VM-shaped sample.
  assertEquals(result.sample.metrics.nic1ReceiveBytesPerSecond, undefined);
  assertEquals(result.sample.metrics.nic1TransmitBytesPerSecond, undefined);
  assertEquals(result.sample.metrics.nic2ReceiveBytesPerSecond, undefined);
  assertEquals(result.sample.metrics.nic2TransmitBytesPerSecond, undefined);
});

it("an assigned NIC slot naming a nonexistent interface stays null and omits the sensors part", async () => {
  const state = defaultState();
  const collector = new LinuxMetricsCollector(createDeps(state, {
    readSensors: () => Promise.resolve(noSensorReadings()),
    resolveNicSlots: () => Promise.resolve({ nic1: "eth99", nic2: null }),
  }));
  await collector.collect({ sequence: 1, nowMs: 1_000_000 });
  advanceState(state);
  const result = await collector.collect({ sequence: 2, nowMs: 1_060_000 });
  assertEquals(result.supported, true);
  if (!result.supported) return;
  assertEquals(result.sample.parts, ["core", "extended"]);
  assertEquals(result.sample.metrics.nic1ReceiveBytesPerSecond, undefined);
  assertEquals(result.sample.metrics.nic1TransmitBytesPerSecond, undefined);
});

it("an assigned NIC slot with a resolvable rate declares the sensors part on its own", async () => {
  const state = defaultState();
  const collector = new LinuxMetricsCollector(createDeps(state, {
    readSensors: () => Promise.resolve(noSensorReadings()),
    resolveNicSlots: () => Promise.resolve({ nic1: "eth0", nic2: null }),
  }));
  await collector.collect({ sequence: 1, nowMs: 1_000_000 });
  advanceState(state);
  const result = await collector.collect({ sequence: 2, nowMs: 1_060_000 });
  assertEquals(result.supported, true);
  if (!result.supported) return;
  assertEquals(result.sample.parts, ["core", "extended", "sensors"]);
  assertEquals(
    result.sample.metrics.nic1ReceiveBytesPerSecond,
    600_000 / 60,
  );
  assertEquals(
    result.sample.metrics.nic1TransmitBytesPerSecond,
    300_000 / 60,
  );
  assertEquals(result.sample.metrics.nic2ReceiveBytesPerSecond, null);
  assertEquals(result.sample.metrics.nic2TransmitBytesPerSecond, null);
});

it("both NIC slots assigned compute independent rates alongside class aggregation", async () => {
  const state = defaultState();
  const collector = new LinuxMetricsCollector(createDeps(state, {
    resolveNicSlots: () => Promise.resolve({ nic1: "eth0", nic2: "tp0" }),
  }));
  await collector.collect({ sequence: 1, nowMs: 1_000_000 });
  advanceState(state);
  const result = await collector.collect({ sequence: 2, nowMs: 1_060_000 });
  assertEquals(result.supported, true);
  if (!result.supported) return;
  const { metrics } = result.sample;
  assertEquals(metrics.nic1ReceiveBytesPerSecond, 600_000 / 60);
  assertEquals(metrics.nic1TransmitBytesPerSecond, 300_000 / 60);
  assertEquals(metrics.nic2ReceiveBytesPerSecond, 60_000 / 60);
  assertEquals(metrics.nic2TransmitBytesPerSecond, 30_000 / 60);
  // Matches the independently-computed uplink/fabric class aggregates —
  // eth0/tp0 are each the sole member of their class in this fixture.
  assertEquals(
    metrics.nic1ReceiveBytesPerSecond,
    metrics.interfaceReceiveBytesPerSecond,
  );
  assertEquals(
    metrics.nic2ReceiveBytesPerSecond,
    metrics.fabricReceiveBytesPerSecond,
  );
});

it("a NIC slot reassigned between ticks nulls that slot instead of mixing interface identities", async () => {
  // eth0 and tp0 are both present in NET_DEV_1 and NET_DEV_2 (only their
  // counters change). If nic1 is "eth0" on the first tick and "tp0" on the
  // second, the naive fix of always resolving `namedInterfaceRates` against
  // the *current* tick's name would find tp0 present in both snapshots and
  // emit a real (but mislabeled) rate — attributing part of the interval to
  // an interface that wasn't actually assigned to nic1 for that whole span.
  // The slot must null instead.
  const state = defaultState();
  let nic1Name = "eth0";
  const collector = new LinuxMetricsCollector(createDeps(state, {
    resolveNicSlots: () => Promise.resolve({ nic1: nic1Name, nic2: null }),
  }));
  await collector.collect({ sequence: 1, nowMs: 1_000_000 });
  advanceState(state);
  nic1Name = "tp0";
  const result = await collector.collect({ sequence: 2, nowMs: 1_060_000 });
  assertEquals(result.supported, true);
  if (!result.supported) return;
  assertEquals(result.sample.metrics.nic1ReceiveBytesPerSecond, null);
  assertEquals(result.sample.metrics.nic1TransmitBytesPerSecond, null);
});

it("a bare-metal sample with only CPU temperature and CPU power assigned still declares the sensors part", async () => {
  const state = defaultState();
  // sensorReadings() carries only CPU temperature/power (now sensors-part
  // fields themselves) — every other sensors-part field stays null. A
  // CPU-only host must not be misreported as having no hardware sensors.
  // cpuPowerWatts is a delta, so a second sample is needed for it to resolve
  // non-null alongside the always-gauge cpuTemperatureCelsius.
  const collector = new LinuxMetricsCollector(createDeps(state));
  await collector.collect({ sequence: 1, nowMs: 1_000_000 });
  advanceState(state);
  const result = await collector.collect({ sequence: 2, nowMs: 1_060_000 });
  assertEquals(result.supported, true);
  if (!result.supported) return;
  assertEquals(result.sample.metrics.cpuTemperatureCelsius, 45);
  assertEquals(result.sample.metrics.cpuPowerWatts, 10);
  assertEquals(result.sample.parts, ["core", "extended", "sensors"]);
  assertEquals(result.sample.metrics.gpuUtilizationPercent, null);
  assertEquals(result.sample.metrics.disk1TemperatureCelsius, null);
  assertEquals(result.sample.metrics.cpuFanRpm, null);
});

it("a fully-assigned sample declares every sensors-part slot", async () => {
  const state = defaultState();
  const collector = new LinuxMetricsCollector(createDeps(state, {
    readSensors: () => Promise.resolve(fullSensorReadings()),
  }));
  const result = await collector.collect({ sequence: 1, nowMs: 1_000_000 });
  assertEquals(result.supported, true);
  if (!result.supported) return;
  const { metrics } = result.sample;
  assertEquals(result.sample.parts, ["core", "extended", "sensors"]);
  assertEquals(metrics.gpuUtilizationPercent, 42);
  assertEquals(metrics.gpuFanRpm, 1800);
  assertEquals(metrics.disk1TemperatureCelsius, 36.85);
  assertEquals(metrics.disk2TemperatureCelsius, 33);
  assertEquals(metrics.ambient1TemperatureCelsius, 32);
  assertEquals(metrics.ambient2TemperatureCelsius, 45);
  assertEquals(metrics.boardTemperatureCelsius, 32);
  assertEquals(metrics.cpuFanRpm, 1200);
  assertEquals(metrics.systemFan1Rpm, 800);
  assertEquals(metrics.systemFan2Rpm, 750);
});

it("a real hardware-profile GPU assignment reads back through the full collector pipeline", async () => {
  // Regression coverage for the resolveAdminSensorOverrides() → readHostSensors
  // round trip inside the actual collector (not a canned SensorReadings
  // stub): a gpuDevice slot's chip:label identity must resolve temperature,
  // power, and utilization together, not just whichever pool the identity
  // happens to literally name.
  const state = defaultState();
  const stateDir = await Deno.makeTempDir();
  try {
    await writeHardwareProfile({
      gpuDevice: { chip: "amdgpu", label: "edge" },
    }, stateDir);
    const overrides = await resolveAdminSensorOverrides(stateDir);
    const root = sensorsFixtureRoot("sensors-gpu-utilization");

    const collector = new LinuxMetricsCollector(createDeps(state, {
      resolveAdminSensorOverrides: () => Promise.resolve(overrides),
      readSensors: (o) => readHostSensors(o ?? {}, { root }),
    }));
    const result = await collector.collect({ sequence: 1, nowMs: 1_000_000 });
    assertEquals(result.supported, true);
    if (!result.supported) return;

    const { metrics } = result.sample;
    assertEquals(metrics.gpuTemperatureCelsius, 61);
    assertEquals(metrics.gpuPowerWatts, 37);
    assertEquals(metrics.gpuUtilizationPercent, 42);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

it("stamps dimensions.hardwareProfileGeneration from the resolved hardware profile", async () => {
  const state = defaultState();
  const collector = new LinuxMetricsCollector(createDeps(state, {
    resolveHardwareProfileGeneration: () => 3,
  }));
  const result = await collector.collect({ sequence: 1, nowMs: 1_000_000 });
  assertEquals(result.supported, true);
  if (!result.supported) return;
  assertEquals(result.sample.dimensions.hardwareProfileGeneration, 3);
});

it("defaults hardwareProfileGeneration to 0 when resolution throws", async () => {
  const state = defaultState();
  const collector = new LinuxMetricsCollector(createDeps(state, {
    resolveHardwareProfileGeneration: () => {
      throw new Error("profile read boom");
    },
  }));
  const result = await collector.collect({ sequence: 1, nowMs: 1_000_000 });
  assertEquals(result.supported, true);
  if (!result.supported) return;
  assertEquals(result.sample.dimensions.hardwareProfileGeneration, 0);
});

function caddyCounters(overrides?: Partial<CaddyCounters>): CaddyCounters {
  return {
    requestsTotal: 100,
    responses2xxTotal: 90,
    responses3xxTotal: 5,
    responses4xxTotal: 4,
    responses5xxTotal: 1,
    requestBytesTotal: 10_000,
    responseBytesTotal: 50_000,
    requestDurationSecondsSum: 12,
    requestsUnder100msTotal: 80,
    requestsUnder1sTotal: 98,
    requestsInFlight: 3,
    ...overrides,
  };
}

function proxySqlCounters(
  overrides?: Partial<ProxySqlCounters>,
): ProxySqlCounters {
  return {
    queriesTotal: 5_000,
    slowQueriesTotal: 2,
    connectionErrorsTotal: 0,
    clientConnections: 6,
    backendConnections: 3,
    backendsUp: 2,
    ...overrides,
  };
}

function proxyReader(
  counters: ProxyCounters,
): () => Promise<ProxyCounters> {
  return () => Promise.resolve(counters);
}

it('omits "traffic" from parts when neither Caddy nor ProxySQL is reachable', async () => {
  const state = defaultState();
  const collector = new LinuxMetricsCollector(createDeps(state));
  const result = await collector.collect({ sequence: 1, nowMs: 1_000_000 });
  assertEquals(result.supported, true);
  if (!result.supported) return;

  assertEquals(result.sample.parts, ["core", "extended", "sensors"]);
  assertEquals(result.sample.metrics.caddyRequestsTotal, undefined);
  assertEquals(result.sample.metrics.proxysqlQueriesTotal, undefined);
  // Neither source contributed — distinct from a per-metric null, which a
  // partially-reachable tick would also produce.
  assertEquals(result.sample.dimensions.trafficSources, {
    caddy: false,
    proxysql: false,
  });
});

it('declares "traffic" and nulls every counter delta on the first sample after attach, while gauges resolve', async () => {
  const state = defaultState();
  const collector = new LinuxMetricsCollector(createDeps(state, {
    readProxyCounters: proxyReader({
      caddy: caddyCounters(),
      proxysql: proxySqlCounters(),
    }),
  }));
  const result = await collector.collect({ sequence: 1, nowMs: 1_000_000 });
  assertEquals(result.supported, true);
  if (!result.supported) return;

  const { metrics } = result.sample;
  assertEquals(result.sample.parts, ["core", "extended", "sensors", "traffic"]);
  assertEquals(metrics.caddyRequestsTotal, null);
  assertEquals(metrics.caddyResponses2xxTotal, null);
  assertEquals(metrics.caddyRequestDurationSecondsSum, null);
  assertEquals(metrics.proxysqlQueriesTotal, null);
  assertEquals(metrics.proxysqlSlowQueriesTotal, null);
  // Gauges resolve even on the first tick — no previous sample needed.
  assertEquals(metrics.caddyRequestsInFlight, 3);
  assertEquals(metrics.proxysqlClientConnections, 6);
  assertEquals(metrics.proxysqlBackendConnections, 3);
  assertEquals(metrics.proxysqlBackendsUp, 2);
  assertEquals(result.sample.dimensions.trafficSources, {
    caddy: true,
    proxysql: true,
  });
});

it('declares "traffic" when only ProxySQL is reachable, leaving Caddy fields null', async () => {
  const state = defaultState();
  const collector = new LinuxMetricsCollector(createDeps(state, {
    readProxyCounters: proxyReader({
      caddy: null,
      proxysql: proxySqlCounters(),
    }),
  }));
  const result = await collector.collect({ sequence: 1, nowMs: 1_000_000 });
  assertEquals(result.supported, true);
  if (!result.supported) return;

  const { metrics } = result.sample;
  assertEquals(result.sample.parts, ["core", "extended", "sensors", "traffic"]);
  assertEquals(metrics.caddyRequestsTotal, null);
  assertEquals(metrics.caddyRequestsInFlight, null);
  assertEquals(metrics.proxysqlClientConnections, 6);
  // ProxySQL not installed vs. down both null every proxysql field the same
  // way — this marker is what actually distinguishes "reachable this tick"
  // (Caddy here) from "not contributing" (ProxySQL, whichever the reason).
  assertEquals(result.sample.dimensions.trafficSources, {
    caddy: false,
    proxysql: true,
  });
});

it('declares "traffic" when only Caddy is reachable, leaving ProxySQL fields null', async () => {
  const state = defaultState();
  const collector = new LinuxMetricsCollector(createDeps(state, {
    readProxyCounters: proxyReader({
      caddy: caddyCounters(),
      proxysql: null,
    }),
  }));
  const result = await collector.collect({ sequence: 1, nowMs: 1_000_000 });
  assertEquals(result.supported, true);
  if (!result.supported) return;

  const { metrics } = result.sample;
  assertEquals(result.sample.parts, ["core", "extended", "sensors", "traffic"]);
  assertEquals(metrics.proxysqlQueriesTotal, null);
  assertEquals(metrics.proxysqlClientConnections, null);
  assertEquals(metrics.caddyRequestsInFlight, 3);
  assertEquals(result.sample.dimensions.trafficSources, {
    caddy: true,
    proxysql: false,
  });
});

it("computes Caddy/ProxySQL counter deltas on the second sample", async () => {
  const state = defaultState();
  let caddy = caddyCounters();
  let proxysql = proxySqlCounters();
  const collector = new LinuxMetricsCollector(createDeps(state, {
    readProxyCounters: () => Promise.resolve({ caddy, proxysql }),
  }));

  await collector.collect({ sequence: 1, nowMs: 1_000_000 });
  caddy = caddyCounters({
    requestsTotal: 175,
    responses2xxTotal: 150,
    requestDurationSecondsSum: 20,
    requestsInFlight: 1,
  });
  proxysql = proxySqlCounters({
    queriesTotal: 5_400,
    slowQueriesTotal: 3,
    clientConnections: 4,
  });
  const result = await collector.collect({ sequence: 2, nowMs: 1_060_000 });
  assertEquals(result.supported, true);
  if (!result.supported) return;

  const { metrics } = result.sample;
  assertEquals(metrics.caddyRequestsTotal, 75);
  assertEquals(metrics.caddyResponses2xxTotal, 60);
  assertEquals(metrics.caddyRequestDurationSecondsSum, 8);
  assertEquals(metrics.caddyRequestsInFlight, 1);
  assertEquals(metrics.proxysqlQueriesTotal, 400);
  assertEquals(metrics.proxysqlSlowQueriesTotal, 1);
  assertEquals(metrics.proxysqlClientConnections, 4);
});

it("nulls a counter field for the interval when it decreases (proxy restart), without nulling unrelated fields", async () => {
  const state = defaultState();
  let caddy = caddyCounters();
  const collector = new LinuxMetricsCollector(createDeps(state, {
    readProxyCounters: () => Promise.resolve({ caddy, proxysql: null }),
  }));

  await collector.collect({ sequence: 1, nowMs: 1_000_000 });
  // Caddy restarted: its Prometheus counters reset to near-zero, but keeps
  // running (requestsInFlight still reports).
  caddy = caddyCounters({ requestsTotal: 3, requestsInFlight: 1 });
  const result = await collector.collect({ sequence: 2, nowMs: 1_060_000 });
  assertEquals(result.supported, true);
  if (!result.supported) return;

  const { metrics } = result.sample;
  assertEquals(metrics.caddyRequestsTotal, null);
  // Unaffected counters (no decrease) still compute a normal delta.
  assertEquals(metrics.caddyResponses2xxTotal, 0);
  assertEquals(metrics.caddyRequestsInFlight, 1);
});

it("boot-id change nulls every traffic counter delta but leaves connection/backend gauges intact", async () => {
  const state = defaultState();
  let caddy = caddyCounters();
  let proxysql = proxySqlCounters();
  const collector = new LinuxMetricsCollector(createDeps(state, {
    readProxyCounters: () => Promise.resolve({ caddy, proxysql }),
  }));

  await collector.collect({ sequence: 1, nowMs: 1_000_000 });
  advanceState(state);
  state.bootText = fixture("proc-boot-id-2.txt");
  caddy = caddyCounters({ requestsTotal: 10, requestsInFlight: 0 });
  proxysql = proxySqlCounters({ queriesTotal: 20, backendsUp: 0 });
  const result = await collector.collect({ sequence: 2, nowMs: 1_060_000 });
  assertEquals(result.supported, true);
  if (!result.supported) return;

  const { metrics } = result.sample;
  assertEquals(metrics.caddyRequestsTotal, null);
  assertEquals(metrics.caddyRequestDurationSecondsSum, null);
  assertEquals(metrics.proxysqlQueriesTotal, null);
  assertEquals(metrics.proxysqlSlowQueriesTotal, null);
  // Gauges survive the reset, same as load1/cpuTemperatureCelsius above.
  assertEquals(metrics.caddyRequestsInFlight, 0);
  assertEquals(metrics.proxysqlClientConnections, 6);
  assertEquals(metrics.proxysqlBackendsUp, 0);
});
