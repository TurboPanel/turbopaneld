import { assert, assertEquals } from "@std/assert";
import type { ManagedHaMemberRecord } from "../managed/ha-member.ts";
import type { ProbeSample } from "../managed/pg-dead-primary.ts";
import {
  type IntentState,
  isWatchedPrimary,
  type PgDeadPrimaryEventMessage,
  PgDeadPrimaryObserver,
  type PgDeadPrimaryObserverOptions,
  pgProbeGloballyEnabled,
  systemdHostBlocksEmit,
} from "./pg-dead-primary-observe.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const MANAGED_ID = "00000000-0000-4000-8000-0000000000aa";
const MEMBER_ID = "00000000-0000-4000-8000-0000000000a1";
const T0 = Date.parse("2026-10-01T00:00:00Z");

const PRIMARY: ManagedHaMemberRecord = {
  managedId: MANAGED_ID,
  memberId: MEMBER_ID,
  engine: "postgres",
  role: "primary",
  containerName: "svc-1",
  replicaPeerCount: 1,
  updatedAt: "2026-10-01T00:00:00Z",
};

function intent(overrides: Partial<IntentState>): IntentState {
  return {
    active: false,
    heldClusterMarker: false,
    runningKind: null,
    runningOverdue: false,
    unreadableReason: null,
    noClusterMarker: true,
    ...overrides,
  };
}

const DEAD: ProbeSample = {
  container: {
    kind: "present",
    state: { status: "exited", exitCode: 0, restartCount: 0 },
  },
};

type Harness = {
  observer: PgDeadPrimaryObserver;
  sent: PgDeadPrimaryEventMessage[];
  clock: { now: number };
  sampled: string[];
};

function harness(
  overrides: Partial<PgDeadPrimaryObserverOptions> = {},
  members: ManagedHaMemberRecord[] = [PRIMARY],
): Harness {
  const sent: PgDeadPrimaryEventMessage[] = [];
  const clock = { now: T0 };
  const sampled: string[] = [];
  const observer = new PgDeadPrimaryObserver({
    send: (message) => {
      sent.push(message);
      return true;
    },
    peerSupportsProbe: () => true,
    config: { intervalMs: 3_600_000 },
    monoMs: () => clock.now,
    wallMs: () => clock.now,
    globallyEnabled: () => true,
    listMembers: () => Promise.resolve(members),
    sample: (name) => {
      sampled.push(name);
      return Promise.resolve(DEAD);
    },
    intentState: () => Promise.resolve(intent({})),
    releaseHeld: () => Promise.resolve(),
    holdStop: () => Promise.resolve(),
    hostStopping: () => Promise.resolve(false),
    ...overrides,
  });
  return { observer, sent, clock, sampled };
}

/** Poll `ticks` times, 5 s apart. Sequential on purpose (one tick at a time). */
async function pollTicks(h: Harness, ticks: number): Promise<void> {
  await Array.from({ length: ticks }).reduce<Promise<void>>(
    async (previous) => {
      await previous;
      await h.observer.poll();
      h.clock.now += 5_000;
    },
    Promise.resolve(),
  );
}

async function withAttached(
  h: Harness,
  fn: () => Promise<void>,
): Promise<void> {
  h.observer.attach();
  try {
    await fn();
  } finally {
    h.observer.detach();
  }
}

test("dead primary emits one managed-ha-event with detector and evidence", async () => {
  const h = harness();
  await withAttached(h, () => pollTicks(h, 20));
  assertEquals(h.sent.length, 1);
  const event = h.sent[0]!;
  assertEquals(event.type, "managed-ha-event");
  assertEquals(event.managedId, MANAGED_ID);
  assertEquals(event.sourceMemberId, MEMBER_ID);
  assertEquals(event.detector, "postgres-probe");
  assertEquals(event.evidence.failures, 6);
  assertEquals(event.evidence.container?.status, "exited");
  assert(!Number.isNaN(Date.parse(event.at)));
});

test("active intent marker suppresses the event", async () => {
  const h = harness({
    intentState: () => Promise.resolve(intent({ active: true })),
  });
  await withAttached(h, () => pollTicks(h, 50));
  assertEquals(h.sent.length, 0);
});

test("MySQL / MariaDB members are never probed", async () => {
  const mysql = { ...PRIMARY, engine: "mysql" as const };
  const mariadb = { ...PRIMARY, engine: "mariadb" as const };
  const h = harness({}, [mysql, mariadb]);
  await withAttached(h, () => pollTicks(h, 30));
  assertEquals(h.sampled.length, 0);
  assertEquals(h.sent.length, 0);
});

test("replicas and primaries without replica peers are not watched", () => {
  assert(isWatchedPrimary(PRIMARY));
  assert(!isWatchedPrimary({ ...PRIMARY, role: "replica" }));
  assert(!isWatchedPrimary({ ...PRIMARY, replicaPeerCount: 0 }));
});

test("global setting off: nothing probed, nothing sent", async () => {
  const h = harness({ globallyEnabled: () => false });
  await withAttached(h, () => pollTicks(h, 30));
  assertEquals(h.sampled.length, 0);
  assertEquals(h.sent.length, 0);
  assert(pgProbeGloballyEnabled(undefined));
  assert(pgProbeGloballyEnabled("on"));
  assert(!pgProbeGloballyEnabled("off"));
  assert(!pgProbeGloballyEnabled(" FALSE "));
});

test("host shutting down (systemd stopping) does not emit", async () => {
  const h = harness({ hostStopping: () => Promise.resolve(true) });
  await withAttached(h, () => pollTicks(h, 50));
  assertEquals(h.sent.length, 0);
});

test("daemon shutdown: a tick in flight when detach() runs never sends", async () => {
  let releaseSample: () => void = () => {};
  let markStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let gate = false;
  const h = harness({
    sample: () => {
      if (!gate) return Promise.resolve(DEAD);
      return new Promise<ProbeSample>((resolve) => {
        releaseSample = () => resolve(DEAD);
        markStarted();
      });
    },
  });
  h.observer.attach();
  await pollTicks(h, 5);
  gate = true;
  const inFlight = h.observer.poll();
  await started;
  h.observer.detach();
  releaseSample();
  await inFlight;
  await pollTicks(h, 5);
  assertEquals(h.sent.length, 0);
});

test("control plane without managed-ha-probe-v1: detected but never sent", async () => {
  const h = harness({ peerSupportsProbe: () => false });
  await withAttached(h, () => pollTicks(h, 50));
  assertEquals(h.sent.length, 0);
});

test("an undelivered event is retried on the next tick", async () => {
  let open = false;
  const sent: PgDeadPrimaryEventMessage[] = [];
  const h = harness({
    send: (message) => {
      if (!open) return false;
      sent.push(message);
      return true;
    },
  });
  await withAttached(h, async () => {
    await pollTicks(h, 10);
    assertEquals(sent.length, 0);
    open = true;
    await pollTicks(h, 1);
  });
  assertEquals(sent.length, 1);
});

test("poll before attach (daemon not connected) does nothing", async () => {
  const h = harness();
  await pollTicks(h, 30);
  assertEquals(h.sampled.length, 0);
});

test("a hung docker call is not stacked: later ticks are inconclusive", async () => {
  const calls: string[][] = [];
  let release: () => void = () => {};
  const hung = new Promise<never>((_, reject) => {
    release = () => reject(new Error("released"));
  });
  const h = harness({
    sample: undefined,
    config: { intervalMs: 3_600_000, dockerTimeoutMs: 5 },
    runDocker: (args) => {
      calls.push(args);
      return hung;
    },
  });
  await withAttached(h, () => pollTicks(h, 20));
  release();
  await hung.catch(() => undefined);
  assertEquals(calls.length, 1);
  assertEquals(h.sent.length, 0);
});

const HEALTHY: ProbeSample = {
  container: {
    kind: "present",
    state: {
      status: "running",
      exitCode: 0,
      restartCount: 0,
      startedAt: "2026-09-01T00:00:00Z",
    },
  },
  pgReady: { kind: "exit", code: 0, output: "" },
};

test("reattach discards a stale streak (5 failures, reconnect, 1 failure: no event)", async () => {
  const h = harness();
  h.observer.attach();
  await pollTicks(h, 5);
  h.observer.attach(); // reconnect: attach() detaches first
  try {
    await pollTicks(h, 1);
    assertEquals(h.sent.length, 0);
    await pollTicks(h, 5);
    assertEquals(h.sent.length, 1);
  } finally {
    h.observer.detach();
  }
});

test("a tick gap over 3 intervals resets the streak", async () => {
  const h = harness({ config: { intervalMs: 5_000 } });
  await withAttached(h, async () => {
    await pollTicks(h, 5);
    h.clock.now += 60_000; // suspended / stalled loop
    await pollTicks(h, 1);
    assertEquals(h.sent.length, 0);
    await pollTicks(h, 5);
    assertEquals(h.sent.length, 1);
  });
});

test("a wall-clock step does not shorten graces (monotonic clock drives the detector)", async () => {
  let wall = Date.parse("2026-10-01T00:00:00Z");
  let mono = 0;
  const rejecting: ProbeSample = {
    container: HEALTHY.container,
    pgReady: { kind: "exit", code: 1, output: "" },
    controlData: "in production",
  };
  const sent: PgDeadPrimaryEventMessage[] = [];
  const observer = new PgDeadPrimaryObserver({
    send: (m) => {
      sent.push(m);
      return true;
    },
    peerSupportsProbe: () => true,
    config: { intervalMs: 3_600_000 },
    monoMs: () => mono,
    wallMs: () => wall,
    globallyEnabled: () => true,
    listMembers: () => Promise.resolve([PRIMARY]),
    sample: () => Promise.resolve(rejecting),
    intentState: () => Promise.resolve(intent({})),
    releaseHeld: () => Promise.resolve(),
    holdStop: () => Promise.resolve(),
    hostStopping: () => Promise.resolve(false),
  });
  observer.attach();
  try {
    await Array.from({ length: 30 }).reduce<Promise<void>>(async (prev) => {
      await prev;
      await observer.poll();
      mono += 5_000;
      wall += 3_600_000; // NTP step / VM resume: wall jumps an hour per tick
    }, Promise.resolve());
  } finally {
    observer.detach();
  }
  // 30 ticks = 150 s of monotonic time: inside the 10 min rejecting grace.
  assertEquals(sent.length, 0);
});

test("a held marker is released (and logged) after a sustained healthy run", async () => {
  const released: string[] = [];
  const h = harness({
    sample: () => Promise.resolve(HEALTHY),
    intentState: () =>
      Promise.resolve(intent({ active: true, heldClusterMarker: true })),
    releaseHeld: (id, reason) => {
      released.push(`${id}:${reason}`);
      return Promise.resolve();
    },
  });
  await withAttached(h, async () => {
    await pollTicks(h, 100); // 500 s: not yet
    assertEquals(released.length, 0);
    await pollTicks(h, 30); // past 10 min
  });
  assertEquals(released.length, 1);
  assert(released[0]!.startsWith(MANAGED_ID));
});

test("a held marker is never released while the engine is down", async () => {
  const released: string[] = [];
  const h = harness({
    intentState: () =>
      Promise.resolve(intent({ active: true, heldClusterMarker: true })),
    releaseHeld: (id) => {
      released.push(id);
      return Promise.resolve();
    },
  });
  await withAttached(h, () => pollTicks(h, 300));
  assertEquals(released.length, 0);
  assertEquals(h.sent.length, 0);
});

test("systemdHostBlocksEmit fails closed when systemctl is unusable", async () => {
  // On a host without systemd (or when the call cannot run) the answer must
  // be "do not send".
  if (Deno.build.os === "linux") return;
  assertEquals(await systemdHostBlocksEmit(500), true);
});

test("a stop interrupted by a daemon restart is held once the engine is seen down", async () => {
  const held: string[] = [];
  const h = harness({
    intentState: () =>
      Promise.resolve(
        intent({
          active: true,
          heldClusterMarker: true,
          runningKind: "stop",
          noClusterMarker: false,
        }),
      ),
    holdStop: (id) => {
      held.push(id);
      return Promise.resolve();
    },
  });
  await withAttached(h, () => pollTicks(h, 20));
  assertEquals(held, [MANAGED_ID]);
  assertEquals(h.sent.length, 0);
});

test("a stopped primary with no marker at start is not silently held (probed as dead)", async () => {
  const held: string[] = [];
  const h = harness({
    holdStop: (id) => {
      held.push(id);
      return Promise.resolve();
    },
  });
  await withAttached(h, () => pollTicks(h, 20));
  assertEquals(held.length, 0);
  assertEquals(h.sent.length, 1);
});

test("an unreadable marker is released after a sustained healthy run", async () => {
  const released: string[] = [];
  const h = harness({
    sample: () => Promise.resolve(HEALTHY),
    intentState: () =>
      Promise.resolve(
        intent({
          active: true,
          heldClusterMarker: true,
          unreadableReason: "torn",
          noClusterMarker: false,
        }),
      ),
    releaseHeld: (id, reason) => {
      released.push(`${id}:${reason}`);
      return Promise.resolve();
    },
  });
  await withAttached(h, () => pollTicks(h, 130));
  assertEquals(released.length, 1);
});

test("an unreadable marker is released after 6 h even while the engine is down", async () => {
  const released: string[] = [];
  const h = harness({
    intentState: () =>
      Promise.resolve(
        intent({
          active: true,
          heldClusterMarker: true,
          unreadableReason: "torn",
          noClusterMarker: false,
        }),
      ),
    releaseHeld: (id, reason) => {
      released.push(`${id}:${reason}`);
      return Promise.resolve();
    },
  });
  await withAttached(h, async () => {
    await pollTicks(h, 2);
    assertEquals(released.length, 0);
    h.clock.now += 6 * 3_600_000;
    await pollTicks(h, 1);
  });
  assertEquals(released.length, 1);
  assert(released[0]!.includes("unreadable"));
});

test("a running marker owned by this process is not released by a healthy run", async () => {
  // The default intentState marks only disk-left running markers as
  // releasable; an in-process running marker reports heldClusterMarker=false.
  const released: string[] = [];
  const h = harness({
    sample: () => Promise.resolve(HEALTHY),
    intentState: () =>
      Promise.resolve(
        intent({
          active: true,
          heldClusterMarker: false,
          runningKind: "apply",
          noClusterMarker: false,
        }),
      ),
    releaseHeld: (id) => {
      released.push(id);
      return Promise.resolve();
    },
  });
  await withAttached(h, () => pollTicks(h, 200));
  assertEquals(released.length, 0);
});

test("a hung primary (no response, postmaster alive) is logged but not reported inside its grace", async () => {
  const hung: ProbeSample = {
    container: HEALTHY.container,
    pgReady: { kind: "exit", code: 2, output: "" },
    postmaster: "running",
  };
  let healthy = false;
  const h = harness({
    sample: () => Promise.resolve(healthy ? HEALTHY : hung),
  });
  await withAttached(h, async () => {
    await pollTicks(h, 50); // ~4 min: soft, logged each minute
    healthy = true;
    await pollTicks(h, 2); // leaves the soft state
  });
  assertEquals(h.sent.length, 0);
});

test("the observer re-sends while the primary stays dead, then stops at the per-incident bound", async () => {
  const h = harness();
  await withAttached(h, () => pollTicks(h, (3 * 3_600_000) / 5_000));
  assertEquals(h.sent.map((e) => e.evidence.attempt), [1, 2, 3, 4, 5]);
});

test("startup check waits for a conclusive Docker read and survives a failing holdStop", async () => {
  let reads = 0;
  const held: string[] = [];
  const h = harness({
    sample: () => {
      reads += 1;
      return Promise.resolve(
        reads === 1
          ? { container: { kind: "unreadable", reason: "dockerd starting" } }
          : DEAD,
      );
    },
    intentState: () =>
      Promise.resolve(
        intent({
          active: true,
          heldClusterMarker: true,
          runningKind: "stop",
          noClusterMarker: false,
        }),
      ),
    holdStop: (id) => {
      held.push(id);
      return Promise.reject(new Error("disk full"));
    },
  });
  await withAttached(h, () => pollTicks(h, 3));
  // First tick unreadable: not checked; second tick: checked once, error caught.
  assertEquals(held, [MANAGED_ID]);
  assertEquals(h.sent.length, 0);
});
