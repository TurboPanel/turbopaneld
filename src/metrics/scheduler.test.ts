import { assertEquals, assertNotEquals } from "jsr:@std/assert";
import { it } from "@std/testing/bdd";
import {
  createMetricsCollector,
  type MetricsCollectResult,
  type MetricsCollector,
} from "./collector/index.ts";
import type { CollectorDeps } from "./collector/types.ts";
import { METRICS_SCHEMA_VERSION } from "./contract.ts";
import {
  deterministicJitterMs,
  rebindMetricsScheduler,
  METRICS_INTERVAL_MS,
  METRICS_JITTER_MAX_MS,
  MetricsScheduler,
} from "./scheduler.ts";

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly sentFrames: string[] = [];
  readyState = MockWebSocket.OPEN;
  sendThrow = false;

  send(data: string): void {
    if (this.sendThrow) throw new Error("send boom");
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error("WebSocket is not open");
    }
    this.sentFrames.push(data);
  }
}

type TimerHandle = { id: number };
type TimeoutEntry = {
  id: number;
  due: number;
  fn: () => void;
  cleared: boolean;
};
type IntervalEntry = {
  id: number;
  due: number;
  interval: number;
  fn: () => void;
  cleared: boolean;
};

class FakeClock {
  #nowMs: number;
  #nextId = 1;
  readonly #timeouts: TimeoutEntry[] = [];
  readonly #intervals: IntervalEntry[] = [];

  constructor(startMs = 0) {
    this.#nowMs = startMs;
  }

  now = (): number => this.#nowMs;

  setTimeoutFn = (fn: () => void, ms: number): TimerHandle => {
    const id = this.#nextId++;
    this.#timeouts.push({ id, due: this.#nowMs + ms, fn, cleared: false });
    return { id };
  };

  clearTimeoutFn = (handle: TimerHandle | number): void => {
    const id = typeof handle === "number" ? handle : handle.id;
    const entry = this.#timeouts.find((t) => t.id === id);
    if (entry) entry.cleared = true;
  };

  setIntervalFn = (fn: () => void, ms: number): TimerHandle => {
    const id = this.#nextId++;
    this.#intervals.push({
      id,
      due: this.#nowMs + ms,
      interval: ms,
      fn,
      cleared: false,
    });
    return { id };
  };

  clearIntervalFn = (handle: TimerHandle | number): void => {
    const id = typeof handle === "number" ? handle : handle.id;
    const entry = this.#intervals.find((t) => t.id === id);
    if (entry) entry.cleared = true;
  };

  /** Advance wall clock and fire due timers (timeouts then intervals). */
  async advance(ms: number): Promise<void> {
    const target = this.#nowMs + ms;
    while (true) {
      const nextDue = this.#nextDueAt();
      if (nextDue === undefined || nextDue > target) {
        this.#nowMs = target;
        return;
      }
      this.#nowMs = nextDue;
      await this.#fireDue();
    }
  }

  #nextDueAt(): number | undefined {
    let soonest: number | undefined;
    for (const t of this.#timeouts) {
      if (t.cleared) continue;
      if (soonest === undefined || t.due < soonest) soonest = t.due;
    }
    for (const i of this.#intervals) {
      if (i.cleared) continue;
      if (soonest === undefined || i.due < soonest) soonest = i.due;
    }
    return soonest;
  }

  async #fireDue(): Promise<void> {
    const dueTimeouts = this.#timeouts.filter(
      (t) => !t.cleared && t.due <= this.#nowMs,
    );
    for (const t of dueTimeouts) {
      t.cleared = true;
      t.fn();
    }
    // Drain microtasks from void async emits (async collector I/O).
    await this.#flushMicrotasks();

    const dueIntervals = this.#intervals.filter(
      (i) => !i.cleared && i.due <= this.#nowMs,
    );
    for (const i of dueIntervals) {
      i.fn();
      i.due = this.#nowMs + i.interval;
    }
    await this.#flushMicrotasks();
  }

  /** Settle chained `await`s from async collector / emit paths. */
  async #flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 32; i++) {
      await Promise.resolve();
    }
  }
}

function parseMetricsFrames(frames: string[]): Array<{
  type: string;
  version: number;
  sequence: number;
  metrics: Record<string, number | null>;
}> {
  return frames
    .map((raw) => JSON.parse(raw) as {
      type: string;
      version: number;
      sequence: number;
      metrics: Record<string, number | null>;
    })
    .filter((f) => f.type === "metrics");
}

function fixture(name: string): string {
  return Deno.readTextFileSync(
    new URL(`./collector/testdata/${name}`, import.meta.url),
  );
}

function createFixtureCollectorFactory(): () => MetricsCollector {
  return () => {
    let sampleIndex = 0;
    let clockMs = 1_000_000;
    const deps: Partial<CollectorDeps> = {
      readProcFile(path: string) {
        if (path === "/proc/stat") {
          return sampleIndex === 0
            ? fixture("proc-stat-1.txt")
            : fixture("proc-stat-2.txt");
        }
        if (path === "/proc/meminfo") return fixture("proc-meminfo.txt");
        if (path === "/proc/loadavg") return fixture("proc-loadavg.txt");
        if (path === "/proc/uptime") return fixture("proc-uptime.txt");
        if (path === "/proc/diskstats") return fixture("proc-diskstats.txt");
        if (path === "/proc/net/dev") return fixture("proc-net-dev.txt");
        if (path === "/proc/sys/kernel/random/boot_id") {
          return fixture("proc-boot-id.txt");
        }
        if (path === "/proc/sys/kernel/osrelease") {
          return fixture("proc-osrelease.txt");
        }
        return undefined;
      },
      statfs() {
        return {
          blocks: 1_000_000,
          bfree: 400_000,
          bavail: 350_000,
          bsize: 4096,
        };
      },
      now: () => clockMs,
      countProcesses: () => 42,
      resolveDimensions: () => ({
        schemaVersion: METRICS_SCHEMA_VERSION,
        daemonVersion: "testcommit",
        operatingSystem: "Test OS",
        architecture: "aarch64",
        kernelRelease: "6.1.0-amd64",
      }),
    };
    const inner = createMetricsCollector(deps);
    return {
      async collect(options: { sequence: number; nowMs?: number }) {
        const result = await inner.collect({
          ...options,
          nowMs: options.nowMs ?? clockMs,
        });
        sampleIndex += 1;
        clockMs += 60_000;
        return result;
      },
    };
  };
}

function createFakeCollector(
  handler: (sequence: number) => Promise<MetricsCollectResult> | MetricsCollectResult,
): MetricsCollector {
  return {
    collect({ sequence }) {
      return Promise.resolve(handler(sequence));
    },
  };
}

function supportedSample(sequence: number): MetricsCollectResult {
  return {
    supported: true,
    sample: {
      type: "metrics",
      version: METRICS_SCHEMA_VERSION,
      at: new Date(0).toISOString(),
      intervalSeconds: 60,
      sequence,
      metrics: {
        cpuUsagePercent: null,
        cpuUserPercent: null,
        cpuSystemPercent: null,
        cpuIowaitPercent: null,
        load1: 1,
        load5: 1,
        load15: 1,
        memoryUsedPercent: 50,
        memoryUsedBytes: 100,
        memoryAvailableBytes: 100,
        swapUsedPercent: null,
        diskUsedPercent: 40,
        diskReadBytesPerSecond: null,
        diskWriteBytesPerSecond: null,
        diskReadOpsPerSecond: null,
        diskWriteOpsPerSecond: null,
        networkReceiveBytesPerSecond: null,
        networkTransmitBytesPerSecond: null,
        processCount: 10,
        uptimeSeconds: 100,
      },
      dimensions: {
        schemaVersion: METRICS_SCHEMA_VERSION,
        daemonVersion: "test",
        operatingSystem: "Test OS",
        architecture: "aarch64",
        kernelRelease: "6.1.0",
      },
    },
  };
}

function makeScheduler(options: {
  serverId?: string;
  clock: FakeClock;
  collectorFactory: () => MetricsCollector;
  intervalMs?: number;
  jitterMaxMs?: number;
  logRateLimitMs?: number;
  onLog?: (level: "info" | "warn", message: string) => void;
}): MetricsScheduler {
  return new MetricsScheduler({
    serverId: options.serverId ?? "server-a",
    collectorFactory: options.collectorFactory,
    intervalMs: options.intervalMs ?? 1_000,
    jitterMaxMs: options.jitterMaxMs ?? 0,
    now: options.clock.now,
    setTimeoutFn: options.clock.setTimeoutFn as unknown as typeof setTimeout,
    clearTimeoutFn: options.clock
      .clearTimeoutFn as unknown as typeof clearTimeout,
    setIntervalFn: options.clock
      .setIntervalFn as unknown as typeof setInterval,
    clearIntervalFn: options.clock
      .clearIntervalFn as unknown as typeof clearInterval,
    logRateLimitMs: options.logRateLimitMs,
    onLog: options.onLog,
  });
}

it("MetricsScheduler emits metrics frame after jittered first tick", async () => {
  const clock = new FakeClock();
  const ws = new MockWebSocket();
  const scheduler = makeScheduler({
    clock,
    jitterMaxMs: 50,
    collectorFactory: () =>
      createFakeCollector((sequence) => supportedSample(sequence)),
  });

  const expectedJitter = deterministicJitterMs("server-a", 50);
  scheduler.attach(ws as unknown as WebSocket);

  await clock.advance(expectedJitter - 1);
  assertEquals(ws.sentFrames.length, 0);

  await clock.advance(1);
  const frames = parseMetricsFrames(ws.sentFrames);
  assertEquals(frames.length, 1);
  assertEquals(frames[0].type, "metrics");
  assertEquals(frames[0].version, 1);
  assertEquals(typeof frames[0].sequence, "number");
});

it("MetricsScheduler steady cadence emits one frame per interval", async () => {
  const clock = new FakeClock();
  const ws = new MockWebSocket();
  const intervalMs = 1_000;
  const scheduler = makeScheduler({
    clock,
    intervalMs,
    jitterMaxMs: 0,
    collectorFactory: () =>
      createFakeCollector((sequence) => supportedSample(sequence)),
  });

  scheduler.attach(ws as unknown as WebSocket);
  await clock.advance(0); // first emit at jitter 0
  assertEquals(parseMetricsFrames(ws.sentFrames).length, 1);

  await clock.advance(intervalMs);
  assertEquals(parseMetricsFrames(ws.sentFrames).length, 2);

  await clock.advance(intervalMs * 3);
  assertEquals(parseMetricsFrames(ws.sentFrames).length, 5);
});

it("deterministicJitterMs is bounded, stable, and spreads across ids", () => {
  const maxMs = METRICS_JITTER_MAX_MS;
  const a = deterministicJitterMs("server-a", maxMs);
  const aAgain = deterministicJitterMs("server-a", maxMs);
  const b = deterministicJitterMs("server-b", maxMs);

  assertEquals(a, aAgain);
  assertEquals(a >= 0 && a <= maxMs, true);
  assertEquals(b >= 0 && b <= maxMs, true);
  assertNotEquals(a, b);

  // Default production interval remains the chart cadence.
  assertEquals(METRICS_INTERVAL_MS, 60_000);
});

it("MetricsScheduler first emit is scheduled at deterministic jitter offset", async () => {
  const clock = new FakeClock();
  const ws = new MockWebSocket();
  const serverId = "jitter-server";
  const jitterMaxMs = 200;
  const expected = deterministicJitterMs(serverId, jitterMaxMs);

  const scheduler = makeScheduler({
    serverId,
    clock,
    jitterMaxMs,
    collectorFactory: () =>
      createFakeCollector((sequence) => supportedSample(sequence)),
  });

  assertEquals(scheduler.jitterMs(), expected);
  scheduler.attach(ws as unknown as WebSocket);

  await clock.advance(expected - 1);
  assertEquals(ws.sentFrames.length, 0);
  await clock.advance(1);
  assertEquals(parseMetricsFrames(ws.sentFrames).length, 1);
});

it("MetricsScheduler sequence increases across ticks and survives detach→attach", async () => {
  const clock = new FakeClock();
  const ws1 = new MockWebSocket();
  const ws2 = new MockWebSocket();
  const intervalMs = 500;
  const scheduler = makeScheduler({
    clock,
    intervalMs,
    jitterMaxMs: 0,
    collectorFactory: () =>
      createFakeCollector((sequence) => supportedSample(sequence)),
  });

  scheduler.attach(ws1 as unknown as WebSocket);
  await clock.advance(0);
  await clock.advance(intervalMs);
  const first = parseMetricsFrames(ws1.sentFrames);
  assertEquals(first.map((f) => f.sequence), [1, 2]);

  scheduler.detach();
  scheduler.attach(ws2 as unknown as WebSocket);
  await clock.advance(0);
  await clock.advance(intervalMs);
  const second = parseMetricsFrames(ws2.sentFrames);
  assertEquals(second.map((f) => f.sequence), [3, 4]);
});

it("MetricsScheduler fresh collector after reattach nulls rate metrics", async () => {
  if (Deno.build.os !== "linux") return;

  const clock = new FakeClock();
  const intervalMs = 1_000;
  const factory = createFixtureCollectorFactory();
  const scheduler = makeScheduler({
    clock,
    intervalMs,
    jitterMaxMs: 0,
    collectorFactory: factory,
  });

  const ws1 = new MockWebSocket();
  scheduler.attach(ws1 as unknown as WebSocket);
  await clock.advance(0);
  const firstAttach = parseMetricsFrames(ws1.sentFrames);
  assertEquals(firstAttach.length, 1);
  assertEquals(firstAttach[0].metrics.cpuUsagePercent, null);
  assertEquals(firstAttach[0].metrics.diskReadBytesPerSecond, null);

  await clock.advance(intervalMs);
  const secondTick = parseMetricsFrames(ws1.sentFrames);
  assertEquals(secondTick.length, 2);
  assertEquals(typeof secondTick[1].metrics.cpuUsagePercent, "number");
  assertEquals(secondTick[1].metrics.cpuUsagePercent !== null, true);

  scheduler.detach();
  const ws2 = new MockWebSocket();
  scheduler.attach(ws2 as unknown as WebSocket);
  await clock.advance(0);
  const afterReattach = parseMetricsFrames(ws2.sentFrames);
  assertEquals(afterReattach.length, 1);
  assertEquals(afterReattach[0].metrics.cpuUsagePercent, null);
  assertEquals(afterReattach[0].metrics.diskReadBytesPerSecond, null);
});

it("MetricsScheduler is independent of other socket traffic", async () => {
  const clock = new FakeClock();
  const ws = new MockWebSocket();
  const intervalMs = 1_000;
  const scheduler = makeScheduler({
    clock,
    intervalMs,
    jitterMaxMs: 0,
    collectorFactory: () =>
      createFakeCollector((sequence) => supportedSample(sequence)),
  });

  scheduler.attach(ws as unknown as WebSocket);
  await clock.advance(0);
  assertEquals(parseMetricsFrames(ws.sentFrames).length, 1);

  // Push arbitrary other frames between ticks — must not suppress metrics.
  ws.sentFrames.push('{"type":"ping"}');
  ws.sentFrames.push('{"type":"hello","at":"x"}');

  await clock.advance(intervalMs);
  const metrics = parseMetricsFrames(ws.sentFrames);
  assertEquals(metrics.length, 2);
});

it("MetricsScheduler emits nothing when socket is closed or detached", async () => {
  const clock = new FakeClock();
  const closed = new MockWebSocket();
  closed.readyState = MockWebSocket.CLOSED;
  const scheduler = makeScheduler({
    clock,
    jitterMaxMs: 0,
    intervalMs: 500,
    collectorFactory: () =>
      createFakeCollector((sequence) => supportedSample(sequence)),
  });

  scheduler.attach(closed as unknown as WebSocket);
  await clock.advance(0);
  assertEquals(closed.sentFrames.length, 0);

  const open = new MockWebSocket();
  scheduler.attach(open as unknown as WebSocket);
  scheduler.detach();
  await clock.advance(0);
  await clock.advance(500);
  assertEquals(open.sentFrames.length, 0);
});

it("MetricsScheduler rate-limits collect/send failure logs and never rejects", async () => {
  const clock = new FakeClock();
  const logs: Array<{ level: string; message: string }> = [];
  const intervalMs = 100;
  const logRateLimitMs = 10_000;

  let mode: "collect" | "send" = "collect";
  const ws = new MockWebSocket();
  const scheduler = makeScheduler({
    clock,
    intervalMs,
    jitterMaxMs: 0,
    logRateLimitMs,
    onLog: (level, message) => logs.push({ level, message }),
    collectorFactory: () =>
      createFakeCollector((sequence) => {
        if (mode === "collect") {
          throw new Error("collect boom");
        }
        return supportedSample(sequence);
      }),
  });

  scheduler.attach(ws as unknown as WebSocket);
  for (let i = 0; i < 10; i++) {
    await clock.advance(i === 0 ? 0 : intervalMs);
  }
  assertEquals(
    logs.filter((l) => l.message.includes("collect failed")).length,
    1,
  );

  // Switch to send failures; many ticks inside one rate-limit window → one log.
  mode = "send";
  ws.sendThrow = true;
  logs.length = 0;
  for (let i = 0; i < 10; i++) {
    await clock.advance(intervalMs);
  }
  assertEquals(
    logs.filter((l) => l.message.includes("send failed")).length,
    1,
  );
});

it("MetricsScheduler stops periodic emits on unsupported result", async () => {
  const clock = new FakeClock();
  const logs: string[] = [];
  const ws = new MockWebSocket();
  const intervalMs = 200;
  const scheduler = makeScheduler({
    clock,
    intervalMs,
    jitterMaxMs: 0,
    onLog: (_level, message) => logs.push(message),
    collectorFactory: () =>
      createFakeCollector(() => ({
        supported: false,
        reason: "unsupported_os:windows",
      })),
  });

  scheduler.attach(ws as unknown as WebSocket);
  await clock.advance(0);
  assertEquals(ws.sentFrames.length, 0);
  assertEquals(logs.some((m) => m.includes("unsupported_os:windows")), true);

  const logCount = logs.length;
  await clock.advance(intervalMs * 5);
  assertEquals(ws.sentFrames.length, 0);
  // No further unsupported spam after stop (rate-limited + timer cleared).
  assertEquals(logs.length, logCount);
});

it("slow metrics collect does not delay concurrent websocket work", async () => {
  const clock = new FakeClock();
  let resolveCollect!: (result: MetricsCollectResult) => void;
  let collectStarted!: () => void;
  const collectStartedPromise = new Promise<void>((resolve) => {
    collectStarted = resolve;
  });

  const scheduler = makeScheduler({
    clock,
    jitterMaxMs: 0,
    collectorFactory: () => ({
      collect({ sequence }) {
        collectStarted();
        return new Promise((resolve) => {
          resolveCollect = resolve;
        }).then(() => supportedSample(sequence));
      },
    }),
  });

  const ws = new MockWebSocket();
  scheduler.attach(ws as unknown as WebSocket);

  // Fire the first tick; collection starts but hangs.
  const emitPromise = clock.advance(0);
  await collectStartedPromise;

  // While collect is in flight, liveness / ordinary WS work must still run.
  let livenessSent = false;
  const livenessPromise = Promise.resolve().then(() => {
    ws.send(JSON.stringify({ type: "ping" }));
    livenessSent = true;
  });
  await livenessPromise;
  assertEquals(livenessSent, true);
  assertEquals(ws.sentFrames.includes('{"type":"ping"}'), true);
  // Metrics frame must not have been sent yet (collect still pending).
  assertEquals(parseMetricsFrames(ws.sentFrames).length, 0);

  resolveCollect(supportedSample(1));
  await emitPromise;
  assertEquals(parseMetricsFrames(ws.sentFrames).length, 1);
});

it(
  "slow periodic collect skips overlapping ticks; sequences stay monotonic",
  async () => {
    const clock = new FakeClock();
    const intervalMs = 1_000;
    const ws = new MockWebSocket();

    let inFlight = 0;
    let maxInFlight = 0;
    let collectCount = 0;
    let releaseSlowCollect!: () => void;

    const scheduler = makeScheduler({
      clock,
      intervalMs,
      jitterMaxMs: 0,
      collectorFactory: () => ({
        async collect({ sequence }) {
          collectCount += 1;
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          const index = collectCount;
          try {
            // Second periodic collect hangs until after the next interval tick.
            if (index === 2) {
              await new Promise<void>((resolve) => {
                releaseSlowCollect = resolve;
              });
            }
            return supportedSample(sequence);
          } finally {
            inFlight -= 1;
          }
        },
      }),
    });

    scheduler.attach(ws as unknown as WebSocket);

    // First tick completes immediately; interval is armed on the same tick.
    await clock.advance(0);
    assertEquals(collectCount, 1);
    assertEquals(
      parseMetricsFrames(ws.sentFrames).map((f) => f.sequence),
      [1],
    );

    // Second tick starts a slow collect.
    await clock.advance(intervalMs);
    assertEquals(collectCount, 2);
    assertEquals(parseMetricsFrames(ws.sentFrames).length, 1);
    assertEquals(inFlight, 1);

    // Third tick while collect #2 is still running — must skip, not overlap.
    await clock.advance(intervalMs);
    assertEquals(collectCount, 2);
    assertEquals(maxInFlight, 1);

    releaseSlowCollect();
    for (let i = 0; i < 32; i++) {
      await Promise.resolve();
    }

    const afterSlow = parseMetricsFrames(ws.sentFrames);
    assertEquals(afterSlow.map((f) => f.sequence), [1, 2]);
    for (let i = 1; i < afterSlow.length; i++) {
      assertEquals(afterSlow[i].sequence > afterSlow[i - 1].sequence, true);
    }

    // Next cadence tick still works and keeps send-order sequences increasing.
    await clock.advance(intervalMs);
    const frames = parseMetricsFrames(ws.sentFrames);
    assertEquals(frames.map((f) => f.sequence), [1, 2, 3]);
    assertEquals(maxInFlight, 1);
    for (let i = 1; i < frames.length; i++) {
      assertEquals(frames[i].sequence > frames[i - 1].sequence, true);
    }
  },
);

it("in-flight emit after detach+attach does not arm a duplicate interval", async () => {
  const clock = new FakeClock();
  const intervalMs = 1_000;
  let resolveFirst!: (result: MetricsCollectResult) => void;
  let collectCount = 0;

  const scheduler = makeScheduler({
    clock,
    intervalMs,
    jitterMaxMs: 0,
    collectorFactory: () =>
      createFakeCollector((sequence) => {
        collectCount += 1;
        if (collectCount === 1) {
          return new Promise((resolve) => {
            resolveFirst = resolve;
          });
        }
        return supportedSample(sequence);
      }),
  });

  const ws1 = new MockWebSocket();
  scheduler.attach(ws1 as unknown as WebSocket);
  // Start first emit (hangs on collect).
  const firstAdvance = clock.advance(0);
  await Promise.resolve();
  await Promise.resolve();

  // Reconnect while first collect is still in flight.
  scheduler.detach();
  const ws2 = new MockWebSocket();
  scheduler.attach(ws2 as unknown as WebSocket);
  await clock.advance(0);
  assertEquals(parseMetricsFrames(ws2.sentFrames).length, 1);

  // Stale first collect resolves — must not arm an extra interval on ws2.
  resolveFirst(supportedSample(1));
  await firstAdvance;
  await Promise.resolve();
  await Promise.resolve();

  await clock.advance(intervalMs);
  // One interval tick only (not two overlapping intervals).
  assertEquals(parseMetricsFrames(ws2.sentFrames).length, 2);
  assertEquals(ws1.sentFrames.length, 0);
});

it("stale unsupported result after reconnect does not stop new attach", async () => {
  const clock = new FakeClock();
  const intervalMs = 500;
  let resolveFirst!: (result: MetricsCollectResult) => void;
  let collectCount = 0;

  const scheduler = makeScheduler({
    clock,
    intervalMs,
    jitterMaxMs: 0,
    collectorFactory: () =>
      createFakeCollector((sequence) => {
        collectCount += 1;
        if (collectCount === 1) {
          return new Promise((resolve) => {
            resolveFirst = resolve;
          });
        }
        return supportedSample(sequence);
      }),
  });

  const ws1 = new MockWebSocket();
  scheduler.attach(ws1 as unknown as WebSocket);
  const firstAdvance = clock.advance(0);
  await Promise.resolve();
  await Promise.resolve();

  scheduler.detach();
  const ws2 = new MockWebSocket();
  scheduler.attach(ws2 as unknown as WebSocket);
  await clock.advance(0);
  assertEquals(parseMetricsFrames(ws2.sentFrames).length, 1);

  // Old attach's unsupported result arrives late — must not freeze new attach.
  resolveFirst({ supported: false, reason: "unsupported_os:windows" });
  await firstAdvance;
  await Promise.resolve();
  await Promise.resolve();

  await clock.advance(intervalMs);
  assertEquals(parseMetricsFrames(ws2.sentFrames).length, 2);
});

it("collector factory throw disables metrics without throwing", () => {
  const clock = new FakeClock();
  const logs: string[] = [];
  const ws = new MockWebSocket();
  const scheduler = makeScheduler({
    clock,
    jitterMaxMs: 0,
    onLog: (_level, message) => logs.push(message),
    collectorFactory: () => {
      throw new Error("factory boom");
    },
  });

  scheduler.attach(ws as unknown as WebSocket);
  assertEquals(logs.some((m) => m.includes("collector factory failed")), true);
});

it("rebindMetricsScheduler updates serverId and preserves sequence", async () => {
  const clock = new FakeClock();
  const factory = () =>
    createFakeCollector((sequence) => supportedSample(sequence));

  const first = rebindMetricsScheduler({
    existing: undefined,
    existingServerId: undefined,
    serverId: "server-old",
    collectorFactory: factory,
    schedulerOptions: {
      intervalMs: 1_000,
      jitterMaxMs: METRICS_JITTER_MAX_MS,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn as unknown as typeof setTimeout,
      clearTimeoutFn: clock.clearTimeoutFn as unknown as typeof clearTimeout,
      setIntervalFn: clock.setIntervalFn as unknown as typeof setInterval,
      clearIntervalFn: clock.clearIntervalFn as unknown as typeof clearInterval,
    },
  });

  assertEquals(first.scheduler.serverId(), "server-old");
  assertEquals(
    first.scheduler.jitterMs(),
    deterministicJitterMs("server-old", METRICS_JITTER_MAX_MS),
  );

  const ws1 = new MockWebSocket();
  first.scheduler.attach(ws1 as unknown as WebSocket);
  await clock.advance(deterministicJitterMs("server-old", METRICS_JITTER_MAX_MS));
  assertEquals(parseMetricsFrames(ws1.sentFrames)[0].sequence, 1);

  // Simulate tokenServerId already equal to the new id (the reuse bug condition).
  const tokenServerIdAlreadyUpdated = "server-new";
  const reusedWrongly =
    first.scheduler && tokenServerIdAlreadyUpdated === "server-new";
  assertEquals(reusedWrongly, true);

  const rebound = rebindMetricsScheduler({
    existing: first.scheduler,
    existingServerId: first.serverId,
    serverId: "server-new",
    collectorFactory: factory,
  });

  assertEquals(rebound.scheduler, first.scheduler);
  assertEquals(rebound.scheduler.serverId(), "server-new");
  assertEquals(
    rebound.scheduler.jitterMs(),
    deterministicJitterMs("server-new", METRICS_JITTER_MAX_MS),
  );

  const ws2 = new MockWebSocket();
  rebound.scheduler.attach(ws2 as unknown as WebSocket);
  await clock.advance(deterministicJitterMs("server-new", METRICS_JITTER_MAX_MS));
  // Process-local sequence continues after identity rebind.
  assertEquals(parseMetricsFrames(ws2.sentFrames)[0].sequence, 2);
});
