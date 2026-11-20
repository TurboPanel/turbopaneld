import { assertEquals } from "@std/assert";
import { topologyForReport, TopologyReporter } from "./topology-reporter.ts";
import type { CollectedTopology } from "../metrics/topology/topology.ts";

const test = Deno.test.bind(Deno);

/** A topology with `nics` network devices, so a different count is a different identity. */
function fakeSnapshot(nics: number): CollectedTopology {
  return {
    bootGeneration: 0,
    networks: Array.from({ length: nics }, (_, i) => ({
      deviceId: `mac:${i}`,
      kind: "uplink" as const,
      name: `eth${i}`,
      identity: { mac: `${i}` },
    })),
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
  const report = sent[0] as Record<string, unknown>;
  assertEquals("generation" in report, false);
  assertEquals("bootGeneration" in report, false);
  assertEquals("bootGeneration" in (report.snapshot as object), false);
});

test("reportNow does not resend when the identity is unchanged", async () => {
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

test("reportNow resends when the identity changes", async () => {
  const timer = fakeTimer();
  const sent: unknown[] = [];
  let nics = 0;
  const reporter = new TopologyReporter({
    collectTopology: () => Promise.resolve(fakeSnapshot(nics)),
    setIntervalFn: timer.setIntervalFn,
    clearIntervalFn: timer.clearIntervalFn,
  });

  reporter.attach((report) => sent.push(report));
  await Promise.resolve();
  nics = 1;
  await reporter.reportNow();

  assertEquals(sent.length, 2);
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

test("reportNow skips send when detached mid-collect", async () => {
  const timer = fakeTimer();
  const sent: unknown[] = [];
  let releaseCollect: (() => void) | undefined;
  const collectGate = new Promise<void>((resolve) => {
    releaseCollect = resolve;
  });
  const reporter = new TopologyReporter({
    collectTopology: async () => {
      await collectGate;
      return fakeSnapshot(3);
    },
    setIntervalFn: timer.setIntervalFn,
    clearIntervalFn: timer.clearIntervalFn,
  });

  reporter.attach((report) => sent.push(report));
  reporter.detach();
  releaseCollect?.();
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(sent.length, 0);
});

test("reportNow logs collect failures through the default logger", async () => {
  const timer = fakeTimer();
  const reporter = new TopologyReporter({
    collectTopology: () => Promise.reject(new Error("sysfs unreadable")),
    setIntervalFn: timer.setIntervalFn,
    clearIntervalFn: timer.clearIntervalFn,
  });

  reporter.attach(() => {
    throw new TypeError("send must not run after a collect failure");
  });
  await Promise.resolve();
  await Promise.resolve();
  await reporter.reportNow();
});

test("attach uses the default interval helpers when none are injected", async () => {
  const sent: unknown[] = [];
  const reporter = new TopologyReporter({
    collectTopology: () => Promise.resolve(fakeSnapshot(0)),
    intervalMs: 60_000,
  });

  reporter.attach((report) => sent.push(report));
  await Promise.resolve();
  await Promise.resolve();
  reporter.detach();
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

  // Same topology on the next tick — no resend.
  timer.fire();
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(sent.length, 1);
});

test("topology-reporter never consults the capability plan", () => {
  const source = Deno.readTextFileSync(
    new URL("./topology-reporter.ts", import.meta.url),
  );
  assertEquals(source.includes("capability-plan"), false);
  assertEquals(source.includes("capabilityPlan"), false);
  assertEquals(source.includes("truncateSample"), false);
});

test("topologyForReport drops the local boot generation and nothing else", () => {
  const collected = { ...fakeSnapshot(2), bootGeneration: 5 };
  const snapshot = topologyForReport(collected);
  assertEquals("bootGeneration" in snapshot, false);
  assertEquals(snapshot.networks, collected.networks);
  // The collected topology itself is untouched: the collector still reads it.
  assertEquals(collected.bootGeneration, 5);
});
