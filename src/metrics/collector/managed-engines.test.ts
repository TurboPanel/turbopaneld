/**
 * Host-free coverage for the managed-engine census: label-only discovery,
 * per-engine null-vs-number semantics, the runtime probe, and the sampler's
 * cache/timer discipline.
 */

import { assertEquals } from "@std/assert";
import type { ContainerSummary } from "../../docker/client.ts";
import type { ManagedEngineContext } from "../../managed/engines/types.ts";
import {
  emptyManagedEngineCensus,
  MANAGED_ENGINE_CENSUS_REFRESH_INTERVAL_MS,
  MANAGED_ENGINE_LABEL,
  type ManagedEngineCensusDeps,
  type ManagedEngineCensusRuntime,
  managedEngineContainers,
  ManagedEngineSampler,
  readManagedEngineCensus,
} from "./managed-engines.ts";
import { MANAGED_ENGINE_LABEL as COMPOSE_LABEL } from "../../managed/compose.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test} — Sonar typescript:S2187 only
 * recognizes `test()` / `it()` / `describe()`.
 */
const test = Deno.test.bind(Deno);

function container(
  id: string,
  engine: string | null,
  state: string,
  service = engine ?? "svc",
): ContainerSummary {
  return {
    Id: id,
    Names: [`/${id}`],
    Image: "registry.example/mirror@sha256:deadbeef",
    State: state,
    Status: state === "running" ? "Up 3 hours" : "Exited (0) 2 hours ago",
    Labels: {
      "com.docker.compose.project": "00000000-0000-4000-8000-000000000001",
      "com.docker.compose.service": service,
      ...(engine ? { [MANAGED_ENGINE_LABEL]: engine } : {}),
    },
    Ports: [],
  };
}

/** A runtime whose census is scripted per container id. */
function runtime(
  answers: Record<
    string,
    { healthy: boolean; used: number | null; max: number | null } | "throw"
  >,
  calls: string[] = [],
): ManagedEngineCensusRuntime {
  return {
    rootUsername: "root",
    defaultDatabase: "appdb",
    readCensus(ctx: ManagedEngineContext) {
      calls.push(`${ctx.containerId}:${ctx.composeServiceName}`);
      const answer = answers[ctx.containerId];
      if (answer === undefined) return Promise.reject(new Error("unscripted"));
      if (answer === "throw") return Promise.reject(new Error("boom"));
      return Promise.resolve({
        healthy: answer.healthy,
        connectionsUsed: answer.used,
        connectionsMax: answer.max,
      });
    },
  };
}

const NEVER_EXEC: ManagedEngineCensusDeps["exec"] = () =>
  Promise.reject(new Error("exec must go through the runtime"));

test("the compose label and the census discovery key are the same string", () => {
  assertEquals(MANAGED_ENGINE_LABEL, COMPOSE_LABEL);
});

test("managedEngineContainers finds engines by label only — image names and unlabelled containers never count", () => {
  const found = managedEngineContainers([
    container("pg1", "postgres", "running"),
    container("my1", "mysql", "exited"),
    container("ma1", "mariadb", "running", "db"),
    // Looks like Postgres by image, but is not a managed engine.
    { ...container("stray", null, "running"), Image: "postgres:16" },
    // A managed engine the family has no group for.
    container("cache", "redis", "running"),
    { ...container("blank", "postgres", "running"), Id: "" },
  ]);
  assertEquals(found, [
    {
      containerId: "pg1",
      engine: "postgres",
      composeServiceName: "postgres",
      running: true,
    },
    {
      containerId: "my1",
      engine: "mysql",
      composeServiceName: "mysql",
      running: false,
    },
    {
      containerId: "ma1",
      engine: "mariadb",
      composeServiceName: "db",
      running: true,
    },
  ]);
});

test("readManagedEngineCensus: an engine with no container stays null; one with containers reports counts", async () => {
  const calls: string[] = [];
  const reading = await readManagedEngineCensus({
    listContainers: () =>
      Promise.resolve([
        container("pg1", "postgres", "running"),
        container("pg2", "postgres", "running"),
        container("pg3", "postgres", "exited"),
        container("my1", "mysql", "exited"),
      ]),
    runtimeFor: (engine) =>
      engine === "postgres"
        ? runtime({
          pg1: { healthy: true, used: 7, max: 100 },
          pg2: { healthy: false, used: null, max: null },
        }, calls)
        : runtime({}, calls),
    exec: NEVER_EXEC,
  });
  // Three Postgres containers, two running, one of those answering its probe.
  assertEquals(reading.postgres, {
    instancesRunning: 2,
    instancesHealthy: 1,
    connectionsUsed: 7,
    connectionsMax: 100,
  });
  // MySQL is present but stopped: real zeros, and no probe was attempted.
  assertEquals(reading.mysql, {
    instancesRunning: 0,
    instancesHealthy: 0,
    connectionsUsed: null,
    connectionsMax: null,
  });
  // No MariaDB on this host at all: null, never 0.
  assertEquals(reading.mariadb, emptyManagedEngineCensus().mariadb);
  // Only running instances are probed, with their compose service name.
  assertEquals(calls, ["pg1:postgres", "pg2:postgres"]);
});

test("readManagedEngineCensus sums connections across the instances that answered and tolerates a throwing probe", async () => {
  const reading = await readManagedEngineCensus({
    listContainers: () =>
      Promise.resolve([
        container("ma1", "mariadb", "running"),
        container("ma2", "mariadb", "running"),
        container("ma3", "mariadb", "running"),
      ]),
    runtimeFor: () =>
      runtime({
        ma1: { healthy: true, used: 3, max: 50 },
        ma2: { healthy: true, used: null, max: null },
        ma3: "throw",
      }),
    exec: NEVER_EXEC,
  });
  assertEquals(reading.mariadb, {
    instancesRunning: 3,
    // ma2 is up but its census was refused; ma3's probe threw (unread, not down).
    instancesHealthy: 2,
    connectionsUsed: 3,
    connectionsMax: 50,
  });
});

test("readManagedEngineCensus: a runtime without a probe reports running but leaves health null", async () => {
  const reading = await readManagedEngineCensus({
    listContainers: () =>
      Promise.resolve([container("my1", "mysql", "running")]),
    runtimeFor: () => ({ rootUsername: "root", defaultDatabase: "appdb" }),
    exec: NEVER_EXEC,
  });
  assertEquals(reading.mysql, {
    instancesRunning: 1,
    instancesHealthy: null,
    connectionsUsed: null,
    connectionsMax: null,
  });
  const unknownRuntime = await readManagedEngineCensus({
    listContainers: () =>
      Promise.resolve([container("my1", "mysql", "running")]),
    runtimeFor: () => null,
    exec: NEVER_EXEC,
  });
  assertEquals(unknownRuntime.mysql.instancesRunning, 1);
  assertEquals(unknownRuntime.mysql.instancesHealthy, null);
});

test("the census context execs against the instance's own container id", async () => {
  const execCalls: string[] = [];
  await readManagedEngineCensus({
    listContainers: () =>
      Promise.resolve([container("pg1", "postgres", "running")]),
    runtimeFor: () => ({
      rootUsername: "postgres",
      defaultDatabase: "postgres",
      async readCensus(ctx) {
        const result = await ctx.exec(
          ["pg_isready", "-U", ctx.rootUsername],
          undefined,
        );
        return {
          healthy: result.success,
          connectionsUsed: null,
          connectionsMax: null,
        };
      },
    }),
    exec: (containerId, argv) => {
      execCalls.push(`${containerId} ${argv.join(" ")}`);
      return Promise.resolve({ success: true, stdout: "", stderr: "" });
    },
  });
  assertEquals(execCalls, ["pg1 pg_isready -U postgres"]);
});

test("ManagedEngineSampler caches the last census, keeps it across a failed poll, and reports null before the first", async () => {
  let fail = false;
  let listed = 0;
  const errors: unknown[] = [];
  const sampler = new ManagedEngineSampler({
    listContainers: () => {
      listed += 1;
      if (fail) return Promise.reject(new Error("socket gone"));
      return Promise.resolve([container("pg1", "postgres", "running")]);
    },
    runtimeFor: () => runtime({ pg1: { healthy: true, used: 1, max: 10 } }),
    exec: NEVER_EXEC,
    onError: (error) => errors.push(error),
  });
  assertEquals(sampler.latest(), null);
  await sampler.refresh();
  assertEquals(sampler.latest()?.postgres.instancesRunning, 1);
  assertEquals(sampler.latest()?.postgres.connectionsMax, 10);
  fail = true;
  await sampler.refresh();
  assertEquals(errors.length, 1);
  assertEquals(sampler.latest()?.postgres.instancesRunning, 1);
  assertEquals(listed, 2);
});

test("ManagedEngineSampler.start polls on its own slow interval and stop clears it", async () => {
  const intervals: number[] = [];
  let cleared = 0;
  const handle = 42 as unknown as ReturnType<typeof setInterval>;
  const sampler = new ManagedEngineSampler({
    listContainers: () => Promise.resolve([]),
    runtimeFor: () => null,
    exec: NEVER_EXEC,
    setIntervalFn: ((_fn: () => void, ms: number) => {
      intervals.push(ms);
      return handle;
    }) as unknown as typeof setInterval,
    clearIntervalFn: ((h: unknown) => {
      if (h === handle) cleared += 1;
    }) as unknown as typeof clearInterval,
  });
  sampler.start();
  sampler.start();
  await Promise.resolve();
  assertEquals(intervals, [MANAGED_ENGINE_CENSUS_REFRESH_INTERVAL_MS]);
  sampler.stop();
  sampler.stop();
  assertEquals(cleared, 1);
  // No Docker containers at all: every engine null, but a reading exists.
  await sampler.refresh();
  assertEquals(sampler.latest(), emptyManagedEngineCensus());
});
