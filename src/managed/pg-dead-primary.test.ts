import { assert, assertEquals } from "@std/assert";
import {
  classifyProbeSample,
  type ContainerSnapshot,
  DeadPrimaryDetector,
  DEFAULT_PG_DEAD_PRIMARY_CONFIG,
  parseControlDataState,
  parseInspectState,
  type ProbeSample,
  readContainerState,
  readPgReady,
  sampleManagedPostgres,
} from "./pg-dead-primary.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const CONFIG = DEFAULT_PG_DEAD_PRIMARY_CONFIG;
const T0 = Date.parse("2026-10-01T00:00:00Z");
const OLD_START = "2026-09-01T00:00:00Z";

function running(startedAt = OLD_START): ContainerSnapshot {
  return { status: "running", exitCode: 0, restartCount: 0, startedAt };
}

const HEALTHY: ProbeSample = {
  container: { kind: "present", state: running() },
  pgReady: { kind: "exit", code: 0, output: "" },
};
const EXITED: ProbeSample = {
  container: {
    kind: "present",
    state: { status: "exited", exitCode: 137, restartCount: 0 },
  },
};
const REJECTING: ProbeSample = {
  container: { kind: "present", state: running() },
  pgReady: { kind: "exit", code: 1, output: "" },
};
const UNREADABLE: ProbeSample = {
  container: { kind: "unreadable", reason: "docker inspect timeout" },
};

/** Feed `sample` every interval; return the tick index that fired, or -1. */
function runUntilFire(
  detector: DeadPrimaryDetector,
  samples: (i: number) => ProbeSample,
  ticks: number,
  options: { start?: number; intentActive?: (i: number) => boolean } = {},
): number {
  const start = options.start ?? T0;
  for (let i = 0; i < ticks; i++) {
    const verdict = detector.step(samples(i), {
      nowMs: start + i * CONFIG.intervalMs,
      intentActive: options.intentActive?.(i) ?? false,
    });
    if (verdict.fire) return i;
  }
  return -1;
}

test("healthy primary never fires", () => {
  const detector = new DeadPrimaryDetector();
  assertEquals(runUntilFire(detector, () => HEALTHY, 1_000), -1);
});

test("too-many-connections reads as alive (pg_isready OK on 53300)", () => {
  // PQping reports OK for every server-side error except 57P03, so a
  // saturated primary is exit 0 and must never count as dead.
  assertEquals(classifyProbeSample(HEALTHY, T0).kind, "healthy");
});

test("dead container with no marker fires after N failures spanning >= 20 s", () => {
  const detector = new DeadPrimaryDetector();
  const fired = runUntilFire(detector, () => EXITED, 100);
  // Six failures at 5 s spacing span 25 s: tick index 5.
  assertEquals(fired, CONFIG.failureThreshold - 1);
});

test("N failures inside less than the minimum span do not fire", () => {
  const detector = new DeadPrimaryDetector({
    ...CONFIG,
    intervalMs: 1_000,
  });
  const fired = (() => {
    for (let i = 0; i < 30; i++) {
      const verdict = detector.step(EXITED, {
        nowMs: T0 + i * 1_000,
        intentActive: false,
      });
      if (verdict.fire) return i;
    }
    return -1;
  })();
  assertEquals(fired, 20);
});

test("transient failures below N do not fire", () => {
  const detector = new DeadPrimaryDetector();
  const pattern = (i: number) => (i % 5 === 4 ? HEALTHY : EXITED);
  assertEquals(runUntilFire(detector, pattern, 500), -1);
});

test("container stopped WITH an active marker does not fire", () => {
  const detector = new DeadPrimaryDetector();
  assertEquals(
    runUntilFire(detector, () => EXITED, 500, { intentActive: () => true }),
    -1,
  );
});

test("marker expiry then still dead fires after a fresh N-failure run", () => {
  const detector = new DeadPrimaryDetector();
  const fired = runUntilFire(detector, () => EXITED, 500, {
    intentActive: (i) => i < 100,
  });
  assertEquals(fired, 100 + CONFIG.failureThreshold - 1);
});

test("unreadable docker state never fires and resets the streak", () => {
  const detector = new DeadPrimaryDetector();
  assertEquals(runUntilFire(detector, () => UNREADABLE, 500), -1);
  const mixed = (i: number) => (i % 4 === 3 ? UNREADABLE : EXITED);
  assertEquals(runUntilFire(new DeadPrimaryDetector(), mixed, 500), -1);
});

test("57P03 rejecting is soft for the grace, then counts", () => {
  const detector = new DeadPrimaryDetector();
  const graceTicks = CONFIG.rejectingGraceMs / CONFIG.intervalMs;
  const fired = runUntilFire(detector, () => REJECTING, 2_000);
  assertEquals(fired, graceTicks + CONFIG.failureThreshold - 1);
});

test("crash recovery (pg_controldata) extends the grace", () => {
  const detector = new DeadPrimaryDetector();
  const sample: ProbeSample = {
    ...REJECTING,
    controlData: "in crash recovery",
  };
  const graceTicks = CONFIG.crashRecoveryGraceMs / CONFIG.intervalMs;
  // 25 minutes: well past the plain rejecting grace, inside crash recovery's.
  const firstRun = 300;
  assertEquals(runUntilFire(detector, () => sample, firstRun), -1);
  const fired = runUntilFire(detector, () => sample, 1_000, {
    start: T0 + firstRun * CONFIG.intervalMs,
  });
  assertEquals(
    firstRun + fired,
    graceTicks + CONFIG.failureThreshold - 1,
  );
});

test("a node in archive recovery is not a primary: never fires", () => {
  const detector = new DeadPrimaryDetector();
  const sample: ProbeSample = {
    ...REJECTING,
    controlData: "in archive recovery",
  };
  assertEquals(runUntilFire(detector, () => sample, 10_000), -1);
});

test("no response right after a container (re)start is soft", () => {
  const startedAt = new Date(T0).toISOString();
  const sample: ProbeSample = {
    container: { kind: "present", state: running(startedAt) },
    pgReady: { kind: "exit", code: 2, output: "" },
  };
  assertEquals(classifyProbeSample(sample, T0 + 10_000).kind, "soft");
  assertEquals(
    classifyProbeSample(sample, T0 + CONFIG.startGraceMs).kind,
    "hard",
  );
});

test("pg_isready exit 3 and exec plumbing codes are inconclusive", () => {
  for (const code of [3, 125, 126, 127]) {
    const sample: ProbeSample = {
      container: { kind: "present", state: running() },
      pgReady: { kind: "exit", code, output: "" },
    };
    assertEquals(classifyProbeSample(sample, T0).kind, "inconclusive");
  }
});

test("a crash loop (dead / starting / dead) still accumulates", () => {
  const detector = new DeadPrimaryDetector();
  const starting: ProbeSample = {
    container: {
      kind: "present",
      state: running(new Date(T0).toISOString()),
    },
    pgReady: { kind: "exit", code: 2, output: "" },
  };
  const loop = (i: number) => (i % 2 === 0 ? EXITED : starting);
  assert(runUntilFire(detector, loop, 200) > 0);
});

test("one event per incident, back-off before the next, reset on healthy", () => {
  const detector = new DeadPrimaryDetector();
  const first = runUntilFire(detector, () => EXITED, 100);
  assert(first >= 0);
  const firstAt = T0 + first * CONFIG.intervalMs;
  detector.markEmitted(firstAt);
  // Same incident: never again.
  assertEquals(
    runUntilFire(detector, () => EXITED, 500, { start: firstAt + 5_000 }),
    -1,
  );
  // Healthy closes the incident; a new one inside the back-off waits.
  const healthyAt = firstAt + 60_000;
  detector.step(HEALTHY, { nowMs: healthyAt, intentActive: false });
  const second = runUntilFire(detector, () => EXITED, 500, {
    start: healthyAt + 5_000,
  });
  const secondAt = healthyAt + 5_000 + second * CONFIG.intervalMs;
  assert(second > 0);
  assert(secondAt - firstAt >= CONFIG.backoffMs);
});

test("evidence carries failures, span, last error and container state", () => {
  const detector = new DeadPrimaryDetector();
  let verdict = detector.step(EXITED, { nowMs: T0, intentActive: false });
  for (let i = 1; !verdict.fire && i < 50; i++) {
    verdict = detector.step(EXITED, {
      nowMs: T0 + i * CONFIG.intervalMs,
      intentActive: false,
    });
  }
  assert(verdict.fire);
  assertEquals(verdict.evidence.failures, CONFIG.failureThreshold);
  assertEquals(
    verdict.evidence.spanMs,
    (CONFIG.failureThreshold - 1) * CONFIG.intervalMs,
  );
  assertEquals(verdict.evidence.lastError, "container exited exit=137");
  assertEquals(verdict.evidence.container?.status, "exited");
  assertEquals(verdict.evidence.scope, "engine-dead-host-alive");
});

test("parseInspectState reads status, exit code, start, health and restarts", () => {
  const state = parseInspectState(
    `${
      JSON.stringify({
        Status: "running",
        ExitCode: 0,
        StartedAt: OLD_START,
        Health: { Status: "healthy" },
        OOMKilled: false,
      })
    } 3`,
  );
  assertEquals(state, {
    status: "running",
    exitCode: 0,
    restartCount: 3,
    startedAt: OLD_START,
    health: "healthy",
  });
  assertEquals(parseInspectState("garbage"), null);
});

test("parseControlDataState maps pg_controldata output", () => {
  assertEquals(
    parseControlDataState(
      "pg_control version number: 1700\nDatabase cluster state:               in crash recovery\n",
    ),
    "in crash recovery",
  );
  assertEquals(parseControlDataState("nothing"), "unknown");
});

test("readContainerState: missing is absent, socket error is unreadable", async () => {
  const absent = await readContainerState(
    "c-1",
    () =>
      Promise.resolve({
        success: false,
        code: 1,
        stdout: "",
        stderr: "Error: No such object: c-1",
      }),
    1_000,
  );
  assertEquals(absent.kind, "absent");
  const socket = await readContainerState(
    "c-1",
    () =>
      Promise.resolve({
        success: false,
        code: 1,
        stdout: "",
        stderr:
          "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
      }),
    1_000,
  );
  assertEquals(socket.kind, "unreadable");
});

test("readContainerState: a hung docker socket times out as unreadable", async () => {
  let release: () => void = () => {};
  const hung = new Promise<never>((_, reject) => {
    release = () => reject(new Error("released"));
  });
  const read = await readContainerState("c-1", () => hung, 20);
  assertEquals(read.kind, "unreadable");
  release();
  await hung.catch(() => undefined);
});

test("readPgReady: docker stderr is never an engine verdict", async () => {
  const read = await readPgReady(
    "c-1",
    () =>
      Promise.resolve({
        success: false,
        code: 1,
        stdout: "",
        stderr: "Error response from daemon: container is not running",
      }),
    CONFIG,
  );
  assertEquals(read.kind, "unreadable");
  const ok = await readPgReady(
    "c-1",
    () => Promise.resolve({ success: false, code: 2, stdout: "", stderr: "" }),
    CONFIG,
  );
  assertEquals(ok, { kind: "exit", code: 2, output: "" });
});

/** The program a recorded Docker call runs: `inspect`, or the exec'd binary. */
function probeBinary(args: string[]): string | undefined {
  if (args[0] === "inspect") return "inspect";
  if (args[1] === "-e") return args[4];
  return args[2];
}

test("sampleManagedPostgres runs read-only probes only", async () => {
  const calls: string[][] = [];
  const sample = await sampleManagedPostgres("c-1", (args) => {
    calls.push(args);
    if (args[0] === "inspect") {
      return Promise.resolve({
        success: true,
        code: 0,
        stdout: `${JSON.stringify({ Status: "running", ExitCode: 0 })} 0`,
        stderr: "",
      });
    }
    if (args.includes("pg_isready")) {
      return Promise.resolve({
        success: false,
        code: 1,
        stdout: "",
        stderr: "",
      });
    }
    return Promise.resolve({
      success: true,
      code: 0,
      stdout: "Database cluster state:               in production\n",
      stderr: "",
    });
  });
  assertEquals(sample.controlData, "in production");
  const binaries = calls.map(probeBinary);
  assertEquals(binaries, ["inspect", "pg_isready", "pg_controldata"]);
  for (const args of calls) {
    assert(!args.some((arg) => /password|psql/i.test(arg)));
  }
});
