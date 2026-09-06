import { assertEquals } from "@std/assert";
import { CounterBaselineTracker } from "../baseline.ts";
import { parsePrometheusExposition } from "../proxy/prom-exposition.ts";
import {
  parseProxySqlExpositionV4,
  ProxySqlDatabaseProxyAdapter,
} from "./proxysql-v4.ts";
import type { DatabaseProxyReadContext } from "./adapter.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function fixture(name: string): string {
  return Deno.readTextFileSync(
    new URL(`../testdata/${name}`, import.meta.url),
  );
}

function ctx(
  overrides: Partial<DatabaseProxyReadContext> = {},
): DatabaseProxyReadContext {
  return {
    tracker: new CounterBaselineTracker(),
    bootGeneration: 1,
    seconds: 60,
    ...overrides,
  };
}

test("parseProxySqlExpositionV4 computes rates from a primed baseline and passes gauges through unchanged", () => {
  const tracker = new CounterBaselineTracker();
  const partial = parsePrometheusExposition(
    fixture("proxy-proxysql-metrics-partial.txt"),
  );
  parseProxySqlExpositionV4(partial, ctx({ tracker })); // prime baseline

  const samples = parsePrometheusExposition(
    fixture("proxy-proxysql-metrics.txt"),
  );
  const reading = parseProxySqlExpositionV4(samples, ctx({ tracker }));

  assertEquals(reading.queries, 48213);
  assertEquals(reading.slowQueries, 12);
  assertEquals(reading.connectionErrors, 3 + 2);
  assertEquals(reading.clientConnections, 7);
  assertEquals(reading.backendConnections, 4);
  assertEquals(reading.backendsUp, 2);
});

test("parseProxySqlExpositionV4: a freshly-started ProxySQL nulls every rate field on the first observation, gauges resolve to real numbers", () => {
  const samples = parsePrometheusExposition(
    fixture("proxy-proxysql-metrics-partial.txt"),
  );
  const reading = parseProxySqlExpositionV4(samples, ctx());
  assertEquals(reading.queries, null);
  assertEquals(reading.slowQueries, null);
  assertEquals(reading.connectionErrors, null);
  assertEquals(typeof reading.clientConnections, "number");
  assertEquals(typeof reading.backendConnections, "number");
  assertEquals(typeof reading.backendsUp, "number");
});

const RESETTABLE_EXPOSITION = (queriesTotal: number) => `
# HELP proxysql_questions_total queries
# TYPE proxysql_questions_total counter
proxysql_questions_total ${queriesTotal}
`;

test("parseProxySqlExpositionV4: a counter decrease (sidecar restart) nulls that field and re-baselines", () => {
  const tracker = new CounterBaselineTracker();
  const first = parseProxySqlExpositionV4(
    parsePrometheusExposition(RESETTABLE_EXPOSITION(1000)),
    ctx({ tracker, bootGeneration: 1 }),
  );
  assertEquals(first.queries, null);

  const second = parseProxySqlExpositionV4(
    parsePrometheusExposition(RESETTABLE_EXPOSITION(1600)),
    ctx({ tracker, bootGeneration: 1 }),
  );
  assertEquals(second.queries, 600);

  const third = parseProxySqlExpositionV4(
    parsePrometheusExposition(RESETTABLE_EXPOSITION(50)),
    ctx({ tracker, bootGeneration: 1 }),
  );
  assertEquals(third.queries, null);
});

test("parseProxySqlExpositionV4: a boot generation change nulls the counter and re-baselines", () => {
  const tracker = new CounterBaselineTracker();
  parseProxySqlExpositionV4(
    parsePrometheusExposition(RESETTABLE_EXPOSITION(1000)),
    ctx({ tracker, bootGeneration: 1 }),
  );
  parseProxySqlExpositionV4(
    parsePrometheusExposition(RESETTABLE_EXPOSITION(1600)),
    ctx({ tracker, bootGeneration: 1 }),
  );
  const afterRestart = parseProxySqlExpositionV4(
    parsePrometheusExposition(RESETTABLE_EXPOSITION(50)),
    ctx({ tracker, bootGeneration: 2 }),
  );
  assertEquals(afterRestart.queries, null);
});

test("ProxySqlDatabaseProxyAdapter.read returns null when the endpoint is unreachable", async () => {
  const adapter = new ProxySqlDatabaseProxyAdapter({
    fetchText: () => Promise.resolve(undefined),
  });
  const result = await adapter.read(ctx());
  assertEquals(result, null);
});

test("ProxySqlDatabaseProxyAdapter.read returns null when the body has none of the expected metric names", () => {
  const adapter = new ProxySqlDatabaseProxyAdapter({
    fetchText: () => Promise.resolve("some_unrelated_metric 1\n"),
  });
  return adapter.read(ctx()).then((result) => assertEquals(result, null));
});

test("ProxySqlDatabaseProxyAdapter.read succeeds on a valid scrape", async () => {
  const adapter = new ProxySqlDatabaseProxyAdapter({
    fetchText: () => Promise.resolve(fixture("proxy-proxysql-metrics.txt")),
  });
  const result = await adapter.read(ctx());
  assertEquals(result?.sourceId, "proxysql");
  assertEquals(result?.sourceKind, "proxysql");
  assertEquals(result?.reading.clientConnections, 7);
});
