import { assertEquals, assertRejects } from "@std/assert";
import {
  type ControlPlaneHealthSnapshot,
  INSTANCE_UPDATE_HEALTH_TIMEOUT_MS,
  InstanceHealthError,
  resolveUpdateHealthTimeoutMs,
  waitForInstanceHealth,
} from "./instance-health-check.ts";

/** Sonar typescript:S2187 only recognizes `test()`, not `Deno.test()`. */
const test = Deno.test.bind(Deno);

const target = { commit: "abc" };

test("waitForInstanceHealth polls until the target build answers", async () => {
  let clock = 0;
  const answers: Array<ControlPlaneHealthSnapshot | null> = [
    null,
    { version: "1", commit: "old" },
    { version: "2", commit: "abc" },
  ];
  const sleeps: number[] = [];
  await waitForInstanceHealth({
    target,
    timeoutMs: 10_000,
    intervalMs: 1_000,
    unitActive: () => Promise.resolve(true),
    readHealth: () => Promise.resolve(answers.shift() ?? null),
    now: () => clock,
    sleep: (ms) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
  });
  assertEquals(sleeps, [1_000, 1_000]);
  assertEquals(answers.length, 0);
});

test("waitForInstanceHealth reports a mismatch when a different commit answered until the deadline", async () => {
  let clock = 0;
  const error = await assertRejects(
    () =>
      waitForInstanceHealth({
        target,
        timeoutMs: 2_500,
        intervalMs: 1_000,
        unitActive: () => Promise.resolve(true),
        readHealth: () => Promise.resolve({ version: "1", commit: "old" }),
        now: () => clock,
        sleep: (ms) => {
          clock += ms;
          return Promise.resolve();
        },
      }),
    InstanceHealthError,
  );
  assertEquals(error.code, "health_mismatch");
});

test("waitForInstanceHealth times out when nothing answers, clamping the last sleep", async () => {
  let clock = 0;
  const sleeps: number[] = [];
  const error = await assertRejects(
    () =>
      waitForInstanceHealth({
        target,
        timeoutMs: 2_500,
        intervalMs: 1_000,
        unitActive: () => Promise.resolve(false),
        now: () => clock,
        sleep: (ms) => {
          sleeps.push(ms);
          clock += ms;
          return Promise.resolve();
        },
      }),
    InstanceHealthError,
  );
  assertEquals(error.code, "health_timeout");
  assertEquals(sleeps, [1_000, 1_000, 500]);
});

test("resolveUpdateHealthTimeoutMs reads the env budget and rejects junk", () => {
  const name = "TURBOPANEL_UPDATE_HEALTH_TIMEOUT_SECONDS";
  assertEquals(
    resolveUpdateHealthTimeoutMs({}),
    INSTANCE_UPDATE_HEALTH_TIMEOUT_MS,
  );
  assertEquals(resolveUpdateHealthTimeoutMs({ [name]: "900" }), 900_000);
  assertEquals(resolveUpdateHealthTimeoutMs({ [name]: " 45 " }), 45_000);
  for (const bad of ["", "abc", "-5", "1.5", "5", "99999"]) {
    assertEquals(
      resolveUpdateHealthTimeoutMs({ [name]: bad }),
      INSTANCE_UPDATE_HEALTH_TIMEOUT_MS,
    );
  }
  assertEquals(INSTANCE_UPDATE_HEALTH_TIMEOUT_MS >= 600_000, true);
});

test("waitForInstanceHealth backs off up to the cap and succeeds as soon as the build answers", async () => {
  let clock = 0;
  const sleeps: number[] = [];
  await waitForInstanceHealth({
    target,
    timeoutMs: 600_000,
    intervalMs: 1_000,
    maxIntervalMs: 8_000,
    unitActive: () => Promise.resolve(true),
    readHealth: () =>
      Promise.resolve(
        sleeps.length >= 6 ? { version: "2", commit: "abc" } : null,
      ),
    now: () => clock,
    sleep: (ms) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
  });
  assertEquals(sleeps, [1_000, 2_000, 4_000, 8_000, 8_000, 8_000]);
});
