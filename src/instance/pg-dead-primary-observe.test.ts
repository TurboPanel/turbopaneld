import { assert, assertEquals } from "@std/assert";
import type { ManagedHaMemberRecord } from "../managed/ha-member.ts";
import type { ProbeSample } from "../managed/pg-dead-primary.ts";
import {
  isWatchedPrimary,
  type PgDeadPrimaryEventMessage,
  PgDeadPrimaryObserver,
  type PgDeadPrimaryObserverOptions,
  pgProbeGloballyEnabled,
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
    nowMs: () => clock.now,
    globallyEnabled: () => true,
    listMembers: () => Promise.resolve(members),
    sample: (name) => {
      sampled.push(name);
      return Promise.resolve(DEAD);
    },
    intentActive: () => Promise.resolve(false),
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
  const h = harness({ intentActive: () => Promise.resolve(true) });
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
