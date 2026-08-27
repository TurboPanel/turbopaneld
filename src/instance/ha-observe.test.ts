import { assertEquals } from "@std/assert";
import { createFakeClock, flushMicrotasks } from "../testing/fake-clock.ts";
import type { OrchestratorProblem } from "../managed/orchestrator-api.ts";
import { type ManagedHaEventMessage, ManagedHaObserver } from "./ha-observe.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const MANAGED_ID = "00000000-0000-4000-8000-0000000000aa";

function problemResponse(problems: OrchestratorProblem[]): Response {
  return new Response(JSON.stringify(problems), { status: 200 });
}

test("ManagedHaObserver.attach schedules poll and detach clears the timer", async () => {
  const sent: ManagedHaEventMessage[] = [];
  const clock = createFakeClock();
  const observer = new ManagedHaObserver({
    intervalMs: 20,
    now: () => new Date(clock.now()).toISOString(),
    send: (message) => {
      sent.push(message);
    },
    isStackPresent: () => Promise.resolve(true),
    api: {
      credentials: { user: "admin", password: "x" },
      fetch: () =>
        Promise.resolve(
          problemResponse([{
            clusterAlias: MANAGED_ID,
            key: { hostname: "db-1", port: 5432 },
            problems: ["DeadPrimary"],
          }]),
        ),
    },
  });

  observer.attach();
  await new Promise((resolve) => setTimeout(resolve, 45));
  await flushMicrotasks();
  observer.detach();
  const afterDetach = sent.length;
  await new Promise((resolve) => setTimeout(resolve, 45));
  await flushMicrotasks();

  assertEquals(afterDetach >= 1, true);
  assertEquals(sent.length, afterDetach);
  assertEquals(sent[0]?.type, "managed-ha-event");
  assertEquals(sent[0]?.managedId, MANAGED_ID);
});

test("ManagedHaObserver ignores non-dead-primary problems and missing problem names", async () => {
  const sent: ManagedHaEventMessage[] = [];
  const observer = new ManagedHaObserver({
    send: (message) => {
      sent.push(message);
    },
    isStackPresent: () => Promise.resolve(true),
    api: {
      credentials: { user: "admin", password: "x" },
      fetch: () =>
        Promise.resolve(
          problemResponse([
            {
              clusterAlias: MANAGED_ID,
              key: { hostname: "db-1", port: 5432 },
              problems: ["LaggingReplica"],
            },
            {
              clusterAlias: "00000000-0000-4000-8000-0000000000bb",
              key: { hostname: "db-2" },
            },
          ]),
        ),
    },
  });
  await observer.poll();
  assertEquals(sent.length, 0);
});

test("ManagedHaObserver swallows poll failures without throwing", async () => {
  const sent: ManagedHaEventMessage[] = [];
  const observer = new ManagedHaObserver({
    send: (message) => {
      sent.push(message);
    },
    isStackPresent: () => Promise.resolve(true),
    api: {
      credentials: { user: "admin", password: "x" },
      fetch: () => Promise.reject(new Error("orchestrator down")),
    },
  });
  await observer.poll();
  assertEquals(sent.length, 0);
});

test("ManagedHaObserver uses injected now() for the emitted at timestamp", async () => {
  const sent: ManagedHaEventMessage[] = [];
  const observer = new ManagedHaObserver({
    now: () => "2026-08-25T12:00:00.000Z",
    send: (message) => {
      sent.push(message);
    },
    isStackPresent: () => Promise.resolve(true),
    api: {
      credentials: { user: "admin", password: "x" },
      fetch: () =>
        Promise.resolve(
          problemResponse([{
            clusterAlias: MANAGED_ID,
            problems: ["UnreachablePrimary"],
          }]),
        ),
    },
  });
  await observer.poll();
  assertEquals(sent.length, 1);
  assertEquals(sent[0]?.at, "2026-08-25T12:00:00.000Z");
});

test("ManagedHaObserver skips absent stack, invalid aliases, and duplicate keys", async () => {
  const sent: ManagedHaEventMessage[] = [];
  const absent = new ManagedHaObserver({
    send: (message) => {
      sent.push(message);
    },
    isStackPresent: () => Promise.resolve(false),
    api: {
      credentials: { user: "admin", password: "x" },
      fetch: () => {
        throw new TypeError("orchestrator must not be queried");
      },
    },
  });
  await absent.poll();
  assertEquals(sent.length, 0);

  const observer = new ManagedHaObserver({
    send: (message) => {
      sent.push(message);
    },
    isStackPresent: () => Promise.resolve(true),
    api: {
      credentials: { user: "admin", password: "x" },
      fetch: () =>
        Promise.resolve(
          problemResponse([
            {
              clusterAlias: "not-a-uuid",
              key: { hostname: "db-1", port: 5432 },
              problems: ["DeadPrimary"],
            },
            {
              clusterAlias: "",
              problems: ["DeadPrimary"],
            },
            {
              clusterAlias: MANAGED_ID,
              key: { hostname: "db-1", port: 5432 },
              problems: ["DeadPrimary"],
            },
          ]),
        ),
    },
  });
  await observer.poll();
  await observer.poll();
  assertEquals(sent.length, 1);
  assertEquals(sent[0]?.managedId, MANAGED_ID);
});
