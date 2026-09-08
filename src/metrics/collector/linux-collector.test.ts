import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { emptyDirectoryUsageSnapshot } from "./directory-usage.ts";
import { EventCollectorSet } from "./events/index.ts";
import { LinuxMetricsCollector } from "./linux-collector.ts";
import { defaultSensorIo } from "./sensors/discovery.ts";
import type { CollectorDeps } from "./types.ts";
import { collectTopology } from "../topology/topology.ts";
import { collectHardwareSignals } from "../topology/hardware-signal-topology.ts";
import { PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN } from "../capability-plan.ts";
import { computeSlotMapping } from "../topology/slot-mapping.ts";
import { EMPTY_TOPOLOGY_OVERRIDES } from "../topology/types.ts";
import type {
  PhysicalSignalTopology,
  TopologySnapshot,
} from "../topology/types.ts";
import type { GpuAdapterSet } from "./gpu/adapter.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function fixture(name: string): string {
  return Deno.readTextFileSync(
    new URL(`./testdata/${name}`, import.meta.url),
  );
}

function topologyFixtureRoot(name: string): string {
  return fromFileUrl(
    new URL(`../topology/testdata/${name}`, import.meta.url),
  );
}

/** One service block device (sda), one uplink NIC (eth0), one root filesystem. */
function fullTopologySnapshot(
  overrides: Partial<TopologySnapshot> = {},
): TopologySnapshot {
  return {
    generation: 7,
    bootGeneration: 2,
    networks: [
      {
        deviceId: "mac:aa:bb:cc:dd:ee:00",
        kind: "uplink",
        name: "eth0",
        identity: { mac: "aa:bb:cc:dd:ee:00" },
      },
    ],
    filesystems: [
      {
        filesystemId: "fs:dev:/dev/sda1",
        mountpoint: "/",
        fsType: "ext4",
        sourceDevice: "/dev/sda1",
        totalBytes: null,
        totalInodes: null,
        roles: ["root"],
      },
      {
        filesystemId: "fs:dev:/dev/sdb1",
        mountpoint: "/data",
        fsType: "ext4",
        sourceDevice: "/dev/sdb1",
        totalBytes: null,
        totalInodes: null,
        roles: ["hosting"],
      },
    ],
    blockDevices: [
      {
        deviceId: "blk:sda",
        kernelName: "sda",
        deviceType: "physical",
        isServiceDevice: true,
      },
    ],
    gpus: [],
    hardwareSignals: [],
    cpu: {
      sockets: 1,
      coresPerSocket: 2,
      threadsPerSocket: 2,
      model: null,
      cores: [
        { logicalIndex: 0, coreId: "cpu:p0c0t0" },
        { logicalIndex: 1, coreId: "cpu:p0c1t0" },
      ],
    },
    numaNodes: [],
    memoryTotalBytes: null,
    swapTotalBytes: null,
    ...overrides,
  };
}

type RawFixtureMap = Partial<{
  "/proc/stat": string;
  "/proc/meminfo": string;
  "/proc/vmstat": string;
  "/proc/diskstats": string;
  "/proc/net/dev": string;
  "/proc/net/snmp": string;
  "/proc/net/netstat": string;
  "/proc/net/softnet_stat": string;
  "/proc/pressure/cpu": string;
  "/proc/pressure/memory": string;
  "/proc/pressure/io": string;
  "/proc/sys/fs/file-nr": string;
  "/proc/sys/fs/file-max": string;
  "/proc/sys/net/netfilter/nf_conntrack_count": string;
  "/proc/sys/net/netfilter/nf_conntrack_max": string;
  "/proc/mounts": string;
  "/proc/mdstat": string;
}>;

/**
 * `raw` is read lazily via a getter so the same collector instance (and its
 * internal counter-baseline tracker) can serve fixture text that changes
 * between ticks.
 */
function makeDeps(
  raw: () => RawFixtureMap,
  snapshot: TopologySnapshot,
  now: () => number,
  pageSizeBytes = 4096,
): CollectorDeps {
  return {
    readProcFile: (path: string) =>
      (raw() as Record<string, string | undefined>)[path],
    statfs: () => ({
      blocks: 1_000_000,
      bfree: 400_000,
      bavail: 350_000,
      bsize: 4096,
      files: 100_000,
      ffree: 90_000,
    }),
    now,
    collectTopology: () => Promise.resolve(snapshot),
    io: { listDir: () => [], readFile: () => undefined },
    pageSizeBytes,
  };
}

const TICK_1: RawFixtureMap = {
  "/proc/stat": fixture("proc-stat-guest-fields-1.txt"),
  "/proc/meminfo": fixture("proc-meminfo.txt"),
  "/proc/vmstat": fixture("proc-vmstat-1.txt"),
  "/proc/diskstats": fixture("proc-diskstats-virtio-1.txt")
    .replace("vda", "sda"),
  "/proc/net/dev": fixture("proc-net-dev.txt"),
  "/proc/net/snmp": fixture("proc-net-snmp-1.txt"),
  "/proc/net/netstat": fixture("proc-net-netstat-1.txt"),
  "/proc/net/softnet_stat": fixture("proc-net-softnet-stat-1.txt"),
  "/proc/pressure/cpu": fixture("proc-pressure-cpu.txt"),
  "/proc/pressure/memory": fixture("proc-pressure-memory.txt"),
  "/proc/pressure/io": fixture("proc-pressure-io.txt"),
  "/proc/sys/fs/file-nr": fixture("proc-file-nr.txt"),
  "/proc/sys/fs/file-max": fixture("proc-file-max.txt"),
  "/proc/sys/net/netfilter/nf_conntrack_count": fixture(
    "proc-conntrack-count.txt",
  ),
  "/proc/sys/net/netfilter/nf_conntrack_max": fixture("proc-conntrack-max.txt"),
};

const TICK_2: RawFixtureMap = {
  ...TICK_1,
  "/proc/stat": fixture("proc-stat-guest-fields-2.txt"),
  "/proc/diskstats": fixture("proc-diskstats-virtio-2.txt")
    .replace("vda", "sda"),
  "/proc/net/snmp": fixture("proc-net-snmp-2.txt"),
  "/proc/net/netstat": fixture("proc-net-netstat-2.txt"),
  "/proc/net/softnet_stat": fixture("proc-net-softnet-stat-2.txt"),
  "/proc/pressure/cpu": fixture("proc-pressure-cpu-2.txt"),
  "/proc/pressure/memory": fixture("proc-pressure-memory-2.txt"),
  "/proc/pressure/io": fixture("proc-pressure-io-2.txt"),
};

test("LinuxMetricsCollector assembles a full v5 sample across two ticks", async () => {
  const snapshot = fullTopologySnapshot();
  let tick = 0;
  let nowMs = 1_000_000;
  const collector = new LinuxMetricsCollector(
    makeDeps(() => (tick === 0 ? TICK_1 : TICK_2), snapshot, () => nowMs),
  );

  const first = await collector.collect({ sequence: 1, nowMs });
  if (!first.supported) throw new TypeError("expected a supported sample");

  // First tick: every rate/percent needing a prior baseline is null; gauges
  // (procs, memory, file handles, conntrack) resolve immediately.
  assertEquals(first.sample.host.cpu.busyPercent, null);
  assertEquals(first.sample.host.cpu.procsRunning, 2);
  assertEquals(typeof first.sample.host.cpu.processCount, "number");
  assertEquals((first.sample.host.cpu.processCount ?? 0) > 2, true);
  assertEquals(
    first.sample.host.kernel.fileHandlesUsedPercent,
    (4256 / 1048576) * 100,
  );
  assertEquals(
    first.sample.host.kernel.conntrackUsedPercent,
    (12345 / 262144) * 100,
  );
  assertEquals(first.sample.host.memory.usedBytes !== null, true);
  assertEquals(first.sample.host.storage.diskReadBytesPerSecond, null);
  assertEquals(first.sample.host.network.tcpRetransmitPercent, null);
  assertEquals(first.sample.metadata.topologyGeneration, 7);
  assertEquals(first.sample.metadata.bootGeneration, 2);
  assertEquals(first.sample.networks.length, 1);
  assertEquals(first.sample.filesystems.length, 1);
  assertEquals(first.sample.blockDevices.length, 1);
  assertEquals(first.sample.gpus, []);
  assertEquals(first.sample.hardwareSignals, []);

  tick = 1;
  nowMs += 60_000;
  const second = await collector.collect({ sequence: 2, nowMs });
  if (!second.supported) throw new TypeError("expected a supported sample");

  // Second tick: rates/percentages now compute from real deltas.
  assertEquals(typeof second.sample.host.cpu.busyPercent, "number");
  assertEquals(second.sample.host.cpu.busyPercent !== null, true);
  assertEquals(
    typeof second.sample.host.storage.diskReadBytesPerSecond,
    "number",
  );
  assertEquals(
    second.sample.host.storage.diskReadBytesPerSecond,
    (3000 * 512) / 60,
  );
  assertEquals(
    typeof second.sample.host.network.tcpRetransmitPercent,
    "number",
  );
  assertEquals(second.sample.blockDevices[0].deviceId, "blk:sda");
  assertEquals(second.sample.networks[0].deviceId, "mac:aa:bb:cc:dd:ee:00");
  // Root's own entry ("fs:dev:/dev/sda1") never appears in filesystems[] —
  // its capacity lives exclusively in host.storage's rootFilesystem* fields
  // below (see probeRootFilesystemCapacity in filesystem.ts).
  assertEquals(second.sample.filesystems[0].filesystemId, "fs:dev:/dev/sdb1");
  assertEquals(
    second.sample.host.storage.rootFilesystemAvailableBytes,
    350_000 * 4096,
  );
  assertEquals(second.sample.host.storage.rootFilesystemFreeInodes, 90_000);
});

test("LinuxMetricsCollector uses injected countProcesses instead of a live /proc scan", async () => {
  const collector = new LinuxMetricsCollector({
    ...makeDeps(() => TICK_1, fullTopologySnapshot(), () => 1_000_000),
    countProcesses: () => 17,
  });
  const result = await collector.collect({ sequence: 1, nowMs: 1_000_000 });
  if (!result.supported) {
    throw new TypeError("expected a supported sample");
  }
  assertEquals(result.sample.host.cpu.processCount, 17);
});

test("LinuxMetricsCollector applies the injected page size to swap byte rates, not a hard-coded 4096", async () => {
  const snapshot = fullTopologySnapshot();
  const tick2WithVmstatDelta: RawFixtureMap = {
    ...TICK_2,
    "/proc/vmstat": fixture("proc-vmstat-2.txt"),
  };
  let tick = 0;
  let nowMs = 1_000_000;
  const nonDefaultPageSizeBytes = 16384;
  const collector = new LinuxMetricsCollector(
    makeDeps(
      () => (tick === 0 ? TICK_1 : tick2WithVmstatDelta),
      snapshot,
      () => nowMs,
      nonDefaultPageSizeBytes,
    ),
  );

  await collector.collect({ sequence: 1, nowMs });
  tick = 1;
  nowMs += 60_000;
  const second = await collector.collect({ sequence: 2, nowMs });
  if (!second.supported) throw new TypeError("expected a supported sample");

  // proc-vmstat-1.txt -> proc-vmstat-2.txt: pswpin 100 -> 160, pswpout 200 -> 380.
  assertEquals(
    second.sample.host.memory.swapInBytesPerSecond,
    ((160 - 100) / 60) * nonDefaultPageSizeBytes,
  );
  assertEquals(
    second.sample.host.memory.swapOutBytesPerSecond,
    ((380 - 200) / 60) * nonDefaultPageSizeBytes,
  );
});

test("LinuxMetricsCollector reports null (never 0) for PSI-absent and conntrack-absent hosts", async () => {
  const snapshot = fullTopologySnapshot();
  const raw: RawFixtureMap = {
    ...TICK_1,
    "/proc/pressure/cpu": undefined,
    "/proc/pressure/memory": undefined,
    "/proc/pressure/io": undefined,
    "/proc/sys/net/netfilter/nf_conntrack_count": undefined,
    "/proc/sys/net/netfilter/nf_conntrack_max": undefined,
  };
  let nowMs = 1_000_000;
  const collector = new LinuxMetricsCollector(
    makeDeps(() => raw, snapshot, () => nowMs),
  );

  await collector.collect({ sequence: 1, nowMs });
  nowMs += 60_000;
  const second = await collector.collect({ sequence: 2, nowMs });
  if (!second.supported) throw new TypeError("expected a supported sample");

  assertEquals(second.sample.host.cpu.pressureSomePercent, null);
  assertEquals(second.sample.host.memory.pressureSomePercent, null);
  assertEquals(second.sample.host.memory.pressureFullPercent, null);
  assertEquals(second.sample.host.storage.ioPressureSomePercent, null);
  assertEquals(second.sample.host.storage.ioPressureFullPercent, null);
  assertEquals(second.sample.host.kernel.conntrackUsedPercent, null);
});

test("LinuxMetricsCollector smoke test: a normal 1-NIC VM produces a logically complete sample", async () => {
  const snapshot = fullTopologySnapshot();
  let nowMs = 1_000_000;
  const collector = new LinuxMetricsCollector(
    makeDeps(() => TICK_1, snapshot, () => nowMs),
  );

  await collector.collect({ sequence: 1, nowMs });
  nowMs += 60_000;
  const result = await collector.collect({ sequence: 2, nowMs });
  if (!result.supported) throw new TypeError("expected a supported sample");

  assertEquals(result.sample.type, "metrics");
  assertEquals(result.sample.metadata.version, 6);
  assertEquals(result.sample.networks.length, 1);
  assertEquals(result.sample.filesystems.length, 1);
  assertEquals(result.sample.blockDevices.length, 1);
  assertEquals(result.sample.events, []);
  assertEquals(result.sample.ingressSources, []);
  assertEquals(result.sample.databaseProxies, []);
});

test("LinuxMetricsCollector never throws out of collect() — falls back to a minimal valid sample", async () => {
  const collector = new LinuxMetricsCollector({
    readProcFile: () => undefined,
    statfs: () => null,
    now: () => 1_000,
    collectTopology: () => Promise.reject(new Error("topology boom")),
    io: { listDir: () => [], readFile: () => undefined },
    pageSizeBytes: 4096,
  });

  const result = await collector.collect({ sequence: 1 });
  if (!result.supported) {
    throw new TypeError("expected a supported (fallback) sample");
  }
  assertEquals(result.sample.type, "metrics");
  assertEquals(result.sample.metadata.topologyGeneration, 0);
  assertEquals(result.sample.metadata.bootGeneration, 0);
  assertEquals(result.sample.host.cpu.busyPercent, null);
  assertEquals(result.sample.networks, []);
  assertEquals(result.sample.filesystems, []);
  assertEquals(result.sample.blockDevices, []);
});

test("LinuxMetricsCollector re-baselines (nulls once) on a boot generation change", async () => {
  let generation = 2;
  let tick = 0;
  const collector = new LinuxMetricsCollector({
    readProcFile: (path: string) => {
      const source = tick === 0 ? TICK_1 : TICK_2;
      return (source as Record<string, string | undefined>)[path];
    },
    statfs: () => ({
      blocks: 1_000_000,
      bfree: 400_000,
      bavail: 350_000,
      bsize: 4096,
      files: 100_000,
      ffree: 90_000,
    }),
    now: () => 0,
    collectTopology: () =>
      Promise.resolve(fullTopologySnapshot({ bootGeneration: generation })),
    io: { listDir: () => [], readFile: () => undefined },
    pageSizeBytes: 4096,
  });

  let nowMs = 1_000_000;
  await collector.collect({ sequence: 1, nowMs });
  tick = 1;
  nowMs += 60_000;
  const beforeReboot = await collector.collect({ sequence: 2, nowMs });
  if (!beforeReboot.supported) {
    throw new TypeError("expected a supported sample");
  }
  assertEquals(typeof beforeReboot.sample.host.cpu.busyPercent, "number");
  assertEquals(beforeReboot.sample.host.cpu.busyPercent !== null, true);

  // Reboot: bootGeneration bumps — every counter-delta field re-baselines.
  generation = 3;
  nowMs += 60_000;
  const afterReboot = await collector.collect({ sequence: 3, nowMs });
  if (!afterReboot.supported) {
    throw new TypeError("expected a supported sample");
  }
  assertEquals(afterReboot.sample.host.cpu.busyPercent, null);
  assertEquals(afterReboot.sample.host.network.tcpRetransmitPercent, null);
});

test("LinuxMetricsCollector: a real /dev/mapper/* (LVM) root, discovered through collectTopology(), still produces service block devices and non-null host disk aggregates", async () => {
  const daemonStateDir = await Deno.makeTempDir();
  try {
    const diskstatsLvm1 = fixture("proc-diskstats-lvm.txt");
    const diskstatsLvm2 = diskstatsLvm1.replace(
      "dm-0 900 180 27000 360 450 540 63000 720",
      "dm-0 1000 180 30000 400 550 540 77000 800",
    );

    const snapshot = await collectTopology({
      readProcFile: (path) => {
        if (path === "/proc/net/dev") {
          return "Inter-|   Receive\n face |bytes\n  eth0: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n";
        }
        // An LVM root: the mount source is a /dev/mapper/* symlink target,
        // never a direct /dev/<name> — the actual production path this
        // end-to-end test exercises (see mounts.ts's `backingDeviceNames`).
        if (path === "/proc/mounts") {
          return "/dev/mapper/vg0-root / ext4 rw,relatime 0 0\n";
        }
        if (path === "/proc/diskstats") return diskstatsLvm1;
        return undefined;
      },
      statfs: () => ({ blocks: 1000, bfree: 500, bavail: 400, bsize: 4096 }),
      resolveDockerDataRoot: () => Promise.resolve(null),
      resolveHostingPath: () => Promise.reject(new Error("no hosting path")),
      resolveFabricInterfaces: () => Promise.resolve([]),
      io: defaultSensorIo(),
      sysRoot: topologyFixtureRoot("block-graph-lvm"),
      daemonStateDir,
      resolveTopologyOverrides: () => Promise.resolve(EMPTY_TOPOLOGY_OVERRIDES),
      resolveBootGeneration: () => Promise.resolve(0),
      collectHardwareSignals: () => Promise.resolve([]),
    });

    const dm0 = snapshot.blockDevices.find((d) => d.kernelName === "dm-0");
    if (!dm0) throw new TypeError("expected dm-0 in block topology");
    assertEquals(dm0.isServiceDevice, true);

    let tick = 0;
    let nowMs = 1_000_000;
    const collector = new LinuxMetricsCollector(
      makeDeps(
        () => ({
          "/proc/diskstats": tick === 0 ? diskstatsLvm1 : diskstatsLvm2,
        }),
        snapshot,
        () => nowMs,
      ),
    );

    await collector.collect({ sequence: 1, nowMs });
    tick = 1;
    nowMs += 60_000;
    const second = await collector.collect({ sequence: 2, nowMs });
    if (!second.supported) throw new TypeError("expected a supported sample");

    assertEquals(
      second.sample.blockDevices.some((d) => d.deviceId === dm0.deviceId),
      true,
    );
    assertEquals(
      second.sample.host.storage.diskReadBytesPerSecond,
      (3000 * 512) / 60,
    );
    assertEquals(
      second.sample.host.storage.diskWriteBytesPerSecond,
      (14000 * 512) / 60,
    );
  } finally {
    await Deno.remove(daemonStateDir, { recursive: true });
  }
});

test("LinuxMetricsCollector populates ingressSources/databaseProxies/router when their adapters are wired, and leaves them empty when absent (default)", async () => {
  const snapshot = fullTopologySnapshot();
  const nowMs = 1_000_000;

  const withoutAdapters = new LinuxMetricsCollector(
    makeDeps(() => TICK_1, snapshot, () => nowMs),
  );
  const withoutResult = await withoutAdapters.collect({
    sequence: 1,
    nowMs,
  });
  if (!withoutResult.supported) {
    throw new TypeError("expected a supported sample");
  }
  assertEquals(withoutResult.sample.ingressSources, []);
  assertEquals(withoutResult.sample.databaseProxies, []);
  // The router is presence-gated: no adapter set means the key is absent from
  // the sample entirely, not an all-null placeholder object.
  assertEquals(withoutResult.sample.router, undefined);
  assertEquals(Object.hasOwn(withoutResult.sample, "router"), false);

  const withAdapters = new LinuxMetricsCollector({
    ...makeDeps(() => TICK_1, snapshot, () => nowMs),
    ingressAdapters: {
      caddy: {
        id: "caddy",
        probe: () => Promise.resolve(),
        read: () =>
          Promise.resolve({
            sourceId: "caddy",
            sourceKind: "caddy",
            reading: { requests: null },
          }),
      },
    },
    routerAdapters: {
      traefik: {
        id: "traefik",
        probe: () => Promise.resolve(),
        read: () => Promise.resolve({ backendsUp: 2, routersTotal: 5 }),
      },
    },
    databaseProxyAdapters: {
      proxysql: {
        id: "proxysql",
        probe: () => Promise.resolve(),
        read: () =>
          Promise.resolve({
            sourceId: "proxysql",
            sourceKind: "proxysql",
            reading: { clientConnections: 3 },
          }),
      },
    },
  });
  const withResult = await withAdapters.collect({ sequence: 1, nowMs });
  if (!withResult.supported) {
    throw new TypeError("expected a supported sample");
  }
  assertEquals(withResult.sample.ingressSources.length, 1);
  assertEquals(withResult.sample.ingressSources[0].sourceId, "caddy");
  assertEquals(withResult.sample.databaseProxies.length, 1);
  assertEquals(withResult.sample.databaseProxies[0].sourceId, "proxysql");
  assertEquals(withResult.sample.databaseProxies[0].clientConnections, 3);
  assertEquals(withResult.sample.router?.backendsUp, 2);
  assertEquals(withResult.sample.router?.routersTotal, 5);
  // Fields the reading didn't set are null, never dropped.
  assertEquals(withResult.sample.router?.configReloads, null);
});

test("LinuxMetricsCollector omits storage/dockerUsage until the cached readings land, then reports both", async () => {
  const snapshot = fullTopologySnapshot();
  const nowMs = 1_000_000;

  const withoutSamplers = new LinuxMetricsCollector(
    makeDeps(() => TICK_1, snapshot, () => nowMs),
  );
  const withoutResult = await withoutSamplers.collect({
    sequence: 1,
    nowMs,
  });
  if (!withoutResult.supported) {
    throw new TypeError("expected a supported sample");
  }
  // No samplers wired: both keys are absent from the sample entirely, not
  // all-null placeholder objects.
  assertEquals(Object.hasOwn(withoutResult.sample, "storage"), false);
  assertEquals(Object.hasOwn(withoutResult.sample, "dockerUsage"), false);

  // Walker started but its first walk has not completed — `computedAtMs` is
  // still null, so `storage` must stay absent rather than emit a row of nulls.
  const beforeFirstWalk = new LinuxMetricsCollector({
    ...makeDeps(() => TICK_1, snapshot, () => nowMs),
    directoryUsage: () => emptyDirectoryUsageSnapshot(),
    dockerUsage: () => null,
  });
  const pendingResult = await beforeFirstWalk.collect({ sequence: 1, nowMs });
  if (!pendingResult.supported) {
    throw new TypeError("expected a supported sample");
  }
  assertEquals(Object.hasOwn(pendingResult.sample, "storage"), false);

  const withSamplers = new LinuxMetricsCollector({
    ...makeDeps(() => TICK_1, snapshot, () => nowMs),
    directoryUsage: () => ({
      hosting: { usedBytes: 4096, freeBytes: 1000 },
      backup: { usedBytes: 2048, freeBytes: 2000 },
      logs: { usedBytes: 512, freeBytes: 3000 },
      computedAtMs: nowMs,
    }),
    dockerUsage: () => ({
      usage: {
        layersBytes: 6000,
        imagesCount: 4,
        imagesReclaimableBytes: 1000,
        containersBytes: 1200,
        containersCount: 3,
        volumesBytes: 900,
        volumesCount: 2,
        volumesReclaimableBytes: 100,
        buildCacheBytes: 92,
        buildCacheReclaimableBytes: 92,
      },
      dockerUsedBytes: 8192,
    }),
  });
  const withResult = await withSamplers.collect({ sequence: 1, nowMs });
  if (!withResult.supported) {
    throw new TypeError("expected a supported sample");
  }
  assertEquals(withResult.sample.storage?.hostingUsedBytes, 4096);
  assertEquals(withResult.sample.storage?.backupUsedBytes, 2048);
  assertEquals(withResult.sample.storage?.logsFreeBytes, 3000);
  // The one field shared with the Docker breakdown — its total, not a re-walk.
  assertEquals(withResult.sample.storage?.dockerUsedBytes, 8192);
  // No census getter wired (or none landed yet): every engine group is null,
  // never 0 — the same "unknown" a host without that engine reports.
  assertEquals(withResult.sample.storage?.postgres.instancesRunning, null);
  assertEquals(withResult.sample.storage?.mariadb.connectionsMax, null);
  assertEquals(withResult.sample.dockerUsage?.layersBytes, 6000);
  assertEquals(withResult.sample.dockerUsage?.buildCacheReclaimableBytes, 92);
});

test("LinuxMetricsCollector reports storage with a null dockerUsedBytes when Docker is absent", async () => {
  const snapshot = fullTopologySnapshot();
  const nowMs = 1_000_000;
  const collector = new LinuxMetricsCollector({
    ...makeDeps(() => TICK_1, snapshot, () => nowMs),
    directoryUsage: () => ({
      hosting: { usedBytes: 4096, freeBytes: 1000 },
      backup: { usedBytes: null, freeBytes: null },
      logs: { usedBytes: 512, freeBytes: 3000 },
      computedAtMs: nowMs,
    }),
    dockerUsage: () => null,
  });
  const result = await collector.collect({ sequence: 1, nowMs });
  if (!result.supported) throw new TypeError("expected a supported sample");
  assertEquals(result.sample.storage?.hostingUsedBytes, 4096);
  // No Docker: the total is null (not 0) and the breakdown family is absent.
  assertEquals(result.sample.storage?.dockerUsedBytes, null);
  assertEquals(Object.hasOwn(result.sample, "dockerUsage"), false);
  // An unmeasurable backup root stays null rather than reporting zero bytes.
  assertEquals(result.sample.storage?.backupUsedBytes, null);
});

function quietEventCollectorSet(): EventCollectorSet {
  return new EventCollectorSet({
    gpuHealthReader: () =>
      Promise.resolve({
        eccDoubleBitAggregateTotal: null,
        lastXidErrorCode: null,
        remappedRows: null,
        retiredPagesPending: null,
      }),
    smartRunner: () => Promise.resolve(null),
    fabricStateReader: () => [],
    clockSyncReader: () => undefined,
    kernelLogReader: () => Promise.resolve([]),
  });
}

test("LinuxMetricsCollector: a bare-metal host with real hardware signals wired end-to-end (hardwareSignals populated, events stay [] on a quiet tick)", async () => {
  const sysRoot = topologyFixtureRoot("physical-signals-basic");
  const hardwareSignals = await collectHardwareSignals({
    io: defaultSensorIo(),
    sysRoot,
  });
  const snapshot = fullTopologySnapshot({ hardwareSignals });

  let nowMs = 1_000_000;
  const collector = new LinuxMetricsCollector({
    ...makeDeps(() => TICK_1, snapshot, () => nowMs),
    io: defaultSensorIo(),
    sysRoot,
    eventCollectors: quietEventCollectorSet(),
  });

  const first = await collector.collect({ sequence: 1, nowMs });
  if (!first.supported) throw new TypeError("expected a supported sample");
  assertEquals(first.sample.events, []);
  assertEquals(first.sample.hardwareSignals.length, 2);
  const firstTemp = first.sample.hardwareSignals.find((s) =>
    s.kind === "temperature"
  );
  assertEquals(firstTemp?.value, 45); // fixture's temp1_input (45000 millidegrees), well under its 90°C _max.
  const firstPower = first.sample.hardwareSignals.find((s) =>
    s.kind === "power"
  );
  assertEquals(firstPower?.value, null); // RAPL energy: first observation has no baseline yet.

  nowMs += 60_000;
  const second = await collector.collect({ sequence: 2, nowMs });
  if (!second.supported) throw new TypeError("expected a supported sample");
  assertEquals(second.sample.events, []);
  const secondPower = second.sample.hardwareSignals.find((s) =>
    s.kind === "power"
  );
  assertEquals(secondPower?.value, 0); // Static fixture counter -> zero delta -> 0 W, not null.
});

test("LinuxMetricsCollector: the full physical-signal fixture is fan-free/GPU-free and carries both CPU virtual signals", async () => {
  const sysRoot = topologyFixtureRoot("physical-signals-full");
  const hardwareSignals = await collectHardwareSignals({
    io: defaultSensorIo(),
    sysRoot,
  });
  const snapshot = fullTopologySnapshot({ hardwareSignals });

  let nowMs = 1_000_000;
  const collector = new LinuxMetricsCollector({
    ...makeDeps(() => TICK_1, snapshot, () => nowMs),
    io: defaultSensorIo(),
    sysRoot,
    eventCollectors: quietEventCollectorSet(),
  });

  const first = await collector.collect({ sequence: 1, nowMs });
  if (!first.supported) throw new TypeError("expected a supported sample");
  assertEquals(first.sample.hardwareSignals.length, 7);
  assertEquals(
    first.sample.hardwareSignals.some((s) => s.kind === "fan"),
    false,
  );

  const hottestCore = first.sample.hardwareSignals.find((s) =>
    s.signalId === "signal:cpu:hottest-core"
  );
  assertEquals(hottestCore?.value, 68); // max(Core 0: 50°C, Core 1: 68°C).

  const throttledFirst = first.sample.hardwareSignals.find((s) =>
    s.signalId === "signal:cpu:thermal-throttled"
  );
  assertEquals(throttledFirst?.value, null); // no baseline yet.

  nowMs += 60_000;
  const second = await collector.collect({ sequence: 2, nowMs });
  if (!second.supported) throw new TypeError("expected a supported sample");
  const throttledSecond = second.sample.hardwareSignals.find((s) =>
    s.signalId === "signal:cpu:thermal-throttled"
  );
  assertEquals(throttledSecond?.value, 0); // Static fixture counter -> zero delta -> 0%, not null.
});

test("LinuxMetricsCollector samples only the slot-mapped NICs (slot order) plus fabric devices — members, VLAN children, tunnels, container bridges, and loopback are never emitted", async () => {
  const nic = (
    name: string,
    kind: TopologySnapshot["networks"][number]["kind"],
    extra: Partial<TopologySnapshot["networks"][number]> = {},
  ) => ({
    deviceId: `virtual:${name}`,
    kind,
    name,
    identity: { virtualKey: name },
    ...extra,
  });
  const snapshot = fullTopologySnapshot({
    networks: [
      nic("lo", "loopback"),
      nic("veth1", "container-bridge"),
      nic("bond0", "uplink"),
      nic("eth0", "member"),
      nic("eth1", "member"),
      nic("eth2", "uplink", { defaultRoute: true }),
      nic("eth2.100", "virtual"),
      nic("tp0", "fabric"),
    ],
  });
  const nowMs = 1_000_000;
  const raw = () => TICK_1;

  // Auto selection: the default-route uplink only, then fabric.
  const auto = new LinuxMetricsCollector(
    makeDeps(raw, snapshot, () => nowMs),
    { nominalIntervalSeconds: 60 },
  );
  const autoResult = await auto.collect({ sequence: 1, nowMs });
  if (!autoResult.supported) throw new TypeError("expected a supported sample");
  assertEquals(
    autoResult.sample.networks.map((device) => device.deviceId),
    ["virtual:eth2", "virtual:tp0"],
  );

  // An operator list wins outright, in its own order; a pinned id absent
  // from the snapshot has nothing to sample and never pulls in a neighbor.
  const pinned = new LinuxMetricsCollector(
    {
      ...makeDeps(raw, snapshot, () => nowMs),
      resolveTopologyOverrides: () =>
        Promise.resolve({
          nicSlotDeviceIds: ["virtual:bond0", "virtual:gone", "virtual:eth2"],
          hostingFilesystemId: null,
          drivetempEnabled: false,
        }),
    },
    { nominalIntervalSeconds: 60 },
  );
  const pinnedResult = await pinned.collect({ sequence: 1, nowMs });
  if (!pinnedResult.supported) {
    throw new TypeError("expected a supported sample");
  }
  assertEquals(
    pinnedResult.sample.networks.map((device) => device.deviceId),
    ["virtual:bond0", "virtual:eth2", "virtual:tp0"],
  );
});

test("LinuxMetricsCollector leaves the sample untruncated when no capability plan has been received", async () => {
  const snapshot = fullTopologySnapshot({
    networks: [
      {
        deviceId: "virtual:bond0",
        kind: "uplink",
        name: "bond0",
        identity: { virtualKey: "bond0" },
      },
      {
        deviceId: "virtual:eth2",
        kind: "uplink",
        name: "eth2",
        identity: { virtualKey: "eth2" },
        defaultRoute: true,
      },
      {
        deviceId: "virtual:tp0",
        kind: "fabric",
        name: "tp0",
        identity: { virtualKey: "tp0" },
      },
    ],
  });
  const collector = new LinuxMetricsCollector(
    {
      ...makeDeps(() => TICK_1, snapshot, () => 1_000_000),
      resolveTopologyOverrides: () =>
        Promise.resolve({
          nicSlotDeviceIds: ["virtual:bond0", "virtual:eth2"],
          hostingFilesystemId: null,
          drivetempEnabled: false,
        }),
    },
    { nominalIntervalSeconds: 60 },
  );
  const result = await collector.collect({ sequence: 1, nowMs: 1_000_000 });
  if (!result.supported) throw new TypeError("expected a supported sample");
  assertEquals(
    result.sample.networks.map((device) => device.deviceId),
    ["virtual:bond0", "virtual:eth2", "virtual:tp0"],
  );
});

test("LinuxMetricsCollector truncates the sample to the persisted capability plan in SlotMapping order", async () => {
  const snapshot = fullTopologySnapshot({
    networks: [
      {
        deviceId: "virtual:bond0",
        kind: "uplink",
        name: "bond0",
        identity: { virtualKey: "bond0" },
      },
      {
        deviceId: "virtual:eth2",
        kind: "uplink",
        name: "eth2",
        identity: { virtualKey: "eth2" },
        defaultRoute: true,
      },
      {
        deviceId: "virtual:tp0",
        kind: "fabric",
        name: "tp0",
        identity: { virtualKey: "tp0" },
      },
    ],
  });
  const collector = new LinuxMetricsCollector(
    {
      ...makeDeps(() => TICK_1, snapshot, () => 1_000_000),
      resolveTopologyOverrides: () =>
        Promise.resolve({
          nicSlotDeviceIds: ["virtual:bond0", "virtual:eth2"],
          hostingFilesystemId: null,
          drivetempEnabled: false,
        }),
      resolveCapabilityPlan: () =>
        Promise.resolve({
          generation: 1,
          plan: {
            ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
            normalNicSlots: 1,
            turboFabricEnabled: false,
          },
        }),
    },
    { nominalIntervalSeconds: 60 },
  );
  const result = await collector.collect({ sequence: 1, nowMs: 1_000_000 });
  if (!result.supported) throw new TypeError("expected a supported sample");
  assertEquals(
    result.sample.networks.map((device) => device.deviceId),
    ["virtual:bond0"],
  );
});

const NULL_GPU_ADAPTERS: GpuAdapterSet = {
  dcgm: {
    id: "dcgm",
    probe: () => Promise.resolve(),
    read: () => Promise.resolve(null),
  },
  nvml: {
    id: "nvml",
    probe: () => Promise.resolve(),
    read: () => Promise.resolve(null),
  },
  sysfs: {
    id: "sysfs",
    probe: () => Promise.resolve(),
    read: () => Promise.resolve(null),
  },
};

function pageOrderMismatchSnapshot(): TopologySnapshot {
  return fullTopologySnapshot({
    gpus: [
      {
        gpuId: "pci:z",
        kind: "drm",
        pciPath: "0000:03:00.0",
        vendor: "amd",
        chip: "amdgpu",
      },
      {
        gpuId: "pci:a",
        kind: "drm",
        pciPath: "0000:01:00.0",
        vendor: "amd",
        chip: "amdgpu",
      },
      {
        gpuId: "pci:m",
        kind: "drm",
        pciPath: "0000:02:00.0",
        vendor: "amd",
        chip: "amdgpu",
      },
    ],
    blockDevices: [
      {
        deviceId: "blk:zda",
        kernelName: "zda",
        deviceType: "physical",
        isServiceDevice: true,
      },
      {
        deviceId: "blk:ada",
        kernelName: "ada",
        deviceType: "physical",
        isServiceDevice: true,
      },
      {
        deviceId: "blk:mda",
        kernelName: "mda",
        deviceType: "physical",
        isServiceDevice: true,
      },
    ],
    filesystems: [
      {
        filesystemId: "fs:z",
        mountpoint: "/z",
        fsType: "ext4",
        sourceDevice: "/dev/zda1",
        totalBytes: null,
        totalInodes: null,
        roles: [],
      },
      {
        filesystemId: "fs:root",
        mountpoint: "/",
        fsType: "ext4",
        sourceDevice: "/dev/sda1",
        totalBytes: null,
        totalInodes: null,
        roles: ["root"],
      },
      {
        filesystemId: "fs:a",
        mountpoint: "/a",
        fsType: "ext4",
        sourceDevice: "/dev/ada1",
        totalBytes: null,
        totalInodes: null,
        roles: [],
      },
      {
        filesystemId: "fs:m",
        mountpoint: "/m",
        fsType: "ext4",
        sourceDevice: "/dev/mda1",
        totalBytes: null,
        totalInodes: null,
        roles: ["hosting"],
      },
    ],
    hardwareSignals: [
      {
        signalId: "signal:cpu:package",
        kind: "temperature",
        unit: "C",
        component: "cpu",
        label: "package",
      },
      {
        signalId: "signal:board:inlet",
        kind: "temperature",
        unit: "C",
        component: "board",
        label: "inlet",
      },
      {
        signalId: "signal:dimm:a",
        kind: "temperature",
        unit: "C",
        component: "memory",
        label: "dimm-a",
      },
    ] satisfies PhysicalSignalTopology[],
  });
}

test("LinuxMetricsCollector keeps the full sample after enroll when no capability plan is persisted", async () => {
  const snapshot = pageOrderMismatchSnapshot();
  const collector = new LinuxMetricsCollector({
    ...makeDeps(() => TICK_1, snapshot, () => 1_000_000),
    gpuAdapters: NULL_GPU_ADAPTERS,
  });
  const result = await collector.collect({ sequence: 1, nowMs: 1_000_000 });
  if (!result.supported) throw new TypeError("expected a supported sample");
  assertEquals(
    result.sample.gpus.map((gpu) => gpu.gpuId),
    ["pci:z", "pci:a", "pci:m"],
  );
  assertEquals(
    result.sample.blockDevices.map((device) => device.deviceId),
    ["blk:zda", "blk:ada", "blk:mda"],
  );
  assertEquals(
    result.sample.filesystems.map((fs) => fs.filesystemId),
    ["fs:z", "fs:a", "fs:m"],
  );
  assertEquals(
    result.sample.hardwareSignals.map((signal) => signal.signalId),
    ["signal:cpu:package", "signal:board:inlet", "signal:dimm:a"],
  );
});

test("LinuxMetricsCollector does not truncate a leftover plan when skipCapabilityPlanTruncation is set", async () => {
  const snapshot = pageOrderMismatchSnapshot();
  const collector = new LinuxMetricsCollector({
    ...makeDeps(() => TICK_1, snapshot, () => 1_000_000),
    gpuAdapters: NULL_GPU_ADAPTERS,
    skipCapabilityPlanTruncation: true,
    resolveCapabilityPlan: () =>
      Promise.resolve({
        generation: 1,
        plan: {
          ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
          gpuSlots: 1,
          extraFilesystemSlots: 0,
          detailedBlockDeviceSlots: 1,
          physicalHardwareSignalSlots: 1,
        },
      }),
  });
  const result = await collector.collect({ sequence: 1, nowMs: 1_000_000 });
  if (!result.supported) throw new TypeError("expected a supported sample");
  assertEquals(
    result.sample.gpus.map((gpu) => gpu.gpuId),
    ["pci:z", "pci:a", "pci:m"],
  );
  assertEquals(
    result.sample.blockDevices.map((device) => device.deviceId),
    ["blk:zda", "blk:ada", "blk:mda"],
  );
  assertEquals(
    result.sample.filesystems.map((fs) => fs.filesystemId),
    ["fs:z", "fs:a", "fs:m"],
  );
  assertEquals(
    result.sample.hardwareSignals.map((signal) => signal.signalId),
    ["signal:cpu:package", "signal:board:inlet", "signal:dimm:a"],
  );
});

test("LinuxMetricsCollector truncates GPUs, filesystems, block devices, and signals in SlotMapping page order", async () => {
  const snapshot = pageOrderMismatchSnapshot();
  const plan = {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    gpuSlots: 2,
    extraFilesystemSlots: 2,
    detailedBlockDeviceSlots: 2,
    physicalHardwareSignalSlots: 2,
  };
  const mapping = computeSlotMapping(snapshot, EMPTY_TOPOLOGY_OVERRIDES);
  const collector = new LinuxMetricsCollector({
    ...makeDeps(() => TICK_1, snapshot, () => 1_000_000),
    gpuAdapters: NULL_GPU_ADAPTERS,
    resolveCapabilityPlan: () => Promise.resolve({ generation: 2, plan }),
  });
  const result = await collector.collect({ sequence: 1, nowMs: 1_000_000 });
  if (!result.supported) throw new TypeError("expected a supported sample");
  assertEquals(
    result.sample.gpus.map((gpu) => gpu.gpuId),
    mapping.gpuPageOrder.slice(0, plan.gpuSlots),
  );
  assertEquals(
    result.sample.blockDevices.map((device) => device.deviceId),
    mapping.blockPageOrder.slice(0, plan.detailedBlockDeviceSlots),
  );
  assertEquals(
    result.sample.filesystems.map((fs) => fs.filesystemId),
    mapping.filesystemPageOrder
      .filter((id) => id !== mapping.rootFilesystemId)
      .slice(0, plan.extraFilesystemSlots),
  );
  assertEquals(
    result.sample.hardwareSignals.map((signal) => signal.signalId),
    mapping.hardwareSignalPageOrder.slice(
      0,
      plan.physicalHardwareSignalSlots,
    ),
  );
  // Arrival order would have kept pci:z / blk:zda / fs:z / signal:cpu:package.
  assertEquals(result.sample.gpus[0]?.gpuId, "pci:a");
  assertEquals(result.sample.blockDevices[0]?.deviceId, "blk:ada");
  assertEquals(result.sample.filesystems[0]?.filesystemId, "fs:m");
  assertEquals(
    result.sample.hardwareSignals[0]?.signalId,
    "signal:board:inlet",
  );
});

test("LinuxMetricsCollector carries the managed-engine census into storage verbatim once it lands", async () => {
  const snapshot = fullTopologySnapshot();
  const nowMs = 1_000_000;
  const directoryUsage = () => ({
    hosting: { usedBytes: 4096, freeBytes: 1000 },
    backup: { usedBytes: 2048, freeBytes: 2000 },
    logs: { usedBytes: 512, freeBytes: 3000 },
    computedAtMs: nowMs,
  });

  // Census sampler wired but its first read not landed: still all null.
  const pending = new LinuxMetricsCollector({
    ...makeDeps(() => TICK_1, snapshot, () => nowMs),
    directoryUsage,
    managedEngines: () => null,
  });
  const pendingResult = await pending.collect({ sequence: 1, nowMs });
  if (!pendingResult.supported) {
    throw new TypeError("expected a supported sample");
  }
  assertEquals(pendingResult.sample.storage?.postgres.instancesRunning, null);
  assertEquals(pendingResult.sample.storage?.mysql.instancesHealthy, null);

  const collector = new LinuxMetricsCollector({
    ...makeDeps(() => TICK_1, snapshot, () => nowMs),
    directoryUsage,
    managedEngines: () => ({
      postgres: {
        instancesRunning: 2,
        instancesHealthy: 1,
        connectionsUsed: 7,
        connectionsMax: 200,
      },
      // Present but stopped: real zeros, connections unknown.
      mysql: {
        instancesRunning: 0,
        instancesHealthy: 0,
        connectionsUsed: null,
        connectionsMax: null,
      },
      // Not on this host at all.
      mariadb: {
        instancesRunning: null,
        instancesHealthy: null,
        connectionsUsed: null,
        connectionsMax: null,
      },
    }),
  });
  const result = await collector.collect({ sequence: 1, nowMs });
  if (!result.supported) throw new TypeError("expected a supported sample");
  const storage = result.sample.storage;
  if (!storage) throw new TypeError("expected storage");
  // Engines present on the host ship real numbers, including a real zero.
  assertEquals(storage.postgres, {
    instancesRunning: 2,
    instancesHealthy: 1,
    connectionsUsed: 7,
    connectionsMax: 200,
  });
  assertEquals(storage.mysql.instancesRunning, 0);
  assertEquals(storage.mysql.instancesHealthy, 0);
  assertEquals(storage.mysql.connectionsUsed, null);
  // An engine the host does not run stays null, never 0.
  assertEquals(storage.mariadb.instancesRunning, null);
  // The byte fields ride beside the census on the same row.
  assertEquals(storage.hostingUsedBytes, 4096);
});
