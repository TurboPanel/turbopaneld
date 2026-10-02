import { assertEquals, assertRejects } from "@std/assert";
import {
  type ControlPlaneHealthSnapshot,
  INSTANCE_UPDATE_HEALTH_TIMEOUT_MS,
  InstanceHealthError,
  parseInstanceHealth,
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

/** `GET /api/health` from canary.turbopanel.dev during canary update #2 (2026-10-01). */
const CANARY_HEALTH_BODY = {
  ok: true,
  license: "AGPL-3.0-only",
  version: "0.1.7",
  revision: {
    commit: "077abdc24a91bbca883251da274991284f5d8064",
    sourceUrl:
      "https://github.com/TurboPanel/turbopanel/tree/077abdc24a91bbca883251da274991284f5d8064",
  },
  channel: "canary",
  build: "0.1.7-canary.56",
  environment: null,
};

/** The manifest the update installed: version carries the channel label. */
const CANARY_TARGET = {
  commit: "077abdc24a91bbca883251da274991284f5d8064",
  version: "0.1.7-canary.56",
};

function settledClock() {
  let clock = 0;
  return {
    now: () => clock,
    sleep: (ms: number) => {
      clock += ms;
      return Promise.resolve();
    },
  };
}

test("parseInstanceHealth reads version, commit and the release label", () => {
  assertEquals(parseInstanceHealth(CANARY_HEALTH_BODY), {
    version: "0.1.7",
    commit: "077abdc24a91bbca883251da274991284f5d8064",
    build: "0.1.7-canary.56",
  });
  assertEquals(
    parseInstanceHealth({ version: "0.1.7", revision: { commit: "unknown" } }),
    null,
  );
  assertEquals(parseInstanceHealth([]), null);
});

test("waitForInstanceHealth accepts a canary build: the binary reports its base version, the manifest the label", async () => {
  const health = parseInstanceHealth(CANARY_HEALTH_BODY);
  await waitForInstanceHealth({
    target: CANARY_TARGET,
    timeoutMs: 600_000,
    unitActive: () => Promise.resolve(true),
    readHealth: () => Promise.resolve(health),
    ...settledClock(),
  });
});

test("waitForInstanceHealth accepts the base version when the instance reports no label", async () => {
  await waitForInstanceHealth({
    target: CANARY_TARGET,
    timeoutMs: 600_000,
    unitActive: () => Promise.resolve(true),
    readHealth: () =>
      Promise.resolve({ version: "0.1.7", commit: CANARY_TARGET.commit }),
    ...settledClock(),
  });
});

test("waitForInstanceHealth still refuses the target commit under another base version", async () => {
  const error = await assertRejects(
    () =>
      waitForInstanceHealth({
        target: CANARY_TARGET,
        timeoutMs: 3_000,
        intervalMs: 1_000,
        unitActive: () => Promise.resolve(true),
        readHealth: () =>
          Promise.resolve({ version: "0.1.6", commit: CANARY_TARGET.commit }),
        ...settledClock(),
      }),
    InstanceHealthError,
  );
  assertEquals(error.code, "health_timeout");
});
