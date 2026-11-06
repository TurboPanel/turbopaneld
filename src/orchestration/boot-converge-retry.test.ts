import { assertEquals } from "@std/assert";
import { resetBootConvergeForTests } from "./boot-converge-gate.ts";
import {
  abortableSleep,
  BOOT_CONVERGE_RETRY_DELAYS_MS,
  resetRuntimeVerificationForTests,
  retryBootConverge,
  runtimeVerification,
} from "./boot-converge-retry.ts";

const test = Deno.test.bind(Deno);

function harness(results: boolean[], delays = [10, 20, 30]) {
  resetBootConvergeForTests();
  resetRuntimeVerificationForTests();
  const slept: number[] = [];
  const logs: string[] = [];
  let attempts = 0;
  let recovered = 0;
  const controller = new AbortController();
  const run = () =>
    retryBootConverge({
      attempt: () => Promise.resolve(results[attempts++] ?? false),
      onRecovered: () => {
        recovered += 1;
        return Promise.resolve();
      },
      signal: controller.signal,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
      log: (m) => logs.push(m),
      delaysMs: delays,
    });
  return {
    run,
    slept,
    logs,
    controller,
    get attempts() {
      return attempts;
    },
    get recovered() {
      return recovered;
    },
  };
}

test("retries until an attempt works, then runs the recovery steps once", async () => {
  const h = harness([false, true]);
  assertEquals(await h.run(), true);
  assertEquals(h.attempts, 2);
  assertEquals(h.slept, [10, 20]);
  assertEquals(h.recovered, 1);
  assertEquals(runtimeVerification(), "verified");
});

test("gives up after the last delay and reports the runtime as not verified", async () => {
  const h = harness([false, false, false]);
  assertEquals(await h.run(), false);
  assertEquals(h.attempts, 3);
  assertEquals(h.recovered, 0);
  assertEquals(runtimeVerification(), "not-verified");
});

test("an attempt that throws counts as failed and the next one still runs", async () => {
  resetBootConvergeForTests();
  resetRuntimeVerificationForTests();
  let n = 0;
  const ok = await retryBootConverge({
    attempt: () => {
      n += 1;
      return n === 1
        ? Promise.reject(new Error("boom"))
        : Promise.resolve(true);
    },
    onRecovered: () => Promise.resolve(),
    signal: new AbortController().signal,
    sleep: () => Promise.resolve(),
    log: () => {},
    delaysMs: [1, 1],
  });
  assertEquals(ok, true);
  assertEquals(n, 2);
});

test("a failing recovery step is only reported", async () => {
  resetBootConvergeForTests();
  resetRuntimeVerificationForTests();
  const logs: string[] = [];
  const ok = await retryBootConverge({
    attempt: () => Promise.resolve(true),
    onRecovered: () => Promise.reject(new Error("fabric down")),
    signal: new AbortController().signal,
    sleep: () => Promise.resolve(),
    log: (m) => logs.push(m),
    delaysMs: [1],
  });
  assertEquals(ok, true);
  assertEquals(logs.some((l) => l.includes("fabric down")), true);
});

test("an abort during the pause stops the retries without another attempt", async () => {
  const h = harness([true]);
  const run = retryBootConverge({
    attempt: () => Promise.resolve(true),
    onRecovered: () => Promise.resolve(),
    signal: h.controller.signal,
    sleep: () => {
      h.controller.abort();
      return Promise.resolve();
    },
    log: () => {},
    delaysMs: [1, 1],
  });
  assertEquals(await run, false);
  assertEquals(h.attempts, 0);
});

test("abortableSleep ends at once when aborted and never leaves a timer behind", async () => {
  const controller = new AbortController();
  const sleeping = abortableSleep(60_000, controller.signal);
  controller.abort();
  await sleeping;
  await abortableSleep(60_000, controller.signal);
});

test("the retry budget is bounded and grows", () => {
  const d = BOOT_CONVERGE_RETRY_DELAYS_MS;
  assertEquals(d.length <= 6, true);
  assertEquals(d.every((v, i) => i === 0 || v >= d[i - 1]!), true);
});

test("a retry that works after shutdown began does not run the recovery steps", async () => {
  resetBootConvergeForTests();
  resetRuntimeVerificationForTests();
  const controller = new AbortController();
  let recovered = 0;
  const ok = await retryBootConverge({
    attempt: () => {
      controller.abort();
      return Promise.resolve(true);
    },
    onRecovered: () => {
      recovered += 1;
      return Promise.resolve();
    },
    signal: controller.signal,
    sleep: () => Promise.resolve(),
    log: () => {},
    delaysMs: [1],
  });
  assertEquals(ok, false);
  assertEquals(recovered, 0);
});
