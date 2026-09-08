import { assertEquals } from "@std/assert";

import {
  type MetricsCapabilityPlan,
  PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
} from "./capability-plan.ts";
import { truncateSampleToCapabilityPlan } from "./capability-plan-truncate.ts";
import type { MetricsSample } from "./contract.ts";
import type { SlotMapping } from "./topology/types.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function emptySample(): MetricsSample {
  return {
    type: "metrics",
    metadata: {
      version: 6,
      sampledAt: "2026-01-01T00:00:00.000Z",
      intervalSeconds: 60,
      sequence: 0,
      topologyGeneration: 0,
      bootGeneration: 0,
    },
    host: {
      cpu: {
        busyPercent: null,
        userPercent: null,
        systemPercent: null,
        iowaitPercent: null,
        stealPercent: null,
        softirqPercent: null,
        pressureSomePercent: null,
        saturatedCoreCount: null,
        procsRunning: null,
        procsBlocked: null,
        processCount: null,
      },
      kernel: { fileHandlesUsedPercent: null, conntrackUsedPercent: null },
      memory: {
        usedBytes: null,
        cachedFilesBytes: null,
        swapUsedBytes: null,
        pressureSomePercent: null,
        pressureFullPercent: null,
        swapInBytesPerSecond: null,
        swapOutBytesPerSecond: null,
        majorPageFaultsPerSecond: null,
      },
      storage: {
        ioPressureSomePercent: null,
        ioPressureFullPercent: null,
        diskReadBytesPerSecond: null,
        diskWriteBytesPerSecond: null,
        diskLatencyMs: null,
        rootFilesystemAvailableBytes: null,
        rootFilesystemFreeInodes: null,
      },
      network: { tcpRetransmitPercent: null, softnetDropsPerSecond: null },
    },
    networks: [],
    filesystems: [],
    blockDevices: [],
    gpus: [],
    hardwareSignals: [],
    ingressSources: [],
    databaseProxies: [],
    events: [],
  };
}

function makeGpu(gpuId: string) {
  return {
    gpuId,
    utilizationPercent: null,
    memoryUsedBytes: null,
    memoryActivityPercent: null,
    pcieReceiveBytesPerSecond: null,
    pcieTransmitBytesPerSecond: null,
    throttlePercent: null,
  };
}

function makeNetwork(deviceId: string): MetricsSample["networks"][number] {
  return {
    deviceId,
    receiveBytesPerSecond: 1,
    transmitBytesPerSecond: 1,
    receiveErrorsPerSecond: 0,
    transmitErrorsPerSecond: 0,
    receiveDropsPerSecond: 0,
    transmitDropsPerSecond: 0,
  };
}

function makeRouter() {
  return {
    backendsUp: 1,
    backendsTotal: 2,
    servicesTotal: 3,
    routersTotal: 4,
    retries: 0,
    backendErrors5xx: 0,
    backendLatencyMsAvg: 5,
    backendRequests: 10,
    httpOpenConnections: 2,
    configReloads: 1,
    configLastReloadAgeSeconds: 30,
    tlsCertSoonestExpiryDays: 60,
  };
}

function makeDockerUsage() {
  return {
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
  };
}

function emptySlotMapping(overrides: Partial<SlotMapping> = {}): SlotMapping {
  return {
    normalNicSlots: [],
    fabricDeviceIds: [],
    rootFilesystemId: null,
    gpuPageOrder: [],
    blockPageOrder: [],
    filesystemPageOrder: [],
    hardwareSignalPageOrder: [],
    ...overrides,
  };
}

function makeFilesystem(filesystemId: string) {
  return { filesystemId, availableBytes: null, freeInodes: null };
}

function makeBlockDevice(deviceId: string) {
  return {
    deviceId,
    readBytesPerSecond: null,
    writeBytesPerSecond: null,
    readOpsPerSecond: null,
    writeOpsPerSecond: null,
    readLatencyMs: null,
    writeLatencyMs: null,
    utilizationPercent: null,
    queueDepth: null,
  };
}

function makeHardwareSignal(signalId: string) {
  return { signalId, kind: "temp", unit: "C", value: null };
}

test("truncateSampleToCapabilityPlan: 2 discovered GPUs with gpuSlots=1 keeps the first only", () => {
  const plan: MetricsCapabilityPlan = {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    gpuSlots: 1,
  };
  const sample = emptySample();
  sample.gpus = [makeGpu("gpu-0"), makeGpu("gpu-1")];
  const truncated = truncateSampleToCapabilityPlan(sample, plan);
  assertEquals(
    truncated.gpus.map((g) => g.gpuId),
    ["gpu-0"],
  );
});

test("truncateSampleToCapabilityPlan: managedIngressEnabled gates router by omitting the key", () => {
  const sample = emptySample();
  sample.router = makeRouter();
  const dropped = truncateSampleToCapabilityPlan(sample, {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    managedIngressEnabled: false,
  });
  assertEquals(dropped.router, undefined);
  assertEquals(Object.hasOwn(dropped, "router"), false);
});

test("truncateSampleToCapabilityPlan: managedDockerEnabled gates dockerUsage by omitting the key", () => {
  const sample = emptySample();
  sample.dockerUsage = makeDockerUsage();
  const dropped = truncateSampleToCapabilityPlan(sample, {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    managedDockerEnabled: false,
  });
  assertEquals(dropped.dockerUsage, undefined);
  assertEquals(Object.hasOwn(dropped, "dockerUsage"), false);
});

test("truncateSampleToCapabilityPlan: networks keeps slot-mapped NICs within normalNicSlots plus fabric", () => {
  const sample: MetricsSample = {
    ...emptySample(),
    networks: ["veth9", "eth2", "tp0", "eth0", "eth1"].map(makeNetwork),
  };
  const plan: MetricsCapabilityPlan = {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    normalNicSlots: 2,
    turboFabricEnabled: true,
  };
  const mapping = emptySlotMapping({
    normalNicSlots: ["eth0", "eth1", "eth2"],
    fabricDeviceIds: ["tp0"],
  });
  assertEquals(
    truncateSampleToCapabilityPlan(sample, plan, mapping).networks.map(
      (n) => n.deviceId,
    ),
    ["eth0", "eth1", "tp0"],
  );

  const noFabric: MetricsCapabilityPlan = {
    ...plan,
    turboFabricEnabled: false,
  };
  assertEquals(
    truncateSampleToCapabilityPlan(sample, noFabric, mapping).networks.map(
      (n) => n.deviceId,
    ),
    ["eth0", "eth1"],
  );
});

test("truncateSampleToCapabilityPlan: without a slot mapping, networks fall back to the first normalNicSlots entries", () => {
  const sample: MetricsSample = {
    ...emptySample(),
    networks: ["eth0", "eth1", "eth2"].map(makeNetwork),
  };
  const plan: MetricsCapabilityPlan = {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    normalNicSlots: 2,
  };
  assertEquals(
    truncateSampleToCapabilityPlan(sample, plan).networks.map((n) =>
      n.deviceId
    ),
    ["eth0", "eth1"],
  );
});

test("truncateSampleToCapabilityPlan: GPUs keep SlotMapping page order, not arrival order", () => {
  const plan: MetricsCapabilityPlan = {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    gpuSlots: 2,
  };
  const sample = emptySample();
  sample.gpus = [makeGpu("pci:z"), makeGpu("pci:a"), makeGpu("pci:m")];
  const truncated = truncateSampleToCapabilityPlan(
    sample,
    plan,
    emptySlotMapping({ gpuPageOrder: ["pci:a", "pci:m", "pci:z"] }),
  );
  assertEquals(
    truncated.gpus.map((g) => g.gpuId),
    ["pci:a", "pci:m"],
  );
});

test("truncateSampleToCapabilityPlan: block devices keep SlotMapping page order, not arrival order", () => {
  const plan: MetricsCapabilityPlan = {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    detailedBlockDeviceSlots: 2,
  };
  const sample = emptySample();
  sample.blockDevices = [
    makeBlockDevice("disk:z"),
    makeBlockDevice("disk:a"),
    makeBlockDevice("disk:m"),
  ];
  const truncated = truncateSampleToCapabilityPlan(
    sample,
    plan,
    emptySlotMapping({ blockPageOrder: ["disk:a", "disk:m", "disk:z"] }),
  );
  assertEquals(
    truncated.blockDevices.map((d) => d.deviceId),
    ["disk:a", "disk:m"],
  );
});

test("truncateSampleToCapabilityPlan: filesystems keep SlotMapping page order, not arrival order", () => {
  const plan: MetricsCapabilityPlan = {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    extraFilesystemSlots: 2,
  };
  const sample = emptySample();
  sample.filesystems = [
    makeFilesystem("fs:z"),
    makeFilesystem("fs:root"),
    makeFilesystem("fs:a"),
    makeFilesystem("fs:m"),
  ];
  const truncated = truncateSampleToCapabilityPlan(
    sample,
    plan,
    emptySlotMapping({
      rootFilesystemId: "fs:root",
      filesystemPageOrder: ["fs:root", "fs:a", "fs:m", "fs:z"],
    }),
  );
  assertEquals(
    truncated.filesystems.map((f) => f.filesystemId),
    ["fs:a", "fs:m"],
  );
});

test("truncateSampleToCapabilityPlan: hardware signals keep SlotMapping page order, not arrival order", () => {
  const plan: MetricsCapabilityPlan = {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    physicalHardwareSignalSlots: 2,
  };
  const sample = emptySample();
  // Category/discovery order (CPU then board) differs from signalId sort.
  sample.hardwareSignals = [
    makeHardwareSignal("signal:cpu:package"),
    makeHardwareSignal("signal:board:inlet"),
    makeHardwareSignal("signal:dimm:a"),
  ];
  const truncated = truncateSampleToCapabilityPlan(
    sample,
    plan,
    emptySlotMapping({
      hardwareSignalPageOrder: [
        "signal:board:inlet",
        "signal:cpu:package",
        "signal:dimm:a",
      ],
    }),
  );
  assertEquals(
    truncated.hardwareSignals.map((s) => s.signalId),
    ["signal:board:inlet", "signal:cpu:package"],
  );
});

test("truncateSampleToCapabilityPlan: a root-tagged filesystem is dropped before extraFilesystemSlots applies", () => {
  const plan: MetricsCapabilityPlan = {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    extraFilesystemSlots: 1,
  };
  const sample = emptySample();
  sample.filesystems = [
    { filesystemId: "fs-root", availableBytes: null, freeInodes: null },
    { filesystemId: "fs-data", availableBytes: null, freeInodes: null },
  ];
  const truncated = truncateSampleToCapabilityPlan(
    sample,
    plan,
    emptySlotMapping({ rootFilesystemId: "fs-root" }),
  );
  assertEquals(
    truncated.filesystems.map((f) => f.filesystemId),
    ["fs-data"],
  );
});

test("truncateSampleToCapabilityPlan: hardwareHealthEventsEnabled=false drops only hardware-health kinds", () => {
  const sample = emptySample();
  sample.events = [
    {
      eventId: "e1",
      at: "2026-01-01T00:00:00.000Z",
      kind: "smart_critical",
      severity: "warning",
    },
    {
      eventId: "e2",
      at: "2026-01-01T00:00:00.000Z",
      kind: "oom_kill",
      severity: "critical",
    },
  ];
  const truncated = truncateSampleToCapabilityPlan(sample, {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    hardwareHealthEventsEnabled: false,
  });
  assertEquals(
    truncated.events.map((event) => event.kind),
    ["oom_kill"],
  );
});

test("truncateSampleToCapabilityPlan: databaseProxyMetricsEnabled=false drops proxies", () => {
  const sample = emptySample();
  sample.databaseProxies = [{
    sourceId: "proxysql",
    sourceKind: "proxysql",
    queries: null,
    slowQueries: null,
    queryLatencyMsAvg: null,
    backendLatencyMsAvg: null,
    activeTransactions: null,
    clientConnections: null,
    clientConnectionsCreated: null,
    clientConnectionsAborted: null,
    connectionsRejectedMaxConns: null,
    backendConnections: null,
    backendConnectionsCreated: null,
    backendConnectionsAborted: null,
    connectionErrors: null,
    backendsUp: null,
    backendsTotal: null,
    bytesFromBackends: null,
    bytesToBackends: null,
  }];
  const truncated = truncateSampleToCapabilityPlan(sample, {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    databaseProxyMetricsEnabled: false,
  });
  assertEquals(truncated.databaseProxies, []);
});
