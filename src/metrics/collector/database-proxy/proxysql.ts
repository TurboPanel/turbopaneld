/**
 * v5 managed-ProxySQL database-proxy adapter (`src/managed/proxysql.ts` —
 * the shared, containerized ProxySQL managed-ingress). `admin-restapi_enabled`
 * / `admin-restapi_port` (rendered by `renderProxySqlStaticConfig`) start an
 * unauthenticated HTTP REST server inside the container whose only route is
 * `GET /metrics` (see `lib/ProxySQL_Admin.cpp::load_restapi_server` in the
 * ProxySQL source — the callback never checks credentials), published to the
 * host on loopback only, same as the admin MySQL-protocol port. Reuses the
 * shared Prometheus text parser (`../proxy/prom-exposition.ts`).
 *
 * Unlike Caddy's request-chain metrics, every ProxySQL counter/gauge this
 * adapter reads is a single process-wide (or backend-summed) series — there
 * is no per-handler reconciliation concern. Several are label-partitioned by
 * `protocol` (mysql/pgsql) and, on the connection-pool families, by
 * `endpoint`/`hostgroup`; summing across those labels is correct because the
 * contract field is "this proxy's total", not a per-backend breakdown.
 *
 * Every metric name below is verified against ProxySQL's published Prometheus
 * metric catalog. Two shapes worth noting, because a plausible-looking guess
 * would be wrong:
 *
 * - Connection churn is *not* separate `_created_total`/`_aborted_total`
 *   metrics; it is one counter per side (`proxysql_client_connections_total`,
 *   `proxysql_server_connections_total`) partitioned by a `status` label.
 * - There is no query-duration histogram anywhere in the catalog, only
 *   cumulative time counters (`proxysql_query_processor_time_seconds_total`,
 *   `proxysql_backend_query_time_seconds_total`). That is why both latency
 *   fields are per-interval means and why `managed.database_proxy` has no
 *   percentiles the way `managed.ingress` does — there are no buckets to
 *   derive them from.
 */
import { createRetryBoundedProbe } from "../proxy/endpoint-cache.ts";
import {
  containsAnyMetricName,
  countSamples,
  fetchLoopbackText,
  parsePrometheusExposition,
  type PromSample,
  sumSamples,
} from "../proxy/prom-exposition.ts";
import type {
  DatabaseProxyAdapter,
  DatabaseProxyReadContext,
  DatabaseProxyReading,
} from "./adapter.ts";

/** Mirrors `orchestration/roles/proxysql/defaults/main.yml` `proxysql_restapi_port`, published to loopback only. */
export const PROXYSQL_REST_ADDR = "127.0.0.1:6070";

/**
 * Every metric name `parseProxySqlExposition` requires at least one of to
 * treat a scrape as a genuine ProxySQL `/metrics` response.
 */
const PROXYSQL_EXPECTED_METRIC_NAMES = [
  "proxysql_questions_total",
  "proxysql_slow_queries_total",
  "proxysql_connpool_conns_total",
  "proxysql_client_connections_connected",
  "proxysql_server_connections_connected",
  "proxysql_connpool_conns_status",
] as const;

/** `proxysql_connpool_conns_status` value for an ONLINE backend (see the metric's own HELP text). */
const CONNPOOL_STATUS_ONLINE = 1;

const MS_PER_SECOND = 1000;

/**
 * A cumulative counter's per-interval delta, or `null` (with the baseline key
 * invalidated) when the family is absent from this scrape. Invalidating rather
 * than diffing against a stale baseline keeps a later readable tick from
 * reporting one enormous catch-up delta across the gap.
 */
function counterDeltaOrNull(
  samples: readonly PromSample[],
  ctx: DatabaseProxyReadContext,
  key: string,
  name: string,
  predicate?: (labels: Record<string, string>) => boolean,
): number | null {
  if (!samples.some((sample) => sample.name === name)) {
    ctx.tracker.invalidate(key);
    return null;
  }
  return ctx.tracker.delta(
    key,
    sumSamples(samples, name, predicate),
    ctx.bootGeneration,
  );
}

/**
 * A gauge summed across its label set, or `null` when the family is absent —
 * "ProxySQL does not report this" must never read as a confident `0`.
 */
function gaugeSumOrNull(
  samples: readonly PromSample[],
  name: string,
): number | null {
  const matching = samples.filter((sample) => sample.name === name);
  if (matching.length === 0) return null;
  return matching.reduce((sum, sample) => sum + sample.value, 0);
}

/** Mean milliseconds per query for the interval, from a cumulative seconds counter. */
function meanLatencyMs(
  secondsDelta: number | null,
  queriesDelta: number | null,
): number | null {
  if (secondsDelta === null || queriesDelta === null || queriesDelta <= 0) {
    return null;
  }
  return (secondsDelta / queriesDelta) * MS_PER_SECOND;
}

/** Pure parser — exported for fixture tests. */
export function parseProxySqlExposition(
  samples: readonly PromSample[],
  ctx: DatabaseProxyReadContext,
): DatabaseProxyReading {
  const queries = ctx.tracker.delta(
    "dbproxy:proxysql:queries",
    sumSamples(samples, "proxysql_questions_total"),
    ctx.bootGeneration,
  );
  const slowQueries = ctx.tracker.delta(
    "dbproxy:proxysql:slowQueries",
    sumSamples(samples, "proxysql_slow_queries_total"),
    ctx.bootGeneration,
  );
  const connectionErrors = ctx.tracker.delta(
    "dbproxy:proxysql:connectionErrors",
    sumSamples(
      samples,
      "proxysql_connpool_conns_total",
      (labels) => labels.status === "err",
    ),
    ctx.bootGeneration,
  );
  const clientConnections = sumSamples(
    samples,
    "proxysql_client_connections_connected",
  );
  const backendConnections = sumSamples(
    samples,
    "proxysql_server_connections_connected",
  );

  // `proxysql_connpool_conns_status` is one gauge per backend, valued by its
  // status enum (1 = ONLINE). Counting the ONLINE ones gives "how many are
  // up"; counting every series gives "how many backends exist at all", which
  // is what makes a partial outage visible rather than just a smaller number.
  const backendsUp = countSamples(
    samples,
    "proxysql_connpool_conns_status",
    (_labels, value) => value === CONNPOOL_STATUS_ONLINE,
  );
  const backendsTotal = countSamples(
    samples,
    "proxysql_connpool_conns_status",
    () => true,
  );

  const activeTransactions = gaugeSumOrNull(
    samples,
    "proxysql_active_transactions",
  );

  // Connection churn: one counter per side, partitioned by a `status` label
  // (created / aborted; the server side also has `delayed`, which is neither).
  const clientConnectionsCreated = counterDeltaOrNull(
    samples,
    ctx,
    "dbproxy:proxysql:clientConnectionsCreated",
    "proxysql_client_connections_total",
    (labels) => labels.status === "created",
  );
  const clientConnectionsAborted = counterDeltaOrNull(
    samples,
    ctx,
    "dbproxy:proxysql:clientConnectionsAborted",
    "proxysql_client_connections_total",
    (labels) => labels.status === "aborted",
  );
  const backendConnectionsCreated = counterDeltaOrNull(
    samples,
    ctx,
    "dbproxy:proxysql:backendConnectionsCreated",
    "proxysql_server_connections_total",
    (labels) => labels.status === "created",
  );
  const backendConnectionsAborted = counterDeltaOrNull(
    samples,
    ctx,
    "dbproxy:proxysql:backendConnectionsAborted",
    "proxysql_server_connections_total",
    (labels) => labels.status === "aborted",
  );
  const connectionsRejectedMaxConns = counterDeltaOrNull(
    samples,
    ctx,
    "dbproxy:proxysql:connectionsRejectedMaxConns",
    "proxysql_access_denied_max_connections_total",
  );

  // Byte flow across the connection pool, excluding protocol metadata — the
  // `traffic_flow` label is from ProxySQL's point of view, so `recv` is data
  // arriving *from* the backends.
  const bytesFromBackends = counterDeltaOrNull(
    samples,
    ctx,
    "dbproxy:proxysql:bytesFromBackends",
    "proxysql_connpool_data_bytes_total",
    (labels) => labels.traffic_flow === "recv",
  );
  const bytesToBackends = counterDeltaOrNull(
    samples,
    ctx,
    "dbproxy:proxysql:bytesToBackends",
    "proxysql_connpool_data_bytes_total",
    (labels) => labels.traffic_flow === "sent",
  );

  // ProxySQL exposes cumulative time totals, not histograms, so both latency
  // figures are interval means over the same interval's query delta.
  // `backendLatencyMsAvg` is the time spent talking to the backends;
  // `queryLatencyMsAvg` adds ProxySQL's own query-processor time on top, so
  // the gap between the two is the proxy's own overhead.
  const backendQueryTimeDelta = counterDeltaOrNull(
    samples,
    ctx,
    "dbproxy:proxysql:backendQueryTime",
    "proxysql_backend_query_time_seconds_total",
  );
  const queryProcessorTimeDelta = counterDeltaOrNull(
    samples,
    ctx,
    "dbproxy:proxysql:queryProcessorTime",
    "proxysql_query_processor_time_seconds_total",
  );
  const backendLatencyMsAvg = meanLatencyMs(backendQueryTimeDelta, queries);
  const queryLatencyMsAvg =
    backendQueryTimeDelta === null || queryProcessorTimeDelta === null
      ? null
      : meanLatencyMs(backendQueryTimeDelta + queryProcessorTimeDelta, queries);

  return {
    queries,
    slowQueries,
    queryLatencyMsAvg,
    backendLatencyMsAvg,
    activeTransactions,
    clientConnections,
    clientConnectionsCreated,
    clientConnectionsAborted,
    connectionsRejectedMaxConns,
    backendConnections,
    backendConnectionsCreated,
    backendConnectionsAborted,
    connectionErrors,
    backendsUp,
    backendsTotal,
    bytesFromBackends,
    bytesToBackends,
  };
}

export class ProxySqlDatabaseProxyAdapter implements DatabaseProxyAdapter {
  readonly id = "proxysql" as const;
  readonly #scrape: () => Promise<PromSample[] | null>;

  constructor(deps?: {
    addr?: string;
    now?: () => number;
    fetchText?: (addr: string, path: string) => Promise<string | undefined>;
  }) {
    const addr = deps?.addr ?? PROXYSQL_REST_ADDR;
    const fetchText = deps?.fetchText ?? fetchLoopbackText;
    this.#scrape = createRetryBoundedProbe(async () => {
      const text = await fetchText(addr, "/metrics");
      if (text === undefined) return null;
      const samples = parsePrometheusExposition(text);
      if (
        !containsAnyMetricName(samples, PROXYSQL_EXPECTED_METRIC_NAMES)
      ) {
        return null;
      }
      return samples;
    }, deps?.now);
  }

  async probe(): Promise<void> {
    // Reachability is re-checked every tick via the retry-bounded scrape
    // itself — there is nothing separate to memoize up front.
  }

  async read(
    ctx: DatabaseProxyReadContext,
  ): Promise<
    | { sourceId: string; sourceKind: string; reading: DatabaseProxyReading }
    | null
  > {
    const samples = await this.#scrape();
    if (!samples) return null;
    try {
      const reading = parseProxySqlExposition(samples, ctx);
      return { sourceId: "proxysql", sourceKind: "proxysql", reading };
    } catch {
      return null;
    }
  }
}
