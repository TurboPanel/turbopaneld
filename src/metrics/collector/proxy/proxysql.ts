/**
 * Managed ProxySQL traffic scrape (`src/managed/proxysql.ts` — the shared,
 * containerized ProxySQL managed-ingress). `admin-restapi_enabled` /
 * `admin-restapi_port` (rendered by `renderProxySqlStaticConfig`) start an
 * unauthenticated HTTP REST server inside the container whose only route is
 * `GET /metrics` (see `lib/ProxySQL_Admin.cpp::load_restapi_server` in the
 * ProxySQL source — the callback never checks credentials), published to the
 * host on loopback only, same as the admin MySQL-protocol port.
 *
 * Metric names/labels below are verified against ProxySQL 3.0.x
 * (`lib/MySQL_Thread.cpp`, `lib/MySQL_HostGroups_Manager.cpp`):
 * `proxysql_questions_total` / `proxysql_slow_queries_total` are process-wide
 * counters; `proxysql_client_connections_connected` /
 * `proxysql_server_connections_connected` are process-wide gauges;
 * `proxysql_connpool_conns_total{status="err"}` and
 * `proxysql_connpool_conns_status` are per-backend dynamic series (summed /
 * counted across every backend label combination).
 */
import type { ProxySqlCounters } from "../types.ts";
import {
  containsAnyMetricName,
  countSamples,
  fetchLoopbackText,
  parsePrometheusExposition,
  sumSamples,
} from "./prom-exposition.ts";

/** Mirrors `orchestration/roles/proxysql/defaults/main.yml` `proxysql_restapi_port`, published to loopback only. */
export const PROXYSQL_REST_ADDR = "127.0.0.1:6070";

/**
 * Every metric name `parseProxySqlExposition` reads. A body containing none
 * of these is not a ProxySQL `/metrics` response — an empty body or the
 * wrong loopback service answering on `PROXYSQL_REST_ADDR` both look the
 * same otherwise: a 200 that `parseProxySqlExposition` would happily reduce
 * to an all-zero snapshot instead of surfacing as a failed scrape.
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

/** Pure parser — exported for fixture tests. */
export function parseProxySqlExposition(text: string): ProxySqlCounters {
  const samples = parsePrometheusExposition(text);
  return {
    queriesTotal: sumSamples(samples, "proxysql_questions_total"),
    slowQueriesTotal: sumSamples(samples, "proxysql_slow_queries_total"),
    connectionErrorsTotal: sumSamples(
      samples,
      "proxysql_connpool_conns_total",
      (labels) => labels.status === "err",
    ),
    clientConnections: sumSamples(
      samples,
      "proxysql_client_connections_connected",
    ),
    backendConnections: sumSamples(
      samples,
      "proxysql_server_connections_connected",
    ),
    backendsUp: countSamples(
      samples,
      "proxysql_connpool_conns_status",
      (_labels, value) => value === CONNPOOL_STATUS_ONLINE,
    ),
  };
}

/**
 * One scrape of ProxySQL's REST `/metrics`; `null` on any failure —
 * unreachable, no expected metric present (see
 * {@link PROXYSQL_EXPECTED_METRIC_NAMES}), or a parse throw.
 */
export async function readProxySqlMetrics(
  restAddr: string = PROXYSQL_REST_ADDR,
): Promise<ProxySqlCounters | null> {
  const text = await fetchLoopbackText(restAddr, "/metrics");
  if (text === undefined) return null;
  const samples = parsePrometheusExposition(text);
  if (!containsAnyMetricName(samples, PROXYSQL_EXPECTED_METRIC_NAMES)) {
    return null;
  }
  try {
    return parseProxySqlExposition(text);
  } catch {
    return null;
  }
}
