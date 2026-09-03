import { assertEquals } from "@std/assert";
import { parseProxySqlExposition, readProxySqlMetrics } from "./proxysql.ts";

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

Deno.test("parseProxySqlExposition sums per-backend counters and counts ONLINE backends", () => {
  const counters = parseProxySqlExposition(
    fixture("proxy-proxysql-metrics.txt"),
  );
  assertEquals(counters, {
    queriesTotal: 48_213,
    slowQueriesTotal: 12,
    connectionErrorsTotal: 5,
    clientConnections: 7,
    backendConnections: 4,
    backendsUp: 2,
  });
});

Deno.test("parseProxySqlExposition with no dynamic backends configured resolves every field to 0", () => {
  const counters = parseProxySqlExposition(
    fixture("proxy-proxysql-metrics-partial.txt"),
  );
  assertEquals(counters, {
    queriesTotal: 0,
    slowQueriesTotal: 0,
    connectionErrorsTotal: 0,
    clientConnections: 0,
    backendConnections: 0,
    backendsUp: 0,
  });
});

// `parseProxySqlExposition` itself stays a pure reduction with no notion of
// failure — summing zero matching samples is correctly zero. Whether an
// empty/unexpected body counts as a *failed scrape* is `readProxySqlMetrics`'s
// call (below), not the parser's.
Deno.test("parseProxySqlExposition on empty text resolves every field to 0", () => {
  assertEquals(parseProxySqlExposition(""), {
    queriesTotal: 0,
    slowQueriesTotal: 0,
    connectionErrorsTotal: 0,
    clientConnections: 0,
    backendConnections: 0,
    backendsUp: 0,
  });
});

Deno.test("readProxySqlMetrics treats an empty 200 body as a failed scrape, not a healthy zero snapshot", async () => {
  const result = await withMockedFetch(
    () => new Response(""),
    () => readProxySqlMetrics("127.0.0.1:6070"),
  );
  assertEquals(result, null);
});

Deno.test("readProxySqlMetrics treats a 200 body with no ProxySQL metric names as a failed scrape (wrong loopback service)", async () => {
  const result = await withMockedFetch(
    () => new Response("some_other_process_metric_total 1\n"),
    () => readProxySqlMetrics("127.0.0.1:6070"),
  );
  assertEquals(result, null);
});

Deno.test("readProxySqlMetrics succeeds once at least one expected metric is present, even with every counter still at 0", async () => {
  const result = await withMockedFetch(
    () => new Response(fixture("proxy-proxysql-metrics-partial.txt")),
    () => readProxySqlMetrics("127.0.0.1:6070"),
  );
  assertEquals(result, {
    queriesTotal: 0,
    slowQueriesTotal: 0,
    connectionErrorsTotal: 0,
    clientConnections: 0,
    backendConnections: 0,
    backendsUp: 0,
  });
});

Deno.test("readProxySqlMetrics returns null when the endpoint is unreachable", async () => {
  const result = await withMockedFetch(
    () => {
      throw new TypeError("connection refused");
    },
    () => readProxySqlMetrics("127.0.0.1:6070"),
  );
  assertEquals(result, null);
});
