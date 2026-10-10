import { assertEquals } from "@std/assert";
import type { ContainerInspect } from "../docker/client.ts";
import {
  containerRunState,
  deriveServiceRunStates,
  fetchContainerLastLogLine,
  type ServiceContainerObservation,
  serviceIdForContainer,
  ServiceRunStateStamper,
  wantsLastLogLine,
} from "./service-run-state.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const NOW = Date.parse("2026-10-04T12:00:00.000Z");

function secondsAgo(seconds: number): string {
  return new Date(NOW - seconds * 1000).toISOString();
}

function observe(
  status: string,
  options: {
    serviceId?: string;
    startedSecondsAgo?: number;
    exitCode?: number;
    restartCount?: number;
    health?: string;
    lastLogLine?: string;
  } = {},
): ServiceContainerObservation {
  const inspect: ContainerInspect = {
    Id: "c1",
    Name: "/c1",
    Image: "img",
    RestartCount: options.restartCount ?? 0,
    State: {
      Status: status,
      Running: status === "running",
      Paused: status === "paused",
      Restarting: status === "restarting",
      Dead: status === "dead",
      Pid: 1,
      ExitCode: options.exitCode ?? 0,
      ...(options.startedSecondsAgo === undefined
        ? {}
        : { StartedAt: secondsAgo(options.startedSecondsAgo) }),
      ...(options.health ? { Health: { Status: options.health } } : {}),
    },
  };
  return {
    serviceId: options.serviceId ?? "svc-1",
    containerId: "c1",
    inspect,
    ...(options.lastLogLine ? { lastLogLine: options.lastLogLine } : {}),
  };
}

test("a container is only running after 60 seconds up", () => {
  assertEquals(
    containerRunState(observe("running", { startedSecondsAgo: 59 }), NOW),
    "starting",
  );
  assertEquals(
    containerRunState(observe("running", { startedSecondsAgo: 60 }), NOW),
    "running",
  );
  assertEquals(
    containerRunState(observe("running", { startedSecondsAgo: 600 }), NOW),
    "running",
  );
});

test("a running container with no readable start time is not yet running", () => {
  assertEquals(containerRunState(observe("running"), NOW), "starting");
});

test("health checks hold or break the running state", () => {
  assertEquals(
    containerRunState(
      observe("running", { startedSecondsAgo: 600, health: "starting" }),
      NOW,
    ),
    "starting",
  );
  assertEquals(
    containerRunState(
      observe("running", { startedSecondsAgo: 600, health: "unhealthy" }),
      NOW,
    ),
    "unhealthy",
  );
});

test("a restarting container is crashing, never running", () => {
  assertEquals(
    containerRunState(
      observe("restarting", { startedSecondsAgo: 2, restartCount: 4 }),
      NOW,
    ),
    "crashing",
  );
});

test("down with a failure at 10 restarts is stopped after crashes", () => {
  assertEquals(
    containerRunState(
      observe("exited", { exitCode: 1, restartCount: 10 }),
      NOW,
    ),
    "stopped_after_crashes",
  );
  assertEquals(
    containerRunState(
      observe("exited", { exitCode: 1, restartCount: 9 }),
      NOW,
    ),
    "stopped",
  );
  assertEquals(
    containerRunState(
      observe("exited", { exitCode: 0, restartCount: 12 }),
      NOW,
    ),
    "stopped",
  );
});

test("unknown docker states are reported as unknown", () => {
  assertEquals(containerRunState(observe("removing"), NOW), "unknown");
});

test("only failing containers want a log line", () => {
  assertEquals(wantsLastLogLine(observe("restarting")), true);
  assertEquals(wantsLastLogLine(observe("exited", { exitCode: 1 })), true);
  assertEquals(wantsLastLogLine(observe("exited", { exitCode: 0 })), false);
  assertEquals(
    wantsLastLogLine(observe("running", { startedSecondsAgo: 100 })),
    false,
  );
});

test("a service reports its worst container and the highest restart count", () => {
  const states = deriveServiceRunStates([
    observe("running", { startedSecondsAgo: 600, restartCount: 1 }),
    observe("restarting", {
      restartCount: 4,
      lastLogLine: "/bin/sh: 1: next: not found",
    }),
  ], NOW);
  assertEquals(states, [{
    serviceId: "svc-1",
    state: "crashing",
    restartCount: 4,
    lastError: "/bin/sh: 1: next: not found",
  }]);
});

test("last error falls back to the exit code and is dropped while healthy", () => {
  assertEquals(
    deriveServiceRunStates([observe("exited", { exitCode: 127 })], NOW)[0]
      ?.lastError,
    "Exited with code 127",
  );
  assertEquals(
    "lastError" in deriveServiceRunStates([
      observe("running", { startedSecondsAgo: 600, lastLogLine: "old error" }),
    ], NOW)[0]!,
    false,
  );
});

test("last error is capped at 400 characters", () => {
  const states = deriveServiceRunStates([
    observe("restarting", { lastLogLine: "x".repeat(900) }),
  ], NOW);
  assertEquals(states[0]?.lastError?.length, 400);
});

test("services are sorted by id", () => {
  const states = deriveServiceRunStates([
    observe("exited", { serviceId: "b", exitCode: 1 }),
    observe("exited", { serviceId: "a", exitCode: 1 }),
  ], NOW);
  assertEquals(states.map((s) => s.serviceId), ["a", "b"]);
});

test("ingress and platform containers do not count as services", () => {
  assertEquals(serviceIdForContainer({ "com.turbopanel.service": "s" }), "s");
  assertEquals(
    serviceIdForContainer({
      "com.turbopanel.service": "s",
      "turbopanel.role": "ingress",
    }),
    undefined,
  );
  assertEquals(
    serviceIdForContainer({
      "com.turbopanel.service": "s",
      "turbopanel.role": "turbopanel",
    }),
    undefined,
  );
  assertEquals(serviceIdForContainer({}), undefined);
  assertEquals(serviceIdForContainer(undefined), undefined);
});

test("asOf holds while a service state is unchanged and moves when it changes", () => {
  const stamper = new ServiceRunStateStamper();
  const running = [{
    serviceId: "s",
    state: "running" as const,
    restartCount: 0,
  }];
  const t0 = new Date("2026-10-04T12:00:00.000Z");
  const t1 = new Date("2026-10-04T12:01:00.000Z");
  const t2 = new Date("2026-10-04T12:02:00.000Z");
  assertEquals(stamper.stamp(running, t0)[0]?.asOf, t0.toISOString());
  assertEquals(stamper.stamp(running, t1)[0]?.asOf, t0.toISOString());
  const crashed = [{
    ...running[0]!,
    state: "crashing" as const,
    restartCount: 1,
  }];
  assertEquals(stamper.stamp(crashed, t2)[0]?.asOf, t2.toISOString());
});

test("fetchContainerLastLogLine returns the last non-empty line from either stream", async () => {
  const calls: string[][] = [];
  const line = await fetchContainerLastLogLine("c1", (args) => {
    calls.push(args);
    return Promise.resolve({
      success: false,
      code: 0,
      stdout: "starting\n",
      stderr: "/bin/sh: 1: next: not found\n\n",
    });
  });
  assertEquals(calls, [["logs", "--tail", "5", "c1"]]);
  assertEquals(line, "/bin/sh: 1: next: not found");
});
