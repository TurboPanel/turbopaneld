import { assertEquals } from "@std/assert";
import { CounterBaselineTracker } from "../baseline.ts";
import {
  createDefaultKernelLogReader,
  createKmsgKernelLogReader,
  HungTaskEventCollector,
  type KmsgHandle,
  type KmsgIo,
} from "./hung-task.ts";
import type { EventDetectContext } from "./types.ts";

/** In-memory `KmsgIo` backed by a queue of raw kmsg record strings. */
function memoryKmsgIo(records: string[]): KmsgIo {
  return {
    open(): KmsgHandle {
      let index = 0;
      return {
        next: () => index < records.length ? records[index++] : undefined,
        close: () => {},
      };
    },
  };
}

function failingKmsgIo(error: unknown = new Error("EPERM")): KmsgIo {
  return {
    open(): KmsgHandle {
      throw error;
    },
  };
}

function kmsgRecord(seq: number, message: string): string {
  return `6,${seq},123456,-;${message}`;
}

const test = Deno.test.bind(Deno);

// Realistic dmesg output: the INFO line (carries the comm/pid) and the
// separate hint line (contains the literal "hung_task" but no comm).
const HUNG_TASK_LINE =
  "[12345.678901] INFO: task myworker:4321 blocked for more than 120 seconds.";
const HUNG_TASK_HINT_LINE =
  '[12345.678901]       "echo 0 > /proc/sys/kernel/hung_task_timeout_secs" disables this message.';

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

test("HungTaskEventCollector: a hung_task line fires a critical event with the parsed comm", async () => {
  const collector = new HungTaskEventCollector({
    intervalMs: 0,
    reader: () => Promise.resolve([HUNG_TASK_LINE]),
  });
  const events = await collector.detect(ctx());
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "hung_task");
  assertEquals(events[0].severity, "critical");
  assertEquals(events[0].payload, { comm: "myworker" });
});

test("HungTaskEventCollector: the same line seen again is never re-reported", async () => {
  const collector = new HungTaskEventCollector({
    intervalMs: 0,
    reader: () => Promise.resolve([HUNG_TASK_LINE]),
  });
  await collector.detect(ctx({ nowMs: 0 }));
  const events = await collector.detect(ctx({ nowMs: 1_000 }));
  assertEquals(events, []);
});

test("HungTaskEventCollector: lines without hung_task are ignored", async () => {
  const collector = new HungTaskEventCollector({
    intervalMs: 0,
    reader: () => Promise.resolve(["[1.0] some unrelated kernel warning"]),
  });
  assertEquals(await collector.detect(ctx()), []);
});

test("HungTaskEventCollector: the literal-hung_task hint line alone never fires (no comm, wrong line)", async () => {
  const collector = new HungTaskEventCollector({
    intervalMs: 0,
    reader: () => Promise.resolve([HUNG_TASK_HINT_LINE]),
  });
  assertEquals(await collector.detect(ctx()), []);
});

test("HungTaskEventCollector: a realistic two-line dmesg block fires exactly once, from the INFO line", async () => {
  const collector = new HungTaskEventCollector({
    intervalMs: 0,
    reader: () => Promise.resolve([HUNG_TASK_LINE, HUNG_TASK_HINT_LINE]),
  });
  const events = await collector.detect(ctx());
  assertEquals(events.length, 1);
  assertEquals(events[0].payload, { comm: "myworker" });
});

test("HungTaskEventCollector: within the cooldown window, the reader is never called again", async () => {
  let calls = 0;
  const collector = new HungTaskEventCollector({
    intervalMs: 60_000,
    reader: () => {
      calls++;
      return Promise.resolve([]);
    },
  });
  await collector.detect(ctx({ nowMs: 0 }));
  await collector.detect(ctx({ nowMs: 1_000 }));
  assertEquals(calls, 1);
});

test("HungTaskEventCollector: a new hung_task line after the cooldown still fires", async () => {
  const lines = [[HUNG_TASK_LINE]];
  const collector = new HungTaskEventCollector({
    intervalMs: 0,
    reader: () => Promise.resolve(lines[0]),
  });
  await collector.detect(ctx({ nowMs: 0 }));
  lines[0] = [
    "[99999.0] INFO: task other:9999 blocked for more than 120 seconds.",
  ];
  const events = await collector.detect(ctx({ nowMs: 200_000 }));
  assertEquals(events.length, 1);
  assertEquals(events[0].payload, { comm: "other" });
});

test("createKmsgKernelLogReader: the existing backlog is drained silently on the first scan (no fabricated events)", () => {
  const reader = createKmsgKernelLogReader(
    memoryKmsgIo([kmsgRecord(1, "some old boot message")]),
  );
  assertEquals(reader(), []);
});

test("createKmsgKernelLogReader: only records past the cursor are returned on later scans", () => {
  const records = [kmsgRecord(1, "backlog message")];
  const io = memoryKmsgIo(records);
  const reader = createKmsgKernelLogReader(io);
  assertEquals(reader(), []); // primes the cursor at seq 1

  records.push(kmsgRecord(2, HUNG_TASK_LINE));
  const second = reader();
  assertEquals(second, [HUNG_TASK_LINE]);

  // Nothing new since the last scan.
  assertEquals(reader(), []);
});

test("createKmsgKernelLogReader: a fatal read error marks kmsg unavailable for the rest of the process", () => {
  let opens = 0;
  const io: KmsgIo = {
    open() {
      opens++;
      return {
        next: () => {
          throw new Error("boom");
        },
        close: () => {},
      };
    },
  };
  const reader = createKmsgKernelLogReader(io);
  assertEquals(reader(), undefined);
  assertEquals(reader(), undefined);
  assertEquals(opens, 1); // never retries opening once kmsg has failed.
});

test("createKmsgKernelLogReader: an open failure (EPERM) yields undefined so the caller falls back", () => {
  const reader = createKmsgKernelLogReader(failingKmsgIo());
  assertEquals(reader(), undefined);
});

test("createDefaultKernelLogReader: kmsg available — dmesg fallback is never invoked", async () => {
  let dmesgCalls = 0;
  const reader = createDefaultKernelLogReader({
    kmsgIo: memoryKmsgIo([]),
    dmesgReader: () => {
      dmesgCalls++;
      return Promise.resolve([]);
    },
  });
  await reader();
  await reader();
  assertEquals(dmesgCalls, 0);
});

test("createDefaultKernelLogReader: kmsg unavailable falls back to dmesg", async () => {
  const reader = createDefaultKernelLogReader({
    kmsgIo: failingKmsgIo(),
    dmesgReader: () => Promise.resolve([HUNG_TASK_LINE]),
  });
  assertEquals(await reader(), [HUNG_TASK_LINE]);
});

test("createKmsgKernelLogReader: unparseable records and already-seen seqs never become messages", () => {
  const records = [
    "not-a-kmsg-record",
    "6,abc,123456,-;bad seq",
    kmsgRecord(3, "first real"),
    kmsgRecord(3, "same seq again"),
    kmsgRecord(2, "older than cursor"),
  ];
  const reader = createKmsgKernelLogReader(memoryKmsgIo(records));
  assertEquals(reader(), []);
  records.push(kmsgRecord(4, "fresh"));
  assertEquals(reader(), ["fresh"]);
});

test("createKmsgKernelLogReader: a close() throw after a fatal read still marks kmsg unavailable", () => {
  const io: KmsgIo = {
    open() {
      return {
        next: () => {
          throw new Error("read failed");
        },
        close: () => {
          throw new Error("already closed");
        },
      };
    },
  };
  const reader = createKmsgKernelLogReader(io);
  assertEquals(reader(), undefined);
  assertEquals(reader(), undefined);
});

test("createDefaultKernelLogReader: missing dmesgReader falls back to the real dmesg helper", async () => {
  const reader = createDefaultKernelLogReader({ kmsgIo: failingKmsgIo() });
  const lines = await reader();
  if (!Array.isArray(lines)) {
    throw new TypeError("expected a dmesg fallback array");
  }
});

test("createDefaultKernelLogReader: missing kmsgIo opens the production /dev/kmsg path", async () => {
  const lines = await createDefaultKernelLogReader({
    dmesgReader: () => Promise.resolve(["dmesg fallback"]),
  })();
  if (!Array.isArray(lines)) {
    throw new TypeError("expected kmsg or dmesg lines");
  }
});

test("HungTaskEventCollector: a hung-task line without a comm still fires, with no payload", async () => {
  const collector = new HungTaskEventCollector({
    intervalMs: 0,
    reader: () =>
      Promise.resolve([
        "[1.0] watchdog: blocked for more than 120 seconds.",
      ]),
  });
  const events = await collector.detect(ctx());
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "hung_task");
  assertEquals(events[0].payload, undefined);
});

test("HungTaskEventCollector: the seen-line set is trimmed when it exceeds the bound", async () => {
  let generation = 0;
  const collector = new HungTaskEventCollector({
    intervalMs: 0,
    reader: () => {
      const start = generation * 501;
      generation += 1;
      return Promise.resolve(
        Array.from({ length: 501 }, (_, i) => {
          const n = start + i;
          return `[${n}.0] INFO: task worker${n}:${n} blocked for more than 120 seconds.`;
        }),
      );
    },
  });
  const first = await collector.detect(ctx({ nowMs: 0 }));
  assertEquals(first.length, 501);
  const second = await collector.detect(ctx({ nowMs: 1 }));
  assertEquals(second.length, 501);
});

test("HungTaskEventCollector: end-to-end over the kmsg + dmesg-fallback reader still fires on a real hung-task record", async () => {
  const records = [kmsgRecord(1, "backlog only")];
  const io = memoryKmsgIo(records);
  const collector = new HungTaskEventCollector({
    intervalMs: 0,
    reader: createDefaultKernelLogReader({ kmsgIo: io }),
  });
  assertEquals(await collector.detect(ctx({ nowMs: 0 })), []); // priming scan

  records.push(kmsgRecord(2, HUNG_TASK_LINE));
  const events = await collector.detect(ctx({ nowMs: 1_000 }));
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "hung_task");
  assertEquals(events[0].payload, { comm: "myworker" });
});
