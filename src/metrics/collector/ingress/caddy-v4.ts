/**
 * v4 site-Caddy ingress adapter (`orchestration/roles/site-caddy` — the
 * unprivileged per-site Caddy, not the hosting Caddy in
 * `src/deploy/ingress.ts` nor the control-plane Caddy). That role's
 * `Caddyfile.j2` sets the global `metrics` option, which is what actually
 * exposes Prometheus text at `/metrics` on the admin listener (`servers
 * { metrics }` alone only turns on per-server instrumentation and leaves
 * `/metrics` 404); there is no supported way to bind a *second* admin API
 * for just metrics, so this reads the same loopback admin address the role
 * already reserves (`site_caddy_admin_addr`, mirrored here as
 * `SITE_CADDY_ADMIN_ADDR`, the same way `HOSTING_CADDY_ADMIN_ADDR` mirrors
 * the hosting Caddy's in `src/deploy/ingress.ts`), and reuses the shared
 * Prometheus text parser (`../proxy/prom-exposition.ts`).
 *
 * **Canonical single-request aggregation scope.** Every handler Caddy places
 * in a request's handler chain — the site's top-level `subroute`, and any
 * `handle`/`reverse_proxy`/`file_server` terminal handler nested under it —
 * is wrapped in its own copy of the `metrics` instrumentation. That means
 * `caddy_http_requests_total{handler,server}`, `caddy_http_requests_in_flight`,
 * and the request-duration/size histograms are *all* incremented once per
 * handler a request actually passes through, not once per request. An
 * outer handler's count is therefore always >= every handler nested inside
 * it (it sees a superset of the same requests), and summing every
 * `(server,handler)` group unconditionally double- (or n-)counts every
 * derived field, `requests` and `requestsInFlight` included — there
 * is no metric on this exposition that is naturally scoped to "once per
 * request".
 *
 * The fix: for each `server`, the `(server,handler)` group with the
 * *largest* `caddy_http_requests_total` value is the outermost handler in
 * the chain — the one every one of that server's requests passed through —
 * and is the sole **valid** group whose data feeds every normalized field.
 * A tie at the max is the normal shape of a single-terminal site — e.g. a
 * bare `reverse_proxy`/`file_server` site compiles to `subroute` wrapping
 * that one handler, so every request passes through both and their counts
 * always tie — and is broken deterministically by handler name so the
 * choice is stable and requests are still counted exactly once, never
 * doubled. This assumes every request passes through
 * one identifiable outermost handler; a split-routing server with no such
 * wrapper (disjoint handlers, none of which sees the full request set) can't
 * be distinguished from a partial nested duplicate from the exposition data
 * alone, so it is not specially handled — the max-count handler is used as
 * the closest available approximation of "most inclusive scope".
 */
import { createRetryBoundedProbe } from "../proxy/endpoint-cache.ts";
import {
  containsAnyMetricName,
  fetchLoopbackText,
  parsePrometheusExposition,
  type PromSample,
  sumSamples,
} from "../proxy/prom-exposition.ts";
import type {
  IngressAdapter,
  IngressReadContext,
  IngressReading,
} from "./adapter.ts";

/** Mirrors `orchestration/roles/site-caddy/defaults/main.yml` `site_caddy_admin_addr`. */
export const SITE_CADDY_ADMIN_ADDR = "127.0.0.1:2039";

/**
 * Every metric name `parseCaddyExpositionV4` requires at least one of to
 * treat a scrape as a genuine Caddy `/metrics` response.
 */
const CADDY_V4_EXPECTED_METRIC_NAMES = [
  "caddy_http_requests_total",
  "caddy_http_request_duration_seconds_count",
  "caddy_http_request_duration_seconds_sum",
  "caddy_http_request_duration_seconds_bucket",
  "caddy_http_request_size_bytes_sum",
  "caddy_http_response_size_bytes_sum",
  "caddy_http_requests_in_flight",
] as const;

/** `server::handler` key for the per-handler-group reconciliation. */
function groupKey(server: string, handler: string): string {
  return `${server}::${handler}`;
}

/**
 * For each `server`, the sole `(server,handler)` group treated as this
 * scrape's authoritative, no-double-count aggregation scope — the handler
 * with the largest `caddy_http_requests_total` value (the outermost handler
 * every one of that server's requests passed through). Ties broken by
 * handler name for a stable, deterministic choice. See the module doc
 * comment.
 */
function resolveValidGroups(samples: readonly PromSample[]): Set<string> {
  const handlerTotals = new Map<string, number>();
  const handlersByServer = new Map<string, Set<string>>();
  for (const sample of samples) {
    if (sample.name !== "caddy_http_requests_total") continue;
    const server = sample.labels.server;
    const handler = sample.labels.handler;
    if (server === undefined || handler === undefined) continue;
    const key = groupKey(server, handler);
    handlerTotals.set(key, (handlerTotals.get(key) ?? 0) + sample.value);
    const handlers = handlersByServer.get(server) ?? new Set();
    handlers.add(handler);
    handlersByServer.set(server, handlers);
  }

  const valid = new Set<string>();
  for (const [server, handlers] of handlersByServer) {
    let maxCount = -Infinity;
    for (const handler of handlers) {
      maxCount = Math.max(
        maxCount,
        handlerTotals.get(groupKey(server, handler))!,
      );
    }
    const outermost = [...handlers]
      .filter((handler) =>
        handlerTotals.get(groupKey(server, handler)) === maxCount
      )
      .sort((a, b) => a.localeCompare(b))[0]!;
    valid.add(groupKey(server, outermost));
  }
  return valid;
}

function isValidGroupSample(
  labels: Record<string, string>,
  validGroups: ReadonlySet<string>,
): boolean {
  const server = labels.server;
  const handler = labels.handler;
  if (server === undefined || handler === undefined) return false;
  return validGroups.has(groupKey(server, handler));
}

function classSum(
  samples: readonly PromSample[],
  validGroups: ReadonlySet<string>,
  digit: "2" | "3" | "4" | "5",
): number {
  return sumSamples(
    samples,
    "caddy_http_request_duration_seconds_count",
    (labels) =>
      (labels.code?.startsWith(digit) ?? false) &&
      isValidGroupSample(labels, validGroups),
  );
}

function bucketSum(
  samples: readonly PromSample[],
  validGroups: ReadonlySet<string>,
  le: string,
): number {
  return sumSamples(
    samples,
    "caddy_http_request_duration_seconds_bucket",
    (labels) => labels.le === le && isValidGroupSample(labels, validGroups),
  );
}

/**
 * Pure parser — exported for fixture tests. `samples` must already be a
 * gated Caddy `/metrics` scrape (see {@link CADDY_V4_EXPECTED_METRIC_NAMES}).
 */
export function parseCaddyExpositionV4(
  samples: readonly PromSample[],
  ctx: IngressReadContext,
): IngressReading {
  const validGroups = resolveValidGroups(samples);

  const requestsTotal = sumSamples(
    samples,
    "caddy_http_requests_total",
    (labels) => isValidGroupSample(labels, validGroups),
  );
  const requests = ctx.tracker.delta(
    "ingress:caddy:requests",
    requestsTotal,
    ctx.bootGeneration,
  );

  const responses2xx = ctx.tracker.delta(
    "ingress:caddy:responses2xx",
    classSum(samples, validGroups, "2"),
    ctx.bootGeneration,
  );
  const responses3xx = ctx.tracker.delta(
    "ingress:caddy:responses3xx",
    classSum(samples, validGroups, "3"),
    ctx.bootGeneration,
  );
  const responses4xx = ctx.tracker.delta(
    "ingress:caddy:responses4xx",
    classSum(samples, validGroups, "4"),
    ctx.bootGeneration,
  );
  const responses5xx = ctx.tracker.delta(
    "ingress:caddy:responses5xx",
    classSum(samples, validGroups, "5"),
    ctx.bootGeneration,
  );

  const requestBytesTotal = sumSamples(
    samples,
    "caddy_http_request_size_bytes_sum",
    (labels) => isValidGroupSample(labels, validGroups),
  );
  const requestBytes = ctx.tracker.delta(
    "ingress:caddy:requestBytes",
    requestBytesTotal,
    ctx.bootGeneration,
  );

  const responseBytesTotal = sumSamples(
    samples,
    "caddy_http_response_size_bytes_sum",
    (labels) => isValidGroupSample(labels, validGroups),
  );
  const responseBytes = ctx.tracker.delta(
    "ingress:caddy:responseBytes",
    responseBytesTotal,
    ctx.bootGeneration,
  );

  const durationSumTotal = sumSamples(
    samples,
    "caddy_http_request_duration_seconds_sum",
    (labels) => isValidGroupSample(labels, validGroups),
  );
  const durationCountTotal = sumSamples(
    samples,
    "caddy_http_request_duration_seconds_count",
    (labels) => isValidGroupSample(labels, validGroups),
  );
  const durationSumDelta = ctx.tracker.delta(
    "ingress:caddy:durationSum",
    durationSumTotal,
    ctx.bootGeneration,
  );
  const durationCountDelta = ctx.tracker.delta(
    "ingress:caddy:durationCount",
    durationCountTotal,
    ctx.bootGeneration,
  );
  const requestDurationSecondsAvg =
    durationSumDelta === null || durationCountDelta === null ||
      durationCountDelta === 0
      ? null
      : durationSumDelta / durationCountDelta;

  const requestsUnder100ms = ctx.tracker.delta(
    "ingress:caddy:under100ms",
    bucketSum(samples, validGroups, "0.1"),
    ctx.bootGeneration,
  );
  const requestsUnder500ms = ctx.tracker.delta(
    "ingress:caddy:under500ms",
    bucketSum(samples, validGroups, "0.5"),
    ctx.bootGeneration,
  );
  const requestsUnder1s = ctx.tracker.delta(
    "ingress:caddy:under1s",
    bucketSum(samples, validGroups, "1"),
    ctx.bootGeneration,
  );
  const requestsUnder5s = ctx.tracker.delta(
    "ingress:caddy:under5s",
    bucketSum(samples, validGroups, "5"),
    ctx.bootGeneration,
  );

  const requestsInFlight = sumSamples(
    samples,
    "caddy_http_requests_in_flight",
    (labels) => isValidGroupSample(labels, validGroups),
  );

  const upstreamHealthSamples = samples.filter((sample) =>
    sample.name === "caddy_reverse_proxy_upstreams_healthy"
  );
  const upstreamsHealthy = upstreamHealthSamples.length === 0
    ? null
    : upstreamHealthSamples.reduce((sum, sample) => sum + sample.value, 0);
  const upstreamsTotal = upstreamHealthSamples.length === 0
    ? null
    : upstreamHealthSamples.length;

  const reading: IngressReading = {
    requests,
    responses2xx,
    responses3xx,
    responses4xx,
    responses5xx,
    // No documented per-request Caddy error counter distinct from the 5xx
    // response class — never invented here.
    requestErrors: null,
    requestBytes,
    responseBytes,
    requestDurationSecondsAvg,
    requestsUnder100ms,
    requestsUnder500ms,
    requestsUnder1s,
    requestsUnder5s,
    requestsInFlight,
    upstreamsHealthy,
    upstreamsTotal,
    // No documented Caddy retry-count equivalent (Traefik's
    // `traefik_service_retries_total` has no Caddy analogue).
    retries: null,
  };
  return reading;
}

export class CaddyIngressAdapter implements IngressAdapter {
  readonly id = "caddy" as const;
  private readonly scrape: () => Promise<PromSample[] | null>;

  constructor(deps?: {
    addr?: string;
    now?: () => number;
    fetchText?: (addr: string, path: string) => Promise<string | undefined>;
  }) {
    const addr = deps?.addr ?? SITE_CADDY_ADMIN_ADDR;
    const fetchText = deps?.fetchText ?? fetchLoopbackText;
    this.scrape = createRetryBoundedProbe(async () => {
      const text = await fetchText(addr, "/metrics");
      if (text === undefined) return null;
      const samples = parsePrometheusExposition(text);
      if (!containsAnyMetricName(samples, CADDY_V4_EXPECTED_METRIC_NAMES)) {
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
    ctx: IngressReadContext,
  ): Promise<
    | { sourceId: string; sourceKind: string; reading: IngressReading }
    | null
  > {
    const samples = await this.scrape();
    if (!samples) return null;
    try {
      const reading = parseCaddyExpositionV4(samples, ctx);
      return { sourceId: "caddy", sourceKind: "caddy", reading };
    } catch {
      return null;
    }
  }
}
