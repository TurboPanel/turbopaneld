import { assertEquals } from "@std/assert";
import { createProxyCountersReader } from "./index.ts";
import { PROXY_ENDPOINT_RETRY_MS } from "./endpoint-cache.ts";
import type { CaddyCounters, ProxySqlCounters } from "../types.ts";

const CADDY_SAMPLE: CaddyCounters = {
  requestsTotal: 1,
  responses2xxTotal: 1,
  responses3xxTotal: 0,
  responses4xxTotal: 0,
  responses5xxTotal: 0,
  requestBytesTotal: 100,
  responseBytesTotal: 200,
  requestDurationSecondsSum: 0.1,
  requestsUnder100msTotal: 1,
  requestsUnder1sTotal: 1,
  requestsInFlight: 0,
};

const PROXYSQL_SAMPLE: ProxySqlCounters = {
  queriesTotal: 10,
  slowQueriesTotal: 0,
  connectionErrorsTotal: 0,
  clientConnections: 1,
  backendConnections: 1,
  backendsUp: 1,
};

Deno.test("createProxyCountersReader reports both sources present", async () => {
  const read = createProxyCountersReader({
    readCaddy: () => Promise.resolve(CADDY_SAMPLE),
    readProxySql: () => Promise.resolve(PROXYSQL_SAMPLE),
  });
  assertEquals(await read(), {
    caddy: CADDY_SAMPLE,
    proxysql: PROXYSQL_SAMPLE,
  });
});

Deno.test("createProxyCountersReader reports only Caddy present", async () => {
  const read = createProxyCountersReader({
    readCaddy: () => Promise.resolve(CADDY_SAMPLE),
    readProxySql: () => Promise.resolve(null),
  });
  assertEquals(await read(), { caddy: CADDY_SAMPLE, proxysql: null });
});

Deno.test("createProxyCountersReader reports only ProxySQL present", async () => {
  const read = createProxyCountersReader({
    readCaddy: () => Promise.resolve(null),
    readProxySql: () => Promise.resolve(PROXYSQL_SAMPLE),
  });
  assertEquals(await read(), { caddy: null, proxysql: PROXYSQL_SAMPLE });
});

Deno.test("createProxyCountersReader reports neither source present", async () => {
  const read = createProxyCountersReader({
    readCaddy: () => Promise.resolve(null),
    readProxySql: () => Promise.resolve(null),
  });
  assertEquals(await read(), { caddy: null, proxysql: null });
});

Deno.test("createProxyCountersReader never throws when a probe rejects", async () => {
  const read = createProxyCountersReader({
    readCaddy: () => Promise.reject(new Error("boom")),
    readProxySql: () => Promise.resolve(PROXYSQL_SAMPLE),
  });
  assertEquals(await read(), { caddy: null, proxysql: PROXYSQL_SAMPLE });
});

Deno.test("createProxyCountersReader bounds re-probing a failing source, independently per source", async () => {
  let clockMs = 0;
  let caddyCalls = 0;
  let proxysqlCalls = 0;
  const read = createProxyCountersReader({
    readCaddy: () => {
      caddyCalls += 1;
      return Promise.resolve(null);
    },
    readProxySql: () => {
      proxysqlCalls += 1;
      return Promise.resolve(PROXYSQL_SAMPLE);
    },
    now: () => clockMs,
  });

  await read();
  assertEquals(caddyCalls, 1);
  assertEquals(proxysqlCalls, 1);

  // Caddy stays down; well within the retry window it is not re-probed.
  clockMs += 1_000;
  await read();
  assertEquals(caddyCalls, 1);
  // ProxySQL succeeded, so it is re-probed on every call regardless of clock.
  assertEquals(proxysqlCalls, 2);

  // Past the retry window, Caddy is re-probed again.
  clockMs += PROXY_ENDPOINT_RETRY_MS;
  await read();
  assertEquals(caddyCalls, 2);
  assertEquals(proxysqlCalls, 3);
});

Deno.test("createProxyCountersReader logs a rate-limited warning when a source scrape returns no metrics", async () => {
  let clockMs = 0;
  const logged: string[] = [];
  const read = createProxyCountersReader({
    readCaddy: () => Promise.resolve(null),
    readProxySql: () => Promise.resolve(PROXYSQL_SAMPLE),
    now: () => clockMs,
    onLog: (message) => logged.push(message),
  });

  await read();
  assertEquals(logged, ["caddy traffic scrape returned no metrics"]);

  // Well within the retry/log window: no repeat log even though the source
  // is still failing.
  clockMs += 1_000;
  await read();
  assertEquals(logged.length, 1);

  // Past the retry window, the source is re-probed and logs again.
  clockMs += PROXY_ENDPOINT_RETRY_MS;
  await read();
  assertEquals(logged, [
    "caddy traffic scrape returned no metrics",
    "caddy traffic scrape returned no metrics",
  ]);
});

Deno.test("createProxyCountersReader logs a rate-limited warning when a source probe rejects", async () => {
  const logged: string[] = [];
  const read = createProxyCountersReader({
    readCaddy: () => Promise.reject(new Error("boom")),
    readProxySql: () => Promise.resolve(PROXYSQL_SAMPLE),
    onLog: (message) => logged.push(message),
  });

  await read();
  assertEquals(logged, ["caddy traffic scrape failed: boom"]);
});

Deno.test("createProxyCountersReader logs each source independently", async () => {
  const logged: string[] = [];
  const read = createProxyCountersReader({
    readCaddy: () => Promise.resolve(null),
    readProxySql: () => Promise.resolve(null),
    onLog: (message) => logged.push(message),
  });

  await read();
  assertEquals(logged.sort(), [
    "caddy traffic scrape returned no metrics",
    "proxysql traffic scrape returned no metrics",
  ]);
});

Deno.test("createProxyCountersReader does not log when both sources are healthy", async () => {
  const logged: string[] = [];
  const read = createProxyCountersReader({
    readCaddy: () => Promise.resolve(CADDY_SAMPLE),
    readProxySql: () => Promise.resolve(PROXYSQL_SAMPLE),
    onLog: (message) => logged.push(message),
  });

  await read();
  assertEquals(logged, []);
});
