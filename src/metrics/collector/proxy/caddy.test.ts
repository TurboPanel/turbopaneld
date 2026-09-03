import { assertEquals } from "@std/assert";
import { parseCaddyExposition, readCaddyMetrics } from "./caddy.ts";

function fixture(name: string): string {
  return Deno.readTextFileSync(
    new URL(`../testdata/${name}`, import.meta.url),
  );
}

/** Swap `globalThis.fetch` for the scope of `fn`, always restoring it after. */
async function withMockedFetch<T>(
  respond: (url: string) => Response,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    return Promise.resolve(respond(url));
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test("parseCaddyExposition sums counters and buckets across label combinations", () => {
  const counters = parseCaddyExposition(fixture("proxy-caddy-metrics.txt"));
  assertEquals(counters, {
    requestsTotal: 175,
    responses2xxTotal: 130,
    responses3xxTotal: 20,
    responses4xxTotal: 8,
    responses5xxTotal: 2,
    requestBytesTotal: 92_500,
    responseBytesTotal: 907_700,
    requestDurationSecondsSum: 16.2,
    requestsUnder100msTotal: 149,
    requestsUnder1sTotal: 160,
    requestsInFlight: 2,
  });
});

Deno.test("parseCaddyExposition on a freshly-started Caddy resolves every field to 0, not null or a throw", () => {
  const counters = parseCaddyExposition(
    fixture("proxy-caddy-metrics-partial.txt"),
  );
  assertEquals(counters, {
    requestsTotal: 0,
    responses2xxTotal: 0,
    responses3xxTotal: 0,
    responses4xxTotal: 0,
    responses5xxTotal: 0,
    requestBytesTotal: 0,
    responseBytesTotal: 0,
    requestDurationSecondsSum: 0,
    requestsUnder100msTotal: 0,
    requestsUnder1sTotal: 0,
    requestsInFlight: 0,
  });
});

// `parseCaddyExposition` itself stays a pure reduction with no notion of
// failure — summing zero matching samples is correctly zero. Whether an
// empty/unexpected body counts as a *failed scrape* is `readCaddyMetrics`'s
// call (below), not the parser's.
Deno.test("parseCaddyExposition on empty text resolves every field to 0", () => {
  assertEquals(parseCaddyExposition(""), {
    requestsTotal: 0,
    responses2xxTotal: 0,
    responses3xxTotal: 0,
    responses4xxTotal: 0,
    responses5xxTotal: 0,
    requestBytesTotal: 0,
    responseBytesTotal: 0,
    requestDurationSecondsSum: 0,
    requestsUnder100msTotal: 0,
    requestsUnder1sTotal: 0,
    requestsInFlight: 0,
  });
});

Deno.test("readCaddyMetrics treats an empty 200 body as a failed scrape, not a healthy zero snapshot", async () => {
  const result = await withMockedFetch(
    () => new Response(""),
    () => readCaddyMetrics("127.0.0.1:2039"),
  );
  assertEquals(result, null);
});

Deno.test("readCaddyMetrics treats a 200 body with no Caddy metric names as a failed scrape (wrong loopback service)", async () => {
  const result = await withMockedFetch(
    () => new Response("some_other_process_metric_total 1\n"),
    () => readCaddyMetrics("127.0.0.1:2039"),
  );
  assertEquals(result, null);
});

Deno.test("readCaddyMetrics succeeds once at least one expected metric is present, even with every counter still at 0", async () => {
  const result = await withMockedFetch(
    () => new Response(fixture("proxy-caddy-metrics-partial.txt")),
    () => readCaddyMetrics("127.0.0.1:2039"),
  );
  assertEquals(result, {
    requestsTotal: 0,
    responses2xxTotal: 0,
    responses3xxTotal: 0,
    responses4xxTotal: 0,
    responses5xxTotal: 0,
    requestBytesTotal: 0,
    responseBytesTotal: 0,
    requestDurationSecondsSum: 0,
    requestsUnder100msTotal: 0,
    requestsUnder1sTotal: 0,
    requestsInFlight: 0,
  });
});

Deno.test("readCaddyMetrics returns null when the endpoint is unreachable", async () => {
  const result = await withMockedFetch(
    () => {
      throw new TypeError("connection refused");
    },
    () => readCaddyMetrics("127.0.0.1:2039"),
  );
  assertEquals(result, null);
});
