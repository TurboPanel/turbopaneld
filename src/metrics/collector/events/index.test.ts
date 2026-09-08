import { assertEquals } from "@std/assert";
import { CounterBaselineTracker } from "../baseline.ts";
import { EventCollectorSet } from "./index.ts";
import type { EventDetectContext } from "./types.ts";
import type { TopologySnapshot } from "../../topology/types.ts";

const test = Deno.test.bind(Deno);

function snapshot(): TopologySnapshot {
  return {
    generation: 1,
    bootGeneration: 1,
    networks: [],
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

function baseCtx(
  overrides: Partial<Omit<EventDetectContext, "isPhysical">> = {},
): Omit<EventDetectContext, "isPhysical"> {
  return {
    nowMs: 1_000,
    snapshot: snapshot(),
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
    io: { listDir: () => [], readFile: () => undefined },
    ...overrides,
  };
}

test("EventCollectorSet: a normal, quiet tick produces no events", async () => {
  const set = new EventCollectorSet({
    gpuHealthReader: () =>
      Promise.resolve({
        eccDoubleBitAggregateTotal: null,
        lastXidErrorCode: null,
        remappedRows: null,
        retiredPagesPending: null,
      }),
    fabricStateReader: () => [],
    clockSyncReader: () => undefined,
    kernelLogReader: () => Promise.resolve([]),
    smartRunner: () => Promise.resolve(null),
  });
  const events = await set.detect(baseCtx());
  assertEquals(events, []);
});

test("EventCollectorSet: one sub-collector throwing never drops the others' events", async () => {
  const set = new EventCollectorSet({
    gpuHealthReader: () => Promise.reject(new Error("nvml boom")),
    fabricStateReader: () => [],
    clockSyncReader: () => undefined,
    kernelLogReader: () => Promise.reject(new Error("dmesg boom")),
    smartRunner: () => Promise.resolve(null),
  });

  const tracker = new CounterBaselineTracker();
  // Establish an oom_kill baseline, then bump it — this must still surface
  // even though the GPU/hung-task readers above throw every call.
  await set.detect(baseCtx({ tracker, oomKillTotal: 1 }));
  const events = await set.detect(
    baseCtx({ tracker, oomKillTotal: 2, nowMs: 2_000 }),
  );
  assertEquals(events.some((e) => e.kind === "oom_kill"), true);
});

test("EventCollectorSet: caps combined events at MAX_EVENTS_PER_DETECT_TICK", async () => {
  // Drive many NIC devices through a down transition in one tick to exceed
  // the cap without needing every detector to cooperate.
  const networks = Array.from({ length: 200 }, (_, i) => ({
    deviceId: `mac:00:00:00:00:00:${i.toString(16).padStart(2, "0")}`,
    kind: "uplink" as const,
    name: `eth${i}`,
    identity: {},
  }));
  const set = new EventCollectorSet({
    gpuHealthReader: () =>
      Promise.resolve({
        eccDoubleBitAggregateTotal: null,
        lastXidErrorCode: null,
        remappedRows: null,
        retiredPagesPending: null,
      }),
  });

  const io = {
    listDir: () => [],
    readFile: (path: string) => path.endsWith("/operstate") ? "up" : undefined,
  };
  await set.detect(
    baseCtx({ snapshot: { ...snapshot(), networks }, io }),
  );
  const downIo = {
    listDir: () => [],
    readFile: (path: string) =>
      path.endsWith("/operstate") ? "down" : undefined,
  };
  const events = await set.detect(
    baseCtx({
      snapshot: { ...snapshot(), networks },
      io: downIo,
      nowMs: 2_000,
    }),
  );
  // 200 NICs each transitioning up -> down produce 200 raw nic_link_down
  // events, well over the cap — assert the truncation actually engaged.
  assertEquals(events.length, 128);
});

test("EventCollectorSet: eventId is stable across independently rebuilt samples for the same transition", async () => {
  const networks = [
    { deviceId: "mac:aa", kind: "uplink" as const, name: "eth0", identity: {} },
  ];
  const upIo = {
    listDir: () => [],
    readFile: (path: string) => path.endsWith("/operstate") ? "up" : undefined,
  };
  const downIo = {
    listDir: () => [],
    readFile: (path: string) =>
      path.endsWith("/operstate") ? "down" : undefined,
  };

  async function runTransition(): Promise<string> {
    const set = new EventCollectorSet({
      gpuHealthReader: () =>
        Promise.resolve({
          eccDoubleBitAggregateTotal: null,
          lastXidErrorCode: null,
          remappedRows: null,
          retiredPagesPending: null,
        }),
    });
    await set.detect(
      baseCtx({ snapshot: { ...snapshot(), networks }, io: upIo, nowMs: 0 }),
    );
    const events = await set.detect(
      baseCtx({
        snapshot: { ...snapshot(), networks },
        io: downIo,
        nowMs: 1_000,
      }),
    );
    const event = events.find((e) => e.kind === "nic_link_down");
    if (!event) throw new Error("expected a nic_link_down event");
    return event.eventId;
  }

  // Two independently constructed collector sets, replayed at different
  // nowMs, detecting the exact same up -> down transition.
  const first = await runTransition();
  const second = await runTransition();
  assertEquals(first, second);
});

test("EventCollectorSet: physical-machine classification is resolved once and memoized across ticks", async () => {
  let reads = 0;
  const io = {
    listDir: () => [],
    readFile: (path: string) => {
      if (path.endsWith("/hypervisor/type") || path.endsWith("sys_vendor")) {
        reads++;
      }
      return undefined;
    },
  };
  const set = new EventCollectorSet({
    gpuHealthReader: () =>
      Promise.resolve({
        eccDoubleBitAggregateTotal: null,
        lastXidErrorCode: null,
        remappedRows: null,
        retiredPagesPending: null,
      }),
  });
  await set.detect(baseCtx({ io, nowMs: 0 }));
  await set.detect(baseCtx({ io, nowMs: 1_000 }));
  assertEquals(reads, 2); // hypervisor/type + sys_vendor, read once total.
});
