import { assertEquals } from "@std/assert";
import { CounterBaselineTracker } from "../baseline.ts";
import { parsePrometheusExposition } from "../proxy/prom-exposition.ts";
import {
  parseProxySqlExposition,
  ProxySqlDatabaseProxyAdapter,
} from "./proxysql.ts";
import type { DatabaseProxyReadContext } from "./adapter.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/** Fractional-seconds counters make exact float equality brittle; compare at 4dp. */
function round4(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Math.round(value * 10_000) / 10_000;
}

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

test("parseProxySqlExposition computes rates from a primed baseline and passes gauges through unchanged", () => {
  const tracker = new CounterBaselineTracker();
  const partial = parsePrometheusExposition(
    fixture("proxy-proxysql-metrics-partial.txt"),
  );
  parseProxySqlExposition(partial, ctx({ tracker })); // prime baseline

  const samples = parsePrometheusExposition(
    fixture("proxy-proxysql-metrics.txt"),
  );
  const reading = parseProxySqlExposition(samples, ctx({ tracker }));

  assertEquals(reading.queries, 48213);
  assertEquals(reading.slowQueries, 12);
  assertEquals(reading.connectionErrors, 3 + 2);
  assertEquals(reading.clientConnections, 7);
  assertEquals(reading.backendConnections, 4);
  // Three `proxysql_connpool_conns_status` series, two of them ONLINE (1).
  assertEquals(reading.backendsUp, 2);
  assertEquals(reading.backendsTotal, 3);

  // The priming fixture has none of the churn/byte/latency families at all, so
  // each of these is its series' first observation — null, not a fabricated
  // delta over an unknown backlog.
  assertEquals(reading.clientConnectionsCreated, null);
  assertEquals(reading.clientConnectionsAborted, null);
  assertEquals(reading.backendConnectionsCreated, null);
  assertEquals(reading.backendConnectionsAborted, null);
  assertEquals(reading.connectionsRejectedMaxConns, null);
  assertEquals(reading.bytesFromBackends, null);
  assertEquals(reading.bytesToBackends, null);
  assertEquals(reading.queryLatencyMsAvg, null);
  assertEquals(reading.backendLatencyMsAvg, null);

  // A gauge, so it resolves on the very first scrape that carries it.
  assertEquals(reading.activeTransactions, 3);
});

test("parseProxySqlExposition resolves every widened field on a second scrape, summing across protocol/endpoint labels", () => {
  const tracker = new CounterBaselineTracker();
  const base = fixture("proxy-proxysql-metrics.txt");
  // First scrape establishes every baseline.
  parseProxySqlExposition(parsePrometheusExposition(base), ctx({ tracker }));

  const incremented = base
    .replace("proxysql_questions_total 48213", "proxysql_questions_total 48313")
    .replace(
      'proxysql_client_connections_total{protocol="mysql",status="created"} 1200',
      'proxysql_client_connections_total{protocol="mysql",status="created"} 1230',
    )
    .replace(
      'proxysql_client_connections_total{protocol="mysql",status="aborted"} 17',
      'proxysql_client_connections_total{protocol="mysql",status="aborted"} 19',
    )
    .replace(
      'proxysql_server_connections_total{protocol="mysql",status="created"} 640',
      'proxysql_server_connections_total{protocol="mysql",status="created"} 645',
    )
    .replace(
      'proxysql_server_connections_total{protocol="mysql",status="aborted"} 6',
      'proxysql_server_connections_total{protocol="mysql",status="aborted"} 7',
    )
    .replace(
      'proxysql_access_denied_max_connections_total{protocol="mysql"} 4',
      'proxysql_access_denied_max_connections_total{protocol="mysql"} 6',
    )
    .replace(
      'proxysql_connpool_data_bytes_total{endpoint="10.0.0.5:5432",hostgroup="0",protocol="mysql",traffic_flow="recv"} 8000000',
      'proxysql_connpool_data_bytes_total{endpoint="10.0.0.5:5432",hostgroup="0",protocol="mysql",traffic_flow="recv"} 8500000',
    )
    .replace(
      'proxysql_connpool_data_bytes_total{endpoint="10.0.0.5:5432",hostgroup="0",protocol="mysql",traffic_flow="sent"} 300000',
      'proxysql_connpool_data_bytes_total{endpoint="10.0.0.5:5432",hostgroup="0",protocol="mysql",traffic_flow="sent"} 320000',
    )
    .replace(
      'proxysql_backend_query_time_seconds_total{protocol="mysql"} 96.426',
      'proxysql_backend_query_time_seconds_total{protocol="mysql"} 96.626',
    )
    .replace(
      'proxysql_query_processor_time_seconds_total{protocol="mysql"} 48.213',
      'proxysql_query_processor_time_seconds_total{protocol="mysql"} 48.313',
    );

  const reading = parseProxySqlExposition(
    parsePrometheusExposition(incremented),
    ctx({ tracker }),
  );

  assertEquals(reading.queries, 100);
  // `status` partitions one counter family — the created delta must not
  // absorb the aborted or delayed rows.
  assertEquals(reading.clientConnectionsCreated, 30);
  assertEquals(reading.clientConnectionsAborted, 2);
  assertEquals(reading.backendConnectionsCreated, 5);
  assertEquals(reading.backendConnectionsAborted, 1);
  assertEquals(reading.connectionsRejectedMaxConns, 2);
  // Summed across both endpoints; only one moved.
  assertEquals(reading.bytesFromBackends, 500000);
  assertEquals(reading.bytesToBackends, 20000);
  // 0.2s of backend time over 100 queries = 2ms per query. Rounded because
  // the counters are fractional seconds and the delta carries float noise.
  assertEquals(round4(reading.backendLatencyMsAvg), 2);
  // Backend time plus ProxySQL's own query-processor time: 0.3s / 100.
  assertEquals(round4(reading.queryLatencyMsAvg), 3);
});

test("parseProxySqlExposition: a freshly-started ProxySQL nulls every rate field on the first observation, gauges resolve to real numbers", () => {
  const samples = parsePrometheusExposition(
    fixture("proxy-proxysql-metrics-partial.txt"),
  );
  const reading = parseProxySqlExposition(samples, ctx());
  assertEquals(reading.queries, null);
  assertEquals(reading.slowQueries, null);
  assertEquals(reading.connectionErrors, null);
  assertEquals(typeof reading.clientConnections, "number");
  assertEquals(typeof reading.backendConnections, "number");
  assertEquals(typeof reading.backendsUp, "number");

  // None of the widened families are present in this fixture. Every one must
  // degrade to null — "ProxySQL does not report this" is not a zero.
  assertEquals(reading.activeTransactions, null);
  assertEquals(reading.clientConnectionsCreated, null);
  assertEquals(reading.clientConnectionsAborted, null);
  assertEquals(reading.connectionsRejectedMaxConns, null);
  assertEquals(reading.backendConnectionsCreated, null);
  assertEquals(reading.backendConnectionsAborted, null);
  assertEquals(reading.bytesFromBackends, null);
  assertEquals(reading.bytesToBackends, null);
  assertEquals(reading.queryLatencyMsAvg, null);
  assertEquals(reading.backendLatencyMsAvg, null);
});

const RESETTABLE_EXPOSITION = (queriesTotal: number) => `
# HELP proxysql_questions_total queries
# TYPE proxysql_questions_total counter
proxysql_questions_total ${queriesTotal}
`;

test("parseProxySqlExposition: a counter decrease (sidecar restart) nulls that field and re-baselines", () => {
  const tracker = new CounterBaselineTracker();
  const first = parseProxySqlExposition(
    parsePrometheusExposition(RESETTABLE_EXPOSITION(1000)),
    ctx({ tracker, bootGeneration: 1 }),
  );
  assertEquals(first.queries, null);

  const second = parseProxySqlExposition(
    parsePrometheusExposition(RESETTABLE_EXPOSITION(1600)),
    ctx({ tracker, bootGeneration: 1 }),
  );
  assertEquals(second.queries, 600);

  const third = parseProxySqlExposition(
    parsePrometheusExposition(RESETTABLE_EXPOSITION(50)),
    ctx({ tracker, bootGeneration: 1 }),
  );
  assertEquals(third.queries, null);
});

test("parseProxySqlExposition: a boot generation change nulls the counter and re-baselines", () => {
  const tracker = new CounterBaselineTracker();
  parseProxySqlExposition(
    parsePrometheusExposition(RESETTABLE_EXPOSITION(1000)),
    ctx({ tracker, bootGeneration: 1 }),
  );
  parseProxySqlExposition(
    parsePrometheusExposition(RESETTABLE_EXPOSITION(1600)),
    ctx({ tracker, bootGeneration: 1 }),
  );
  const afterRestart = parseProxySqlExposition(
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
