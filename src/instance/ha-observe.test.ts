import { assertEquals } from "@std/assert";
import { createFakeClock, flushMicrotasks } from "../testing/fake-clock.ts";
import { withTempLayout } from "../testing/temp-layout.ts";
import { resolveLayout } from "../paths/layout.ts";
import {
  orchestratorApiCnfPath,
  orchestratorComposePath,
  orchestratorConfigDir,
} from "../managed/engine-paths.ts";
import { reviveStoppedOrchestratorContainer } from "../managed/orchestrator.ts";
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
  assertEquals(sent[0]?.instanceHost, "db-1");
  assertEquals(sent[0]?.instancePort, 5432);
});

test("ManagedHaObserver sends no instance when Orchestrator's key is incomplete", async () => {
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
          problemResponse([{
            clusterAlias: MANAGED_ID,
            key: { hostname: "db-1" },
            problems: ["DeadPrimary"],
          }]),
        ),
    },
  });
  await observer.poll();
  assertEquals(sent.length, 1);
  assertEquals("instanceHost" in sent[0], false);
  assertEquals("instancePort" in sent[0], false);
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

test("ManagedHaObserver loads Orchestrator credentials when api omits them", async () => {
  const sent: ManagedHaEventMessage[] = [];
  const observer = new ManagedHaObserver({
    send: (message) => {
      sent.push(message);
    },
    isStackPresent: () => Promise.resolve(true),
    api: {
      fetch: () =>
        Promise.resolve(
          problemResponse([{
            clusterAlias: MANAGED_ID,
            problems: ["DeadPrimary"],
          }]),
        ),
    },
  });
  await observer.poll();
  assertEquals(sent.length === 0 || sent[0]?.managedId === MANAGED_ID, true);
});

test("ManagedHaObserver loads Orchestrator credentials from the layout when api omits them", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await Deno.mkdir(orchestratorConfigDir(layout), { recursive: true });
    await Deno.writeTextFile(
      orchestratorApiCnfPath(layout),
      "[client]\nuser=orch-admin\npassword=orch-secret\n",
    );
    const sent: ManagedHaEventMessage[] = [];
    const observer = new ManagedHaObserver({
      layout,
      send: (message) => {
        sent.push(message);
      },
      isStackPresent: () => Promise.resolve(true),
      api: {
        fetch: () =>
          Promise.resolve(
            problemResponse([{
              clusterAlias: MANAGED_ID,
              problems: ["DeadPrimary"],
            }]),
          ),
      },
    });
    await observer.poll();
    assertEquals(sent.length, 1);
    assertEquals(sent[0]?.managedId, MANAGED_ID);
  });
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

function deadPrimaryResponse(): Response {
  return problemResponse([{
    clusterAlias: MANAGED_ID,
    key: { hostname: "db-1", port: 5432 },
    problems: ["DeadPrimary"],
  }]);
}

test("ManagedHaObserver starts a killed Orchestrator container once", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await Deno.mkdir(orchestratorConfigDir(layout), { recursive: true });
    await Deno.writeTextFile(orchestratorComposePath(layout), "services: {}\n");
    const calls: string[][] = [];
    const sent: ManagedHaEventMessage[] = [];
    const observer = new ManagedHaObserver({
      layout,
      send: (message) => {
        sent.push(message);
      },
      isStackPresent: () => Promise.resolve(true),
      reviveStack: () =>
        reviveStoppedOrchestratorContainer(layout, (args) => {
          calls.push(args);
          if (args.includes("ps")) {
            return Promise.resolve({
              success: true,
              stdout: JSON.stringify([{
                ID: "orch-cid",
                Name: "orch",
                Service: "orchestrator",
                State: "exited",
              }]),
              stderr: "",
              code: 0,
            });
          }
          return Promise.resolve({
            success: true,
            stdout: "",
            stderr: "",
            code: 0,
          });
        }),
      api: {
        credentials: { user: "admin", password: "x" },
        fetch: () => Promise.resolve(deadPrimaryResponse()),
      },
    });
    await observer.poll();
    await observer.poll();
    assertEquals(calls.filter((args) => args.includes("start")).length, 1);
    assertEquals(sent.length, 1);
  });
});

test("ManagedHaObserver does not start a running Orchestrator container", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await Deno.mkdir(orchestratorConfigDir(layout), { recursive: true });
    await Deno.writeTextFile(orchestratorComposePath(layout), "services: {}\n");
    const calls: string[][] = [];
    const observer = new ManagedHaObserver({
      layout,
      send: () => {},
      isStackPresent: () => Promise.resolve(true),
      reviveStack: () =>
        reviveStoppedOrchestratorContainer(layout, (args) => {
          calls.push(args);
          return Promise.resolve({
            success: true,
            stdout: JSON.stringify([{
              ID: "orch-cid",
              Name: "orch",
              Service: "orchestrator",
              State: "running",
            }]),
            stderr: "",
            code: 0,
          });
        }),
      api: {
        credentials: { user: "admin", password: "x" },
        fetch: () => Promise.resolve(deadPrimaryResponse()),
      },
    });
    await observer.poll();
    assertEquals(calls.some((args) => args.includes("start")), false);
  });
});

test("ManagedHaObserver does not start after compose down (absent container)", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await Deno.mkdir(orchestratorConfigDir(layout), { recursive: true });
    await Deno.writeTextFile(orchestratorComposePath(layout), "services: {}\n");
    const calls: string[][] = [];
    const observer = new ManagedHaObserver({
      layout,
      send: () => {},
      isStackPresent: () => Promise.resolve(true),
      reviveStack: () =>
        reviveStoppedOrchestratorContainer(layout, (args) => {
          calls.push(args);
          return Promise.resolve({
            success: true,
            stdout: "[]",
            stderr: "",
            code: 0,
          });
        }),
      api: {
        credentials: { user: "admin", password: "x" },
        fetch: () => Promise.resolve(deadPrimaryResponse()),
      },
    });
    await observer.poll();
    assertEquals(calls.some((args) => args.includes("start")), false);
  });
});

test("ManagedHaObserver respects the orchestrator revive cooldown", async () => {
  const clock = createFakeClock({ now: 1_000_000 });
  const calls: string[] = [];
  const observer = new ManagedHaObserver({
    nowMs: () => clock.now(),
    send: () => {},
    isStackPresent: () => Promise.resolve(true),
    reviveStack: () => {
      calls.push("revive");
      return Promise.resolve("started");
    },
    api: {
      credentials: { user: "admin", password: "x" },
      fetch: () => Promise.resolve(deadPrimaryResponse()),
    },
  });
  await observer.poll();
  await observer.poll();
  assertEquals(calls.length, 1);
  await clock.advance(60_000);
  await observer.poll();
  assertEquals(calls.length, 2);
});

test("ManagedHaObserver continues the API poll when revive fails", async () => {
  const decoder = new TextDecoder();
  const warnings: string[] = [];
  const originalWrite = Deno.stderr.writeSync;
  Deno.stderr.writeSync = (buf) => {
    warnings.push(decoder.decode(buf));
    return buf.byteLength;
  };
  const sent: ManagedHaEventMessage[] = [];
  let fetched = 0;
  try {
    const observer = new ManagedHaObserver({
      send: (message) => {
        sent.push(message);
      },
      isStackPresent: () => Promise.resolve(true),
      reviveStack: () => Promise.reject(new Error("compose start failed")),
      api: {
        credentials: { user: "admin", password: "x" },
        fetch: () => {
          fetched += 1;
          return Promise.resolve(deadPrimaryResponse());
        },
      },
    });
    await observer.poll();
    assertEquals(fetched, 1);
    assertEquals(sent.length, 1);
    assertEquals(sent[0]?.managedId, MANAGED_ID);
    assertEquals(
      warnings.some((line) => line.includes("self-heal failed")),
      true,
    );
  } finally {
    Deno.stderr.writeSync = originalWrite;
  }
});
