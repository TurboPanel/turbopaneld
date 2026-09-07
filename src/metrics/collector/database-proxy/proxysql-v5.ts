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
 * is no per-handler reconciliation concern.
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
 * Every metric name `parseProxySqlExpositionV5` requires at least one of to
 * treat a scrape as a genuine ProxySQL `/metrics` response.
 */
const PROXYSQL_V5_EXPECTED_METRIC_NAMES = [
  "proxysql_questions_total",
  "proxysql_slow_queries_total",
  "proxysql_connpool_conns_total",
  "proxysql_client_connections_connected",
  "proxysql_server_connections_connected",
  "proxysql_connpool_conns_status",
] as const;

/** `proxysql_connpool_conns_status` value for an ONLINE backend (see the metric's own HELP text). */
const CONNPOOL_STATUS_ONLINE = 1;

/** Pure parser — exported for fixture tests. */
export function parseProxySqlExpositionV5(
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
  const backendsUp = countSamples(
    samples,
    "proxysql_connpool_conns_status",
    (_labels, value) => value === CONNPOOL_STATUS_ONLINE,
  );

  return {
    queries,
    slowQueries,
    connectionErrors,
    clientConnections,
    backendConnections,
    backendsUp,
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
        !containsAnyMetricName(samples, PROXYSQL_V5_EXPECTED_METRIC_NAMES)
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
      const reading = parseProxySqlExpositionV5(samples, ctx);
      return { sourceId: "proxysql", sourceKind: "proxysql", reading };
    } catch {
      return null;
    }
  }
}
