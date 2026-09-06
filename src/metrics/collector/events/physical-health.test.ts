import { assertEquals } from "@std/assert";
import { CounterBaselineTracker } from "../baseline.ts";
import { PhysicalHealthEventCollector } from "./physical-health.ts";
import type {
  EventDetectContext,
  HardwareSignalCandidateMap,
} from "./types.ts";
import type {
  PhysicalSignalTopology,
  TopologySnapshot,
} from "../../topology/types.ts";
import type { SensorIo } from "../sensors/discovery.ts";
import type { SensorCandidate } from "../types.ts";

const test = Deno.test.bind(Deno);

const FAN_SIGNAL: PhysicalSignalTopology = {
  signalId: "signal:nct6775:fan1",
  kind: "fan",
  unit: "rpm",
  component: "system",
  label: "fan1",
};
const TEMP_SIGNAL: PhysicalSignalTopology = {
  signalId: "signal:coretemp:Package id 0",
  kind: "temperature",
  unit: "celsius",
  component: "cpu",
  label: "Package id 0",
  thresholds: { warning: 80, critical: 95 },
};

const FAN_CANDIDATE: SensorCandidate = {
  chip: "nct6775",
  label: "fan1",
  path: "/sys/class/hwmon/hwmon1/fan1_input",
};
const TEMP_CANDIDATE: SensorCandidate = {
  chip: "coretemp",
  label: "Package id 0",
  path: "/sys/class/hwmon/hwmon0/temp1_input",
};

function candidates(): HardwareSignalCandidateMap {
  return new Map([
    [FAN_SIGNAL.signalId, FAN_CANDIDATE],
    [TEMP_SIGNAL.signalId, TEMP_CANDIDATE],
  ]);
}

function snapshot(signals: PhysicalSignalTopology[]): TopologySnapshot {
  return {
    generation: 1,
    bootGeneration: 1,
    networks: [],
    filesystems: [],
    blockDevices: [],
    gpus: [],
    hardwareSignals: signals,
    cpu: {
      sockets: 1,
      coresPerSocket: 1,
      threadsPerSocket: 1,
      model: null,
      cores: [],
    },
    numaNodes: [],
    memoryTotalBytes: null,
    swapTotalBytes: null,
  };
}

function memoryIo(
  files: Record<string, string | undefined>,
  dirs: Record<string, string[]> = {},
): SensorIo {
  return {
    listDir: (path) => dirs[path] ?? [],
    readFile: (path) => files[path],
  };
}

function ctx(overrides: Partial<EventDetectContext> = {}): EventDetectContext {
  return {
    nowMs: 0,
    snapshot: snapshot([FAN_SIGNAL, TEMP_SIGNAL]),
    tracker: new CounterBaselineTracker(),
    bootGeneration: 1,
    seconds: 60,
    gpus: [],
    hardwareSignals: [
      { signalId: TEMP_SIGNAL.signalId, kind: "temperature", value: 50 },
    ],
    hardwareSignalCandidates: candidates(),
    oomKillTotal: null,
    conntrackUsedPercent: null,
    mountEntries: [],
    mdstatText: undefined,
    io: memoryIo({}),
    isPhysical: true,
    ...overrides,
  };
}

test("PhysicalHealthEventCollector: a VM (isPhysical false) never reads sysfs and never fires", async () => {
  const collector = new PhysicalHealthEventCollector();
  let read = false;
  const io: SensorIo = {
    listDir: () => {
      read = true;
      return [];
    },
    readFile: () => {
      read = true;
      return undefined;
    },
  };
  const events = await collector.detect(ctx({ isPhysical: false, io }));
  assertEquals(events, []);
  assertEquals(read, false);
});

test("PhysicalHealthEventCollector: fan fault still fires even when the topology's hardwareSignals carries no fan entries (narrowed physical-signal catalog)", async () => {
  const collector = new PhysicalHealthEventCollector();
  // Topology's sampled catalog only carries the CPU temperature — fans are
  // no longer projected into `hardwareSignals` (see `hardware-signal-topology.ts`),
  // but the fault sweep must still work from the broad candidate map alone.
  const noFanSnapshot = snapshot([TEMP_SIGNAL]);
  await collector.detect(
    ctx({
      snapshot: noFanSnapshot,
      io: memoryIo({ "/sys/class/hwmon/hwmon1/fan1_fault": "0" }),
    }),
  );
  const events = await collector.detect(
    ctx({
      snapshot: noFanSnapshot,
      io: memoryIo({ "/sys/class/hwmon/hwmon1/fan1_fault": "1" }),
      nowMs: 1_000,
    }),
  );
  assertEquals(events.some((e) => e.kind === "fan_fault"), true);
});

test("PhysicalHealthEventCollector: fan fault transitioning active fires fan_fault", async () => {
  const collector = new PhysicalHealthEventCollector();
  await collector.detect(
    ctx({ io: memoryIo({ "/sys/class/hwmon/hwmon1/fan1_fault": "0" }) }),
  );
  const events = await collector.detect(
    ctx({
      io: memoryIo({ "/sys/class/hwmon/hwmon1/fan1_fault": "1" }),
      nowMs: 1_000,
    }),
  );
  assertEquals(events.some((e) => e.kind === "fan_fault"), true);
});

test("PhysicalHealthEventCollector: temperature crossing critical fires temp_critical, not temp_alarm", async () => {
  const collector = new PhysicalHealthEventCollector();
  await collector.detect(ctx({
    hardwareSignals: [
      { signalId: TEMP_SIGNAL.signalId, kind: "temperature", value: 50 },
    ],
  }));
  const events = await collector.detect(ctx({
    hardwareSignals: [
      { signalId: TEMP_SIGNAL.signalId, kind: "temperature", value: 96 },
    ],
    nowMs: 1_000,
  }));
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "temp_critical");
});

test("PhysicalHealthEventCollector: temperature crossing warning-only fires temp_alarm", async () => {
  const collector = new PhysicalHealthEventCollector();
  await collector.detect(ctx({
    hardwareSignals: [
      { signalId: TEMP_SIGNAL.signalId, kind: "temperature", value: 50 },
    ],
  }));
  const events = await collector.detect(ctx({
    hardwareSignals: [
      { signalId: TEMP_SIGNAL.signalId, kind: "temperature", value: 85 },
    ],
    nowMs: 1_000,
  }));
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "temp_alarm");
});

test("PhysicalHealthEventCollector: sustained critical temperature never re-fires", async () => {
  const collector = new PhysicalHealthEventCollector();
  await collector.detect(ctx({
    hardwareSignals: [
      { signalId: TEMP_SIGNAL.signalId, kind: "temperature", value: 96 },
    ],
  }));
  const events = await collector.detect(ctx({
    hardwareSignals: [
      { signalId: TEMP_SIGNAL.signalId, kind: "temperature", value: 97 },
    ],
    nowMs: 1_000,
  }));
  assertEquals(events, []);
});

test("PhysicalHealthEventCollector: a voltage alarm file discovered under a known hwmon dir fires voltage_alarm", async () => {
  const collector = new PhysicalHealthEventCollector();
  const dirs = { "/sys/class/hwmon/hwmon0": ["in0_alarm"] };
  await collector.detect(
    ctx({ io: memoryIo({ "/sys/class/hwmon/hwmon0/in0_alarm": "0" }, dirs) }),
  );
  const events = await collector.detect(
    ctx({
      io: memoryIo({ "/sys/class/hwmon/hwmon0/in0_alarm": "1" }, dirs),
      nowMs: 1_000,
    }),
  );
  assertEquals(events.some((e) => e.kind === "voltage_alarm"), true);
});

test("PhysicalHealthEventCollector: a power-alarm file fires psu_fault", async () => {
  const collector = new PhysicalHealthEventCollector();
  const dirs = { "/sys/class/hwmon/hwmon0": ["power1_alarm"] };
  await collector.detect(
    ctx({
      io: memoryIo({ "/sys/class/hwmon/hwmon0/power1_alarm": "0" }, dirs),
    }),
  );
  const events = await collector.detect(
    ctx({
      io: memoryIo({ "/sys/class/hwmon/hwmon0/power1_alarm": "1" }, dirs),
      nowMs: 1_000,
    }),
  );
  assertEquals(events.some((e) => e.kind === "psu_fault"), true);
});
