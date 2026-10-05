import { assertEquals, assertRejects } from "@std/assert";
import type { ContainerInspect } from "../docker/client.ts";
import {
  CrashLoopGuard,
  stopCrashLoopingContainer,
} from "./crash-loop-guard.ts";
import {
  containerRunState,
  deriveServiceRunStates,
  type ServiceContainerObservation,
  wantsLastLogLine,
} from "./service-run-state.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const NOW = Date.parse("2026-10-05T12:00:00.000Z");

function ago(seconds: number): string {
  return new Date(NOW - seconds * 1000).toISOString();
}

type Shape = {
  restartCount: number;
  startedAgo?: number;
  finishedAgo?: number;
  exitCode?: number;
};

function observe(
  status: string,
  shape: Shape,
  id = "c1",
): ServiceContainerObservation {
  const inspect: ContainerInspect = {
    Id: id,
    Name: `/${id}`,
    Image: "img",
    RestartCount: shape.restartCount,
    State: {
      Status: status,
      Running: status === "running",
      Paused: false,
      Restarting: status === "restarting",
      Dead: false,
      Pid: 1,
      ExitCode: shape.exitCode ?? 1,
      ...(shape.startedAgo === undefined
        ? {}
        : { StartedAt: ago(shape.startedAgo) }),
      ...(shape.finishedAgo === undefined
        ? {}
        : { FinishedAt: ago(shape.finishedAgo) }),
    },
  };
  return { serviceId: "svc-1", containerId: id, inspect };
}

/** A guard whose stops are recorded and settle on the next microtask turn. */
function guardWithStops(fail = false) {
  const stops: string[] = [];
  const guard = new CrashLoopGuard((id) => {
    stops.push(id);
    return fail
      ? Promise.reject(new Error("docker unavailable"))
      : Promise.resolve();
  });
  return { guard, stops };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A fast loop: each run lasts a second, so it never proves itself. */
const loop = (restartCount: number) =>
  observe("restarting", { restartCount, startedAgo: 2, finishedAgo: 1 });

test("a container below the limit is left to Docker", async () => {
  const { guard, stops } = guardWithStops();
  guard.review([loop(9)], NOW);
  await settle();
  assertEquals(stops, []);
});

test("the tenth restart in a row stops the container once and marks it", async () => {
  const { guard, stops } = guardWithStops();
  guard.review([loop(1)], NOW);
  const [at9] = guard.review([loop(9)], NOW);
  assertEquals(at9?.crashStreak, 9);
  assertEquals(stops, []);

  guard.review([loop(10)], NOW);
  guard.review([loop(11)], NOW);
  assertEquals(stops, ["c1"]);
  await settle();

  // Docker now reports it down, the exit code kept: still stopped after crashes.
  const [down] = guard.review([observe("exited", {
    restartCount: 11,
    startedAgo: 2,
    finishedAgo: 1,
    exitCode: 0,
  })], NOW);
  assertEquals(down?.crashStopped, true);
  assertEquals(containerRunState(down!, NOW), "stopped_after_crashes");
  assertEquals(wantsLastLogLine(down!), true);
  guard.review([down!], NOW);
  assertEquals(stops, ["c1"]);
});

test("a container first seen failing carries its whole count", async () => {
  const { guard, stops } = guardWithStops();
  guard.review([loop(11)], NOW);
  assertEquals(stops, ["c1"]);
  await settle();
});

test("a container first seen running keeps its history out of the streak", async () => {
  const { guard, stops } = guardWithStops();
  guard.review(
    [observe("running", { restartCount: 25, startedAgo: 600 })],
    NOW,
  );
  const [crashing] = guard.review([loop(27)], NOW);
  assertEquals(crashing?.crashStreak, 2);
  await settle();
  assertEquals(stops, []);
});

test("staying up for 60 seconds starts the count again", async () => {
  const { guard, stops } = guardWithStops();
  guard.review([loop(8)], NOW);
  const [stable] = guard.review(
    [observe("running", { restartCount: 8, startedAgo: 61 })],
    NOW,
  );
  assertEquals(stable?.crashStreak, 0);
  const [after] = guard.review([loop(12)], NOW);
  assertEquals(after?.crashStreak, 4);
  await settle();
  assertEquals(stops, []);
});

test("a long last run before a crash does not count toward the loop", async () => {
  const { guard, stops } = guardWithStops();
  guard.review([loop(8)], NOW);
  const [crash] = guard.review([observe("restarting", {
    restartCount: 9,
    startedAgo: 400,
    finishedAgo: 1,
  })], NOW);
  assertEquals(crash?.crashStreak, 0);
  await settle();
  assertEquals(stops, []);
});

test("a manual start zeroes Docker's count and clears the stop", async () => {
  const { guard, stops } = guardWithStops();
  guard.review([loop(10)], NOW);
  await settle();
  const [down] = guard.review([observe("exited", {
    restartCount: 10,
    startedAgo: 2,
    finishedAgo: 1,
  })], NOW);
  assertEquals(down?.crashStopped, true);

  // Stale data of the same run does not clear the mark.
  const [stale] = guard.review([loop(10)], NOW);
  assertEquals(stale?.crashStopped, true);

  const [started] = guard.review([
    observe("running", { restartCount: 0, startedAgo: 3 }),
  ], NOW);
  assertEquals(started?.crashStopped, false);
  assertEquals(started?.crashStreak, 0);
  assertEquals(stops, ["c1"]);
});

test("a failed stop is tried again on the next review", async () => {
  const { guard, stops } = guardWithStops(true);
  guard.review([loop(10)], NOW);
  await settle();
  const [again] = guard.review([loop(11)], NOW);
  assertEquals(again?.crashStopped, false);
  assertEquals(stops, ["c1", "c1"]);
});

test("a stopped container that is gone is forgotten", async () => {
  const { guard, stops } = guardWithStops();
  guard.review([loop(10)], NOW);
  await settle();
  guard.review([], NOW);
  guard.review([loop(10)], NOW);
  assertEquals(stops, ["c1", "c1"]);
  await settle();
});

test("the service reports stopped after crashes with the last error", async () => {
  const { guard } = guardWithStops();
  guard.review([loop(10)], NOW);
  await settle();
  const [down] = guard.review([{
    ...observe("exited", {
      restartCount: 10,
      startedAgo: 2,
      finishedAgo: 1,
      exitCode: 0,
    }),
    lastLogLine: "Error: listen EADDRINUSE :::3000",
  }], NOW);
  const [state] = deriveServiceRunStates([down!], NOW);
  assertEquals(state?.state, "stopped_after_crashes");
  assertEquals(state?.restartCount, 10);
  assertEquals(state?.lastError, "Error: listen EADDRINUSE :::3000");
});

test("an exited container's streak, not Docker's lifetime count, decides stopped after crashes", () => {
  const obs = { ...observe("exited", { restartCount: 12 }), crashStreak: 2 };
  assertEquals(containerRunState(obs, NOW), "stopped");
});

test("stopCrashLoopingContainer runs docker stop and reports a refusal", async () => {
  const calls: string[][] = [];
  await stopCrashLoopingContainer("abc", (args) => {
    calls.push(args);
    return Promise.resolve({
      success: true,
      code: 0,
      stdout: "abc",
      stderr: "",
    });
  });
  assertEquals(calls, [["stop", "--time", "10", "abc"]]);
  await assertRejects(
    () =>
      stopCrashLoopingContainer("abc", () =>
        Promise.resolve({
          success: false,
          code: 1,
          stdout: "",
          stderr: "permission denied",
        })),
    Error,
    "docker stop failed: permission denied",
  );
});
