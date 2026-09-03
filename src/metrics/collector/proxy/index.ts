/**
 * Combined traffic-sidecar scrape: site Caddy + managed ProxySQL, each
 * independently retry-bounded so one absent/unhealthy source never blocks or
 * throttles the other.
 */
import { logWarn, sanitizeForLog } from "../../../logger.ts";
import { readCaddyMetrics, SITE_CADDY_ADMIN_ADDR } from "./caddy.ts";
import { PROXYSQL_REST_ADDR, readProxySqlMetrics } from "./proxysql.ts";
import {
  createRetryBoundedProbe,
  PROXY_ENDPOINT_RETRY_MS,
} from "./endpoint-cache.ts";
import type {
  CaddyCounters,
  ProxyCounters,
  ProxySqlCounters,
} from "../types.ts";

export {
  parseCaddyExposition,
  readCaddyMetrics,
  SITE_CADDY_ADMIN_ADDR,
} from "./caddy.ts";
export {
  parseProxySqlExposition,
  PROXYSQL_REST_ADDR,
  readProxySqlMetrics,
} from "./proxysql.ts";
export {
  createRetryBoundedProbe,
  PROXY_ENDPOINT_RETRY_MS,
} from "./endpoint-cache.ts";
export type { PromSample } from "./prom-exposition.ts";

export type ProxyCountersDeps = {
  readCaddy?: () => Promise<CaddyCounters | null>;
  readProxySql?: () => Promise<ProxySqlCounters | null>;
  now?: () => number;
  /** Overrides the default `logWarn("metrics", …)` sink (tests). */
  onLog?: (message: string) => void;
  /** Minimum gap between repeated scrape-failure logs for the same source (tests). */
  logRateLimitMs?: number;
};

function defaultOnLog(message: string): void {
  logWarn("metrics", message);
}

/**
 * Wrap one source's probe so a scrape/parse failure (unreachable, an
 * unexpected/empty body, or a thrown parse error — `readCaddyMetrics`/
 * `readProxySqlMetrics` collapse all three to `null`) logs a rate-limited
 * warning instead of silently caching as a healthy zero snapshot. Mirrors
 * `MetricsScheduler`'s `#logRateLimited` key/timestamp idiom
 * (`../../scheduler.ts`) so a stopped or misconfigured sidecar surfaces at
 * most one log line per {@link PROXY_ENDPOINT_RETRY_MS}, not one per tick.
 */
function withFailureLogging<T>(
  source: string,
  probe: () => Promise<T | null>,
  now: () => number,
  onLog: (message: string) => void,
  logRateLimitMs: number,
): () => Promise<T | null> {
  let lastLoggedAtMs: number | null = null;
  const logRateLimited = (message: string): void => {
    const nowMs = now();
    if (
      lastLoggedAtMs !== null && nowMs - lastLoggedAtMs < logRateLimitMs
    ) {
      return;
    }
    lastLoggedAtMs = nowMs;
    onLog(message);
  };
  return async () => {
    try {
      const result = await probe();
      if (result === null) {
        logRateLimited(`${source} traffic scrape returned no metrics`);
      }
      return result;
    } catch (err) {
      logRateLimited(
        `${source} traffic scrape failed: ${sanitizeForLog(err)}`,
      );
      return null;
    }
  };
}

/** Build the `CollectorDeps.readProxyCounters` implementation. */
export function createProxyCountersReader(
  deps: ProxyCountersDeps = {},
): () => Promise<ProxyCounters> {
  const now = deps.now ?? (() => Date.now());
  const onLog = deps.onLog ?? defaultOnLog;
  const logRateLimitMs = deps.logRateLimitMs ?? PROXY_ENDPOINT_RETRY_MS;

  const readCaddy = withFailureLogging(
    "caddy",
    createRetryBoundedProbe(
      deps.readCaddy ?? (() => readCaddyMetrics(SITE_CADDY_ADMIN_ADDR)),
      deps.now,
    ),
    now,
    onLog,
    logRateLimitMs,
  );
  const readProxySql = withFailureLogging(
    "proxysql",
    createRetryBoundedProbe(
      deps.readProxySql ?? (() => readProxySqlMetrics(PROXYSQL_REST_ADDR)),
      deps.now,
    ),
    now,
    onLog,
    logRateLimitMs,
  );

  return async () => {
    const [caddy, proxysql] = await Promise.all([
      readCaddy().catch(() => null),
      readProxySql().catch(() => null),
    ]);
    return { caddy, proxysql };
  };
}
