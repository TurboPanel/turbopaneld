import { assertEquals } from "@std/assert";
import { TopologyReporter } from "./topology-reporter.ts";
import type { TopologySnapshot } from "../metrics/topology/types.ts";

const test = Deno.test.bind(Deno);

function fakeSnapshot(generation: number): TopologySnapshot {
  return {
    generation,
    bootGeneration: 0,
    networks: [],
    filesystems: [],
    blockDevices: [],
    gpus: [],
    hardwareSignals: [],
    cpu: {
      sockets: 0,
      coresPerSocket: 0,
      threadsPerSocket: 0,
      model: null,
      cores: [],
    },
    numaNodes: [],
    memoryTotalBytes: null,
    swapTotalBytes: null,
  };
}

/** Manually-driven fake timer — the test controls when the "interval" fires. */
function fakeTimer() {
  let scheduled: { fn: () => void; ms: number } | undefined;
  let cleared = false;
  return {
    setIntervalFn: ((fn: () => void, ms?: number) => {
      scheduled = { fn, ms: ms ?? 0 };
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearIntervalFn: (() => {
      cleared = true;
    }) as typeof clearInterval,
    fire: () => scheduled?.fn(),
    intervalMs: () => scheduled?.ms,
    wasCleared: () => cleared,
  };
}

test("attach immediately sends an initial report", async () => {
  const timer = fakeTimer();
  const sent: unknown[] = [];
  const reporter = new TopologyReporter({
    collectTopology: () => Promise.resolve(fakeSnapshot(0)),
    setIntervalFn: timer.setIntervalFn,
    clearIntervalFn: timer.clearIntervalFn,
  });

  reporter.attach((report) => sent.push(report));
  // attach() fires the initial collect fire-and-forget — await a microtask turn.
  await Promise.resolve();
  await Promise.resolve();

  assertEquals(sent.length, 1);
  assertEquals((sent[0] as { generation: number }).generation, 0);
});

test("reportNow does not resend when the generation is unchanged", async () => {
  const timer = fakeTimer();
  const sent: unknown[] = [];
  const reporter = new TopologyReporter({
    collectTopology: () => Promise.resolve(fakeSnapshot(0)),
    setIntervalFn: timer.setIntervalFn,
    clearIntervalFn: timer.clearIntervalFn,
  });

  reporter.attach((report) => sent.push(report));
  await reporter.reportNow();
  await reporter.reportNow();

  assertEquals(sent.length, 1);
});

test("reportNow resends when the generation changes", async () => {
  const timer = fakeTimer();
  const sent: unknown[] = [];
  let generation = 0;
  const reporter = new TopologyReporter({
    collectTopology: () => Promise.resolve(fakeSnapshot(generation)),
    setIntervalFn: timer.setIntervalFn,
    clearIntervalFn: timer.clearIntervalFn,
  });

  reporter.attach((report) => sent.push(report));
  await Promise.resolve();
  generation = 1;
  await reporter.reportNow();

  assertEquals(sent.length, 2);
  assertEquals((sent[1] as { generation: number }).generation, 1);
});

test("an overlapping collect is dropped, never queued", async () => {
  const timer = fakeTimer();
  const sent: unknown[] = [];
  let collectCalls = 0;
  let releaseCollect: (() => void) | undefined;
  const collectGate = new Promise<void>((resolve) => {
    releaseCollect = resolve;
  });
  const reporter = new TopologyReporter({
    collectTopology: async () => {
      collectCalls += 1;
      if (collectCalls === 1) await collectGate;
      return fakeSnapshot(0);
    },
    setIntervalFn: timer.setIntervalFn,
    clearIntervalFn: timer.clearIntervalFn,
  });

  reporter.attach((report) => sent.push(report));
  // The initial attach() collect is now in flight (gated). A second call
  // while it's still running must be dropped, not queued.
  const second = reporter.reportNow();
  await second;
  assertEquals(collectCalls, 1);

  releaseCollect?.();
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(sent.length, 1);
});

test("detach stops the interval and reportNow becomes a no-op", async () => {
  const timer = fakeTimer();
  const sent: unknown[] = [];
  const reporter = new TopologyReporter({
    collectTopology: () => Promise.resolve(fakeSnapshot(0)),
    setIntervalFn: timer.setIntervalFn,
    clearIntervalFn: timer.clearIntervalFn,
  });

  reporter.attach((report) => sent.push(report));
  await Promise.resolve();
  reporter.detach();
  assertEquals(timer.wasCleared(), true);

  await reporter.reportNow();
  assertEquals(sent.length, 1);
});

test("the interval fires reportNow on the configured cadence", async () => {
  const timer = fakeTimer();
  const sent: unknown[] = [];
  const reporter = new TopologyReporter({
    collectTopology: () => Promise.resolve(fakeSnapshot(0)),
    intervalMs: 5000,
    setIntervalFn: timer.setIntervalFn,
    clearIntervalFn: timer.clearIntervalFn,
  });

  reporter.attach((report) => sent.push(report));
  await Promise.resolve();
  assertEquals(timer.intervalMs(), 5000);
  assertEquals(sent.length, 1);

  // Same generation on the next tick — no resend.
  timer.fire();
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(sent.length, 1);
});
