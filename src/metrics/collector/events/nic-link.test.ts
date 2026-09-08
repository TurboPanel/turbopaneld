import { assertEquals } from "@std/assert";
import { CounterBaselineTracker } from "../baseline.ts";
import { NicLinkEventCollector } from "./nic-link.ts";
import type { EventDetectContext } from "./types.ts";
import type {
  NetworkDeviceTopology,
  TopologySnapshot,
} from "../../topology/types.ts";
import type { SensorIo } from "../sensors/discovery.ts";

const test = Deno.test.bind(Deno);

const ETH0: NetworkDeviceTopology = {
  deviceId: "mac:aa:bb:cc:dd:ee:00",
  kind: "uplink",
  name: "eth0",
  identity: { mac: "aa:bb:cc:dd:ee:00" },
};
const VETH: NetworkDeviceTopology = {
  deviceId: "virtual:1234",
  kind: "container-bridge",
  name: "veth123",
  identity: { virtualKey: "1234" },
};

function snapshot(networks: NetworkDeviceTopology[]): TopologySnapshot {
  return {
    generation: 1,
    bootGeneration: 1,
    networks,
    filesystems: [],
    blockDevices: [],
    gpus: [],
    hardwareSignals: [],
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

function operstateIo(state: string | undefined): SensorIo {
  return {
    listDir: () => [],
    readFile: (path) =>
      path === "/sys/class/net/eth0/operstate" ? state : undefined,
  };
}

function ctx(overrides: Partial<EventDetectContext> = {}): EventDetectContext {
  return {
    nowMs: 0,
    snapshot: snapshot([ETH0]),
    tracker: new CounterBaselineTracker(),
    bootGeneration: 1,
    seconds: 60,
    gpus: [],
    gpuThermals: new Map(),
    hardwareSignals: [],
    hardwareSignalCandidates: new Map(),
    oomKillTotal: null,
    conntrackUsedPercent: null,
    mountEntries: [],
    mdstatText: undefined,
    io: operstateIo("up"),
    isPhysical: true,
    ...overrides,
  };
}

test("NicLinkEventCollector: first tick establishes the baseline, no fabricated event", async () => {
  const collector = new NicLinkEventCollector();
  assertEquals(await collector.detect(ctx({ io: operstateIo("up") })), []);
});

test("NicLinkEventCollector: up -> down fires nic_link_down", async () => {
  const collector = new NicLinkEventCollector();
  await collector.detect(ctx({ io: operstateIo("up"), nowMs: 0 }));
  const events = await collector.detect(
    ctx({ io: operstateIo("down"), nowMs: 1_000 }),
  );
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "nic_link_down");
});

test("NicLinkEventCollector: down -> up fires nic_link_up", async () => {
  const collector = new NicLinkEventCollector();
  await collector.detect(ctx({ io: operstateIo("down"), nowMs: 0 }));
  const events = await collector.detect(
    ctx({ io: operstateIo("up"), nowMs: 1_000 }),
  );
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "nic_link_up");
});

test("NicLinkEventCollector: transitioning to unknown never fires nic_link_down", async () => {
  const collector = new NicLinkEventCollector();
  await collector.detect(ctx({ io: operstateIo("up"), nowMs: 0 }));
  const events = await collector.detect(
    ctx({ io: operstateIo("unknown"), nowMs: 1_000 }),
  );
  assertEquals(events, []);
});

test("NicLinkEventCollector: repeated down/up flaps within the window fire nic_flapping", async () => {
  const collector = new NicLinkEventCollector();
  let nowMs = 0;
  await collector.detect(ctx({ io: operstateIo("up"), nowMs }));
  let lastEvents: Awaited<ReturnType<typeof collector.detect>> = [];
  for (let i = 0; i < 4; i++) {
    nowMs += 1_000;
    lastEvents = await collector.detect(
      ctx({ io: operstateIo("down"), nowMs }),
    );
    nowMs += 1_000;
    await collector.detect(ctx({ io: operstateIo("up"), nowMs }));
  }
  assertEquals(lastEvents.some((e) => e.kind === "nic_flapping"), true);
});

test("NicLinkEventCollector: container-bridge/loopback devices are never watched", async () => {
  const collector = new NicLinkEventCollector();
  let reads = 0;
  const io: SensorIo = {
    listDir: () => [],
    readFile: () => {
      reads++;
      return undefined;
    },
  };
  await collector.detect(ctx({ snapshot: snapshot([VETH]), io }));
  assertEquals(reads, 0);
});

test("NicLinkEventCollector: unreadable operstate is skipped, not treated as down", async () => {
  const collector = new NicLinkEventCollector();
  await collector.detect(ctx({ io: operstateIo("up"), nowMs: 0 }));
  const events = await collector.detect(
    ctx({ io: operstateIo(undefined), nowMs: 1_000 }),
  );
  assertEquals(events, []);
});
