import { assertEquals } from "@std/assert";
import { CounterBaselineTracker } from "../baseline.ts";
import { MdstatEventCollector, parseMdstat } from "./mdstat.ts";
import type { EventDetectContext } from "./types.ts";

const test = Deno.test.bind(Deno);

const HEALTHY = `Personalities : [raid1]
md0 : active raid1 sda1[0] sdb1[1]
      1953514496 blocks super 1.2 [2/2] [UU]

unused devices: <none>
`;

const DEGRADED = `Personalities : [raid1]
md0 : active raid1 sda1[0]
      1953514496 blocks super 1.2 [2/1] [U_]

unused devices: <none>
`;

const REBUILDING = `Personalities : [raid1]
md0 : active raid1 sda1[0] sdb1[1]
      1953514496 blocks super 1.2 [2/2] [UU]
      [=====>...............]  resync = 25.5% (250099200/976630464) finish=90.0min speed=45000K/sec

unused devices: <none>
`;

test("parseMdstat reads active-device counts and degraded/rebuilding flags", () => {
  assertEquals(parseMdstat(HEALTHY), [
    {
      name: "md0",
      degraded: false,
      rebuilding: false,
      activeDevices: 2,
      totalDevices: 2,
    },
  ]);
  assertEquals(parseMdstat(DEGRADED)[0].degraded, true);
  assertEquals(parseMdstat(REBUILDING)[0].rebuilding, true);
});

function ctx(overrides: Partial<EventDetectContext> = {}): EventDetectContext {
  return {
    nowMs: 1_000,
    // deno-lint-ignore no-explicit-any
    snapshot: {} as any,
    tracker: new CounterBaselineTracker(),
    bootGeneration: 1,
    seconds: 60,
    gpus: [],
    hardwareSignals: [],
    hardwareSignalCandidates: new Map(),
    oomKillTotal: null,
    conntrackUsedPercent: null,
    mountEntries: [],
    mdstatText: HEALTHY,
    io: { listDir: () => [], readFile: () => undefined },
    isPhysical: false,
    ...overrides,
  };
}

test("MdstatEventCollector: first tick establishes the baseline, no fabricated event", () => {
  const collector = new MdstatEventCollector();
  assertEquals(collector.detect(ctx({ mdstatText: HEALTHY })), []);
});

test("MdstatEventCollector: healthy -> degraded fires raid_degraded", () => {
  const collector = new MdstatEventCollector();
  collector.detect(ctx({ mdstatText: HEALTHY }));
  const events = collector.detect(ctx({ mdstatText: DEGRADED, nowMs: 2_000 }));
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "raid_degraded");
  assertEquals(events[0].entityId, "md0");
});

test("MdstatEventCollector: rebuild lifecycle fires started, then completed on a clean finish", () => {
  const collector = new MdstatEventCollector();
  collector.detect(ctx({ mdstatText: HEALTHY }));
  const started = collector.detect(
    ctx({ mdstatText: REBUILDING, nowMs: 2_000 }),
  );
  assertEquals(started.length, 1);
  assertEquals(started[0].kind, "raid_rebuild_started");

  const completed = collector.detect(
    ctx({ mdstatText: HEALTHY, nowMs: 3_000 }),
  );
  assertEquals(completed.length, 1);
  assertEquals(completed[0].kind, "raid_rebuild_completed");
});

test("MdstatEventCollector: rebuild ending while still degraded fires raid_rebuild_failed", () => {
  const collector = new MdstatEventCollector();
  collector.detect(ctx({ mdstatText: HEALTHY }));
  collector.detect(ctx({ mdstatText: REBUILDING, nowMs: 2_000 }));
  const events = collector.detect(ctx({ mdstatText: DEGRADED, nowMs: 3_000 }));
  assertEquals(events.some((e) => e.kind === "raid_rebuild_failed"), true);
});

test("MdstatEventCollector: undefined mdstat text (no mdadm on this host) fires nothing", () => {
  const collector = new MdstatEventCollector();
  assertEquals(collector.detect(ctx({ mdstatText: undefined })), []);
});
