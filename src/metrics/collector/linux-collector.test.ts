import { assertEquals } from "@std/assert";
import { LinuxMetricsCollector } from "./linux-collector.ts";
import type { CollectorDeps } from "./types.ts";
import { METRICS_SCHEMA_VERSION } from "../contract.ts";
import { it } from "@std/testing/bdd";

function fixture(name: string): string {
  return Deno.readTextFileSync(
    new URL(`./testdata/${name}`, import.meta.url),
  );
}

const FIXTURES = {
  "/proc/stat": ["proc-stat-1.txt", "proc-stat-2.txt"] as const,
  "/proc/meminfo": "proc-meminfo.txt",
  "/proc/loadavg": "proc-loadavg.txt",
  "/proc/uptime": "proc-uptime.txt",
  "/proc/diskstats": "proc-diskstats.txt",
  "/proc/net/dev": "proc-net-dev.txt",
  "/proc/sys/kernel/random/boot_id": "proc-boot-id.txt",
  "/proc/sys/kernel/osrelease": "proc-osrelease.txt",
} as const;

function createFixtureDeps(
  statIndex: 0 | 1,
  options?: { nowMs?: number; processCount?: number },
): { deps: CollectorDeps; now: () => number } {
  let clock = options?.nowMs ?? 1_000_000;
  const statFile = FIXTURES["/proc/stat"][statIndex];

  const deps: CollectorDeps = {
    readProcFile(path: string) {
      if (path === "/proc/stat") return fixture(statFile);
      if (path === FIXTURES["/proc/meminfo"] || path === "/proc/meminfo") {
        return fixture(FIXTURES["/proc/meminfo"]);
      }
      if (path === "/proc/loadavg") return fixture(FIXTURES["/proc/loadavg"]);
      if (path === "/proc/uptime") return fixture(FIXTURES["/proc/uptime"]);
      if (path === "/proc/diskstats") {
        return fixture(FIXTURES["/proc/diskstats"]);
      }
      if (path === "/proc/net/dev") return fixture(FIXTURES["/proc/net/dev"]);
      if (path === "/proc/sys/kernel/random/boot_id") {
        return fixture(FIXTURES["/proc/sys/kernel/random/boot_id"]);
      }
      if (path === "/proc/sys/kernel/osrelease") {
        return fixture(FIXTURES["/proc/sys/kernel/osrelease"]);
      }
      return undefined;
    },
    statfs() {
      return {
        blocks: 1_000_000,
        bfree: 400_000,
        bavail: 350_000,
        bsize: 4096,
      };
    },
    now: () => clock,
    countProcesses: () => options?.processCount ?? 42,
    resolveDimensions: () => ({
      schemaVersion: METRICS_SCHEMA_VERSION,
      daemonVersion: "testcommit",
      operatingSystem: "Test OS",
      architecture: "aarch64",
      kernelRelease: "6.1.0-amd64",
    }),
  };

  return {
    deps,
    now: () => {
      clock += 60_000;
      return clock;
    },
  };
}

it("LinuxMetricsCollector first sample has gauges but null rates", async () => {
  const { deps } = createFixtureDeps(0);
  const collector = new LinuxMetricsCollector(deps, {
    nominalIntervalSeconds: 60,
  });

  const result = await collector.collect({ sequence: 1, nowMs: 1_000_000 });
  assertEquals(result.supported, true);
  if (!result.supported) return;

  const { metrics } = result.sample;
  assertEquals(metrics.cpuUsagePercent, null);
  assertEquals(metrics.diskReadBytesPerSecond, null);
  assertEquals(metrics.networkReceiveBytesPerSecond, null);
  assertEquals(metrics.load1, 1.25);
  assertEquals(metrics.memoryUsedPercent, 50);
  assertEquals(metrics.processCount, 42);
  assertEquals(metrics.uptimeSeconds, 12345);
  assertEquals(result.sample.intervalSeconds, 60);
  assertEquals(result.sample.sequence, 1);
});

it("LinuxMetricsCollector second sample computes rates from deltas", async () => {
  let statIndex: 0 | 1 = 0;
  let clock = 1_000_000;

  const deps: CollectorDeps = {
    readProcFile(path: string) {
      if (path === "/proc/stat") {
        return fixture(statIndex === 0 ? "proc-stat-1.txt" : "proc-stat-2.txt");
      }
      if (path === "/proc/meminfo") return fixture("proc-meminfo.txt");
      if (path === "/proc/loadavg") return fixture("proc-loadavg.txt");
      if (path === "/proc/uptime") return fixture("proc-uptime.txt");
      if (path === "/proc/diskstats") return fixture("proc-diskstats.txt");
      if (path === "/proc/net/dev") return fixture("proc-net-dev.txt");
      if (path === "/proc/sys/kernel/random/boot_id") {
        return fixture("proc-boot-id.txt");
      }
      return undefined;
    },
    statfs: () => ({
      blocks: 1_000_000,
      bfree: 400_000,
      bavail: 350_000,
      bsize: 4096,
    }),
    now: () => clock,
    countProcesses: () => 42,
    resolveDimensions: () => ({
      schemaVersion: METRICS_SCHEMA_VERSION,
      daemonVersion: "testcommit",
      operatingSystem: "Test OS",
      architecture: "aarch64",
      kernelRelease: "6.1.0-amd64",
    }),
  };

  const collector = new LinuxMetricsCollector(deps, {
    nominalIntervalSeconds: 60,
  });

  await collector.collect({ sequence: 1, nowMs: clock });
  statIndex = 1;
  clock += 60_000;
  const result = await collector.collect({ sequence: 2, nowMs: clock });
  assertEquals(result.supported, true);
  if (!result.supported) return;

  const { metrics } = result.sample;
  assertEquals(metrics.cpuUsagePercent !== null, true);
  assertEquals(metrics.diskReadOpsPerSecond !== null, true);
  assertEquals(metrics.networkReceiveBytesPerSecond !== null, true);
  assertEquals(result.sample.intervalSeconds, 60);
});

it("LinuxMetricsCollector boot_id change nulls rate metrics", async () => {
  let bootFixture = "proc-boot-id.txt";
  let statIndex: 0 | 1 = 0;
  let clock = 1_000_000;

  const deps: CollectorDeps = {
    readProcFile(path: string) {
      if (path === "/proc/stat") {
        return fixture(statIndex === 0 ? "proc-stat-1.txt" : "proc-stat-2.txt");
      }
      if (path === "/proc/meminfo") return fixture("proc-meminfo.txt");
      if (path === "/proc/loadavg") return fixture("proc-loadavg.txt");
      if (path === "/proc/uptime") return fixture("proc-uptime.txt");
      if (path === "/proc/diskstats") return fixture("proc-diskstats.txt");
      if (path === "/proc/net/dev") return fixture("proc-net-dev.txt");
      if (path === "/proc/sys/kernel/random/boot_id") {
        return fixture(bootFixture);
      }
      return undefined;
    },
    statfs: () => ({
      blocks: 1_000_000,
      bfree: 400_000,
      bavail: 350_000,
      bsize: 4096,
    }),
    now: () => clock,
    countProcesses: () => 10,
    resolveDimensions: () => ({
      schemaVersion: METRICS_SCHEMA_VERSION,
      daemonVersion: "test",
      operatingSystem: "Linux",
      architecture: "x86_64",
      kernelRelease: "6.1.0",
    }),
  };

  const collector = new LinuxMetricsCollector(deps);
  await collector.collect({ sequence: 1, nowMs: clock });
  clock += 60_000;
  statIndex = 1;
  await collector.collect({ sequence: 2, nowMs: clock });
  bootFixture = "proc-boot-id-2.txt";
  clock += 60_000;
  const result = await collector.collect({ sequence: 3, nowMs: clock });
  assertEquals(result.supported, true);
  if (!result.supported) return;
  assertEquals(result.sample.metrics.cpuUsagePercent, null);
  assertEquals(result.sample.metrics.diskReadBytesPerSecond, null);
  assertEquals(result.sample.metrics.networkReceiveBytesPerSecond, null);
});

it("LinuxMetricsCollector nulls disk rates when device membership churns", async () => {
  let diskFixture = "proc-diskstats.txt";
  let statIndex: 0 | 1 = 0;
  let clock = 1_000_000;

  const deps: CollectorDeps = {
    readProcFile(path: string) {
      if (path === "/proc/stat") {
        return fixture(statIndex === 0 ? "proc-stat-1.txt" : "proc-stat-2.txt");
      }
      if (path === "/proc/meminfo") return fixture("proc-meminfo.txt");
      if (path === "/proc/loadavg") return fixture("proc-loadavg.txt");
      if (path === "/proc/uptime") return fixture("proc-uptime.txt");
      if (path === "/proc/diskstats") return fixture(diskFixture);
      if (path === "/proc/net/dev") return fixture("proc-net-dev.txt");
      if (path === "/proc/sys/kernel/random/boot_id") {
        return fixture("proc-boot-id.txt");
      }
      return undefined;
    },
    statfs: () => ({
      blocks: 1_000_000,
      bfree: 400_000,
      bavail: 350_000,
      bsize: 4096,
    }),
    now: () => clock,
    countProcesses: () => 10,
    resolveDimensions: () => ({
      schemaVersion: METRICS_SCHEMA_VERSION,
      daemonVersion: "test",
      operatingSystem: "Linux",
      architecture: "x86_64",
      kernelRelease: "6.1.0",
    }),
  };

  const collector = new LinuxMetricsCollector(deps);
  await collector.collect({ sequence: 1, nowMs: clock });
  clock += 60_000;
  statIndex = 1;
  await collector.collect({ sequence: 2, nowMs: clock });
  diskFixture = "proc-diskstats-no-sdb.txt";
  clock += 60_000;
  const result = await collector.collect({ sequence: 3, nowMs: clock });
  assertEquals(result.supported, true);
  if (!result.supported) return;
  assertEquals(result.sample.metrics.diskReadBytesPerSecond, null);
  assertEquals(result.sample.metrics.diskWriteBytesPerSecond, null);
  assertEquals(result.sample.metrics.diskReadOpsPerSecond, null);
  assertEquals(result.sample.metrics.diskWriteOpsPerSecond, null);
});

it("LinuxMetricsCollector nulls network rates when interface membership churns", async () => {
  let netFixture = "proc-net-dev.txt";
  let statIndex: 0 | 1 = 0;
  let clock = 1_000_000;

  const deps: CollectorDeps = {
    readProcFile(path: string) {
      if (path === "/proc/stat") {
        return fixture(statIndex === 0 ? "proc-stat-1.txt" : "proc-stat-2.txt");
      }
      if (path === "/proc/meminfo") return fixture("proc-meminfo.txt");
      if (path === "/proc/loadavg") return fixture("proc-loadavg.txt");
      if (path === "/proc/uptime") return fixture("proc-uptime.txt");
      if (path === "/proc/diskstats") return fixture("proc-diskstats.txt");
      if (path === "/proc/net/dev") return fixture(netFixture);
      if (path === "/proc/sys/kernel/random/boot_id") {
        return fixture("proc-boot-id.txt");
      }
      return undefined;
    },
    statfs: () => ({
      blocks: 1_000_000,
      bfree: 400_000,
      bavail: 350_000,
      bsize: 4096,
    }),
    now: () => clock,
    countProcesses: () => 10,
    resolveDimensions: () => ({
      schemaVersion: METRICS_SCHEMA_VERSION,
      daemonVersion: "test",
      operatingSystem: "Linux",
      architecture: "x86_64",
      kernelRelease: "6.1.0",
    }),
  };

  const collector = new LinuxMetricsCollector(deps);
  await collector.collect({ sequence: 1, nowMs: clock });
  clock += 60_000;
  statIndex = 1;
  await collector.collect({ sequence: 2, nowMs: clock });
  netFixture = "proc-net-dev-no-wlan0.txt";
  clock += 60_000;
  const result = await collector.collect({ sequence: 3, nowMs: clock });
  assertEquals(result.supported, true);
  if (!result.supported) return;
  assertEquals(result.sample.metrics.networkReceiveBytesPerSecond, null);
  assertEquals(result.sample.metrics.networkTransmitBytesPerSecond, null);
});

it("LinuxMetricsCollector nulls disk capacity when statfs denominator is zero", async () => {
  const deps: CollectorDeps = {
    readProcFile(path: string) {
      if (path === "/proc/stat") return fixture("proc-stat-1.txt");
      if (path === "/proc/meminfo") return fixture("proc-meminfo.txt");
      if (path === "/proc/loadavg") return fixture("proc-loadavg.txt");
      if (path === "/proc/uptime") return fixture("proc-uptime.txt");
      if (path === "/proc/diskstats") return fixture("proc-diskstats.txt");
      if (path === "/proc/net/dev") return fixture("proc-net-dev.txt");
      if (path === "/proc/sys/kernel/random/boot_id") {
        return fixture("proc-boot-id.txt");
      }
      return undefined;
    },
    statfs: () => ({
      blocks: 100,
      bfree: 100,
      bavail: 0,
      bsize: 4096,
    }),
    now: () => 1_000_000,
    countProcesses: () => 3,
    resolveDimensions: () => ({
      schemaVersion: METRICS_SCHEMA_VERSION,
      daemonVersion: "test",
      operatingSystem: "Linux",
      architecture: "x86_64",
      kernelRelease: "6.1.0",
    }),
  };

  const collector = new LinuxMetricsCollector(deps);
  const result = await collector.collect({ sequence: 1, nowMs: 1_000_000 });
  assertEquals(result.supported, true);
  if (!result.supported) return;
  assertEquals(result.sample.metrics.diskUsedPercent, null);
});

it("LinuxMetricsCollector tolerates throwing statfs via safeAsync", async () => {
  const deps: CollectorDeps = {
    readProcFile(path: string) {
      if (path === "/proc/stat") return fixture("proc-stat-1.txt");
      if (path === "/proc/meminfo") return fixture("proc-meminfo.txt");
      if (path === "/proc/loadavg") return fixture("proc-loadavg.txt");
      if (path === "/proc/uptime") return fixture("proc-uptime.txt");
      if (path === "/proc/diskstats") return fixture("proc-diskstats.txt");
      if (path === "/proc/net/dev") return fixture("proc-net-dev.txt");
      if (path === "/proc/sys/kernel/random/boot_id") {
        return fixture("proc-boot-id.txt");
      }
      return undefined;
    },
    statfs: () => {
      throw new Error("statfs unavailable");
    },
    now: () => 1_000_000,
    countProcesses: () => 3,
    resolveDimensions: () => ({
      schemaVersion: METRICS_SCHEMA_VERSION,
      daemonVersion: "test",
      operatingSystem: "Linux",
      architecture: "x86_64",
      kernelRelease: "6.1.0",
    }),
  };

  const collector = new LinuxMetricsCollector(deps);
  const result = await collector.collect({ sequence: 1, nowMs: 1_000_000 });
  assertEquals(result.supported, true);
  if (!result.supported) return;
  assertEquals(result.sample.metrics.diskUsedPercent, null);
});

it("LinuxMetricsCollector falls back when sample construction throws", async () => {
  const deps: CollectorDeps = {
    readProcFile: () => undefined,
    statfs: () => null,
    now: () => 1_000_000,
    countProcesses: () => null,
    resolveDimensions: () => {
      throw new Error("dimensions boom");
    },
  };

  const collector = new LinuxMetricsCollector(deps);
  const result = await collector.collect({ sequence: 7, nowMs: 1_000_000 });
  assertEquals(result.supported, true);
  if (!result.supported) return;
  assertEquals(result.sample.sequence, 7);
  assertEquals(result.sample.dimensions.daemonVersion, "unknown");
});

it("LinuxMetricsCollector uses deps.now when nowMs is omitted", async () => {
  const deps: CollectorDeps = {
    readProcFile: () => undefined,
    statfs: () => null,
    now: () => 5_000_000,
    countProcesses: () => 2,
    resolveDimensions: () => ({
      schemaVersion: METRICS_SCHEMA_VERSION,
      daemonVersion: "test",
      operatingSystem: "Linux",
      architecture: "x86_64",
      kernelRelease: "6.1.0",
    }),
  };
  const collector = new LinuxMetricsCollector(deps);
  const result = await collector.collect({ sequence: 1 });
  assertEquals(result.supported, true);
  if (!result.supported) return;
  assertEquals(result.sample.at, new Date(5_000_000).toISOString());
  assertEquals(result.sample.metrics.processCount, 2);
  assertEquals(result.sample.metrics.diskUsedPercent, null);
});

it("LinuxMetricsCollector nulls processCount when countProcesses throws", async () => {
  const deps: CollectorDeps = {
    readProcFile: () => undefined,
    statfs: () => null,
    now: () => 1_000_000,
    countProcesses: () => {
      throw new Error("ps unavailable");
    },
    resolveDimensions: () => ({
      schemaVersion: METRICS_SCHEMA_VERSION,
      daemonVersion: "test",
      operatingSystem: "Linux",
      architecture: "x86_64",
      kernelRelease: "6.1.0",
    }),
  };
  const collector = new LinuxMetricsCollector(deps);
  const result = await collector.collect({ sequence: 1, nowMs: 1_000_000 });
  assertEquals(result.supported, true);
  if (!result.supported) return;
  assertEquals(result.sample.metrics.processCount, null);
});

it("LinuxMetricsCollector uses elapsed seconds between samples", async () => {
  let clock = 1_000_000;
  const deps: CollectorDeps = {
    readProcFile(path: string) {
      if (path === "/proc/stat") return fixture("proc-stat-1.txt");
      if (path === "/proc/meminfo") return fixture("proc-meminfo.txt");
      if (path === "/proc/loadavg") return fixture("proc-loadavg.txt");
      if (path === "/proc/uptime") return fixture("proc-uptime.txt");
      if (path === "/proc/diskstats") return fixture("proc-diskstats.txt");
      if (path === "/proc/net/dev") return fixture("proc-net-dev.txt");
      if (path === "/proc/sys/kernel/random/boot_id") {
        return fixture("proc-boot-id.txt");
      }
      return undefined;
    },
    statfs: () => null,
    now: () => clock,
    countProcesses: () => 4,
    resolveDimensions: () => ({
      schemaVersion: METRICS_SCHEMA_VERSION,
      daemonVersion: "test",
      operatingSystem: "Linux",
      architecture: "x86_64",
      kernelRelease: "6.1.0",
    }),
  };
  const collector = new LinuxMetricsCollector(deps, {
    nominalIntervalSeconds: 60,
  });
  await collector.collect({ sequence: 1, nowMs: clock });
  clock += 30_000;
  const result = await collector.collect({ sequence: 2, nowMs: clock });
  assertEquals(result.supported, true);
  if (!result.supported) return;
  assertEquals(result.sample.intervalSeconds, 30);
});

it("LinuxMetricsCollector nulls disk capacity when statfs returns null", async () => {
  const deps: CollectorDeps = {
    readProcFile: () => undefined,
    statfs: () => null,
    now: () => 1_000_000,
    countProcesses: () => 3,
    resolveDimensions: () => ({
      schemaVersion: METRICS_SCHEMA_VERSION,
      daemonVersion: "test",
      operatingSystem: "Linux",
      architecture: "x86_64",
      kernelRelease: "6.1.0",
    }),
  };
  const collector = new LinuxMetricsCollector(deps);
  const result = await collector.collect({ sequence: 1, nowMs: 1_000_000 });
  assertEquals(result.supported, true);
  if (!result.supported) return;
  assertEquals(result.sample.metrics.diskUsedPercent, null);
  assertEquals(result.sample.metrics.load1, null);
  assertEquals(result.sample.metrics.uptimeSeconds, null);
});

it("LinuxMetricsCollector fallback uses deps.now when nowMs is omitted", async () => {
  const deps: CollectorDeps = {
    readProcFile: () => undefined,
    statfs: () => null,
    now: () => 9_000_000,
    countProcesses: () => null,
    resolveDimensions: () => {
      throw new Error("dimensions boom");
    },
  };
  const collector = new LinuxMetricsCollector(deps);
  const result = await collector.collect({ sequence: 3 });
  assertEquals(result.supported, true);
  if (!result.supported) return;
  assertEquals(result.sample.at, new Date(9_000_000).toISOString());
  assertEquals(result.sample.sequence, 3);
  assertEquals(result.sample.dimensions.daemonVersion, "unknown");
});

it("LinuxMetricsCollector keeps nominal interval when elapsed is non-positive", async () => {
  let clock = 2_000_000;
  const deps: CollectorDeps = {
    readProcFile(path: string) {
      if (path === "/proc/stat") return fixture("proc-stat-1.txt");
      if (path === "/proc/meminfo") return fixture("proc-meminfo.txt");
      if (path === "/proc/loadavg") return fixture("proc-loadavg.txt");
      if (path === "/proc/uptime") return fixture("proc-uptime.txt");
      if (path === "/proc/diskstats") return fixture("proc-diskstats.txt");
      if (path === "/proc/net/dev") return fixture("proc-net-dev.txt");
      if (path === "/proc/sys/kernel/random/boot_id") {
        return fixture("proc-boot-id.txt");
      }
      return undefined;
    },
    statfs: () => ({
      blocks: 1_000_000,
      bfree: 400_000,
      bavail: 350_000,
      bsize: 4096,
    }),
    now: () => clock,
    countProcesses: () => 4,
    resolveDimensions: () => ({
      schemaVersion: METRICS_SCHEMA_VERSION,
      daemonVersion: "test",
      operatingSystem: "Linux",
      architecture: "x86_64",
      kernelRelease: "6.1.0",
    }),
  };

  const collector = new LinuxMetricsCollector(deps, {
    nominalIntervalSeconds: 60,
  });
  await collector.collect({ sequence: 1, nowMs: clock });
  clock -= 1_000;
  const result = await collector.collect({ sequence: 2, nowMs: clock });
  assertEquals(result.supported, true);
  if (!result.supported) return;
  assertEquals(result.sample.intervalSeconds, 60);
});
