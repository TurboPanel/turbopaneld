import { assertEquals } from "@std/assert";
import {
  getLastObservedTimeSync,
  setLastObservedTimeSyncForTests,
} from "../../../host/time-sync.ts";
import { CounterBaselineTracker } from "../baseline.ts";
import { ClockSyncEventCollector } from "./clock-sync.ts";
import type { EventDetectContext } from "./types.ts";

const test = Deno.test.bind(Deno);

function ctx(overrides: Partial<EventDetectContext> = {}): EventDetectContext {
  return {
    nowMs: 0,
    // deno-lint-ignore no-explicit-any
    snapshot: {} as any,
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
    isPhysical: false,
    ...overrides,
  };
}

test("ClockSyncEventCollector: first read establishes the baseline, no fabricated event", () => {
  const collector = new ClockSyncEventCollector({
    intervalMs: 0,
    reader: () => true,
  });
  assertEquals(collector.detect(ctx({ nowMs: 0 })), []);
});

test("ClockSyncEventCollector: synced -> unsynced fires clock_sync_lost", () => {
  let synced = true;
  const collector = new ClockSyncEventCollector({
    intervalMs: 0,
    reader: () => synced,
  });
  collector.detect(ctx({ nowMs: 0 }));
  synced = false;
  const events = collector.detect(ctx({ nowMs: 1_000 }));
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "clock_sync_lost");
});

test("ClockSyncEventCollector: unsynced -> synced fires clock_sync_restored", () => {
  let synced = false;
  const collector = new ClockSyncEventCollector({
    intervalMs: 0,
    reader: () => synced,
  });
  collector.detect(ctx({ nowMs: 0 }));
  synced = true;
  const events = collector.detect(ctx({ nowMs: 1_000 }));
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "clock_sync_restored");
});

test("ClockSyncEventCollector: within the cooldown window, the reader is never called again", () => {
  let calls = 0;
  const collector = new ClockSyncEventCollector({
    intervalMs: 60_000,
    reader: () => {
      calls++;
      return true;
    },
  });
  collector.detect(ctx({ nowMs: 0 }));
  collector.detect(ctx({ nowMs: 1_000 }));
  assertEquals(calls, 1);
});

test("ClockSyncEventCollector: an undefined reading (readTimeSync unavailable) never fires or corrupts state", () => {
  const collector = new ClockSyncEventCollector({
    intervalMs: 0,
    reader: () => undefined,
  });
  collector.detect(ctx({ nowMs: 0 }));
  const events = collector.detect(ctx({ nowMs: 1_000 }));
  assertEquals(events, []);
});

test("ClockSyncEventCollector: the default reader consumes the daemon's cached time-sync fact, never its own timedatectl spawn", () => {
  try {
    setLastObservedTimeSyncForTests({ ntpSynced: true, ntpServers: [] });
    const collector = new ClockSyncEventCollector({ intervalMs: 0 });
    collector.detect(ctx({ nowMs: 0 }));

    setLastObservedTimeSyncForTests({ ntpSynced: false, ntpServers: [] });
    const events = collector.detect(ctx({ nowMs: 1_000 }));
    assertEquals(events.length, 1);
    assertEquals(events[0].kind, "clock_sync_lost");
  } finally {
    setLastObservedTimeSyncForTests(undefined);
  }
});

test("ClockSyncEventCollector: an empty cache (no real time-sync read yet this process) fires nothing", () => {
  try {
    setLastObservedTimeSyncForTests(undefined);
    assertEquals(getLastObservedTimeSync(), undefined);
    const collector = new ClockSyncEventCollector({ intervalMs: 0 });
    collector.detect(ctx({ nowMs: 0 }));
    const events = collector.detect(ctx({ nowMs: 1_000 }));
    assertEquals(events, []);
  } finally {
    setLastObservedTimeSyncForTests(undefined);
  }
});
