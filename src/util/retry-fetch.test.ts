import { assertEquals, assertRejects } from "@std/assert";
import {
  fetchWithRetry,
  isTransientNetworkError,
  parseRetryAfterMs,
} from "./retry-fetch.ts";

const test = Deno.test.bind(Deno);

function scripted(steps: Array<Response | Error>) {
  const calls = { n: 0 };
  const waits: number[] = [];
  const doFetch = () => {
    const step = steps[Math.min(calls.n, steps.length - 1)];
    calls.n += 1;
    return step instanceof Error ? Promise.reject(step) : Promise.resolve(step);
  };
  const sleep = (ms: number) => {
    waits.push(ms);
    return Promise.resolve();
  };
  return { calls, waits, doFetch, sleep };
}

const reply = (status: number, headers?: HeadersInit) =>
  new Response("x", { status, headers });

test("503 then 200 succeeds after one retry with the first backoff", async () => {
  const s = scripted([reply(503), reply(200)]);
  const res = await fetchWithRetry(s.doFetch, { sleep: s.sleep });
  assertEquals(res.status, 200);
  assertEquals(s.calls.n, 2);
  assertEquals(s.waits, [2000]);
  await res.body?.cancel();
});

test("three 504s stop at three attempts and return the last response", async () => {
  const s = scripted([reply(504)]);
  const res = await fetchWithRetry(s.doFetch, { sleep: s.sleep });
  assertEquals(res.status, 504);
  assertEquals(s.calls.n, 3);
  assertEquals(s.waits, [2000, 6000]);
  await res.body?.cancel();
});

test("404 and 500 are not retried", async () => {
  for (const status of [404, 500, 401]) {
    const s = scripted([reply(status), reply(200)]);
    const res = await fetchWithRetry(s.doFetch, { sleep: s.sleep });
    assertEquals(res.status, status);
    assertEquals(s.calls.n, 1);
    await res.body?.cancel();
  }
});

test("429 honours Retry-After, capped", async () => {
  const s = scripted([reply(429, { "retry-after": "4" }), reply(200)]);
  const res = await fetchWithRetry(s.doFetch, { sleep: s.sleep });
  assertEquals(res.status, 200);
  assertEquals(s.waits, [4000]);
  await res.body?.cancel();

  const big = scripted([reply(429, { "retry-after": "3600" }), reply(200)]);
  const res2 = await fetchWithRetry(big.doFetch, { sleep: big.sleep });
  assertEquals(big.waits, [10_000]);
  await res2.body?.cancel();
});

test("a connection reset is retried; a certificate failure is not", async () => {
  const reset = scripted([
    new TypeError("fetch failed", { cause: new Error("read ECONNRESET") }),
    reply(200),
  ]);
  const res = await fetchWithRetry(reset.doFetch, { sleep: reset.sleep });
  assertEquals(res.status, 200);
  assertEquals(reset.calls.n, 2);
  await res.body?.cancel();

  const tls = scripted([
    new TypeError("fetch failed", {
      cause: new Error("certificate verify failed"),
    }),
    reply(200),
  ]);
  await assertRejects(
    () => fetchWithRetry(tls.doFetch, { sleep: tls.sleep }),
    TypeError,
    "fetch failed",
  );
  assertEquals(tls.calls.n, 1);
});

test("persistent resets rethrow the original error after three attempts", async () => {
  const s = scripted([new TypeError("connection reset by peer")]);
  await assertRejects(
    () => fetchWithRetry(s.doFetch, { sleep: s.sleep }),
    TypeError,
    "connection reset by peer",
  );
  assertEquals(s.calls.n, 3);
});

test("parseRetryAfterMs reads seconds and dates and ignores junk", () => {
  assertEquals(parseRetryAfterMs("5"), 5000);
  assertEquals(parseRetryAfterMs(null), null);
  assertEquals(parseRetryAfterMs("soon"), null);
  const now = Date.parse("2026-10-01T00:00:00Z");
  assertEquals(parseRetryAfterMs("Thu, 01 Oct 2026 00:00:03 GMT", now), 3000);
  assertEquals(isTransientNetworkError("nope"), false);
});
