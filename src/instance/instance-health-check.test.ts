import { assertEquals, assertRejects } from "@std/assert";
import {
  type ControlPlaneHealthSnapshot,
  InstanceHealthError,
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
