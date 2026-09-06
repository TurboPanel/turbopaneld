/**
 * v4 shared hosting-ingress Traefik adapter (`src/deploy/ingress.ts`'s
 * `traefikCompose` — the loopback-only HTTP/HTTPS proxy fronting Docker
 * hostings, not any per-service tenant Traefik). Scrapes the dedicated
 * loopback Prometheus metrics entrypoint `traefikCompose` publishes
 * (`TRAEFIK_METRICS_ADDR`) and reuses the shared Prometheus text parser
 * (`../proxy/prom-exposition.ts`).
 *
 * Unlike Caddy's `caddy_http_requests_total`, Traefik's
 * `traefik_entrypoint_*` series are already scoped to the outer HTTP
 * entrypoint (`web`/`websecure`) with no nested per-handler re-instrumentation
 * risk, so every field here sums directly across whatever customer-facing
 * entrypoints are reporting — no reconciliation pass is needed the way
 * Caddy's is.
 *
 * `src/deploy/ingress.ts` also configures a dedicated `metrics` entrypoint
 * (`--entrypoints.metrics.address`) purely so this adapter has somewhere
 * loopback-only to scrape `/metrics` from. Every scrape of that endpoint is
 * itself an HTTP request Traefik routes through the `metrics` entrypoint, so
 * `traefik_entrypoint_*` series carrying `entrypoint="metrics"` describe the
 * collector's own monitoring traffic, not hosted application traffic.
 * Every `traefik_entrypoint_*` aggregation below excludes that entrypoint.
 */
import { TRAEFIK_METRICS_ADDR } from "../../../deploy/ingress.ts";
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

export { TRAEFIK_METRICS_ADDR };

/**
 * Every metric name `parseTraefikExposition` requires at least one of to
 * treat a scrape as a genuine Traefik `/metrics` response.
 * `traefik_entrypoint_open_connections` and `traefik_service_retries_total`/
 * `traefik_service_server_up` are deliberately excluded from this gate —
 * older Traefik builds or a service-less proxy may omit them, and their
 * absence should degrade the corresponding field to `null`, not the whole
 * source to absent.
 */
const TRAEFIK_EXPECTED_METRIC_NAMES = [
  "traefik_entrypoint_requests_total",
  "traefik_entrypoint_request_duration_seconds_count",
  "traefik_entrypoint_request_duration_seconds_sum",
  "traefik_entrypoint_request_duration_seconds_bucket",
  "traefik_entrypoint_requests_bytes_total",
  "traefik_entrypoint_responses_bytes_total",
] as const;

/**
 * The dedicated Prometheus-scrape entrypoint `src/deploy/ingress.ts`
 * configures for this adapter — never customer-facing traffic.
 */
const METRICS_ENTRYPOINT = "metrics";

function isCustomerEntrypoint(labels: Record<string, string>): boolean {
  return labels.entrypoint !== METRICS_ENTRYPOINT;
}

function classSum(
  samples: readonly PromSample[],
  digit: "2" | "3" | "4" | "5",
): number {
  return sumSamples(
    samples,
    "traefik_entrypoint_requests_total",
    (labels) =>
      (labels.code?.startsWith(digit) ?? false) &&
      isCustomerEntrypoint(labels),
  );
}

function bucketSum(samples: readonly PromSample[], le: string): number {
  return sumSamples(
    samples,
    "traefik_entrypoint_request_duration_seconds_bucket",
    (labels) => labels.le === le && isCustomerEntrypoint(labels),
  );
}

/** Pure parser — exported for fixture tests. */
export function parseTraefikExposition(
  samples: readonly PromSample[],
  ctx: IngressReadContext,
): IngressReading {
  const requestsTotal = sumSamples(
    samples,
    "traefik_entrypoint_requests_total",
    isCustomerEntrypoint,
  );
  const requests = ctx.tracker.delta(
    "ingress:traefik:requests",
    requestsTotal,
    ctx.bootGeneration,
  );

  const responses2xx = ctx.tracker.delta(
    "ingress:traefik:responses2xx",
    classSum(samples, "2"),
    ctx.bootGeneration,
  );
  const responses3xx = ctx.tracker.delta(
    "ingress:traefik:responses3xx",
    classSum(samples, "3"),
    ctx.bootGeneration,
  );
  const responses4xx = ctx.tracker.delta(
    "ingress:traefik:responses4xx",
    classSum(samples, "4"),
    ctx.bootGeneration,
  );
  const responses5xx = ctx.tracker.delta(
    "ingress:traefik:responses5xx",
    classSum(samples, "5"),
    ctx.bootGeneration,
  );

  const requestBytes = ctx.tracker.delta(
    "ingress:traefik:requestBytes",
    sumSamples(
      samples,
      "traefik_entrypoint_requests_bytes_total",
      isCustomerEntrypoint,
    ),
    ctx.bootGeneration,
  );
  const responseBytes = ctx.tracker.delta(
    "ingress:traefik:responseBytes",
    sumSamples(
      samples,
      "traefik_entrypoint_responses_bytes_total",
      isCustomerEntrypoint,
    ),
    ctx.bootGeneration,
  );

  const durationSumDelta = ctx.tracker.delta(
    "ingress:traefik:durationSum",
    sumSamples(
      samples,
      "traefik_entrypoint_request_duration_seconds_sum",
      isCustomerEntrypoint,
    ),
    ctx.bootGeneration,
  );
  const durationCountDelta = ctx.tracker.delta(
    "ingress:traefik:durationCount",
    sumSamples(
      samples,
      "traefik_entrypoint_request_duration_seconds_count",
      isCustomerEntrypoint,
    ),
    ctx.bootGeneration,
  );
  const requestDurationSecondsAvg =
    durationSumDelta === null || durationCountDelta === null ||
      durationCountDelta === 0
      ? null
      : durationSumDelta / durationCountDelta;

  const requestsUnder100ms = ctx.tracker.delta(
    "ingress:traefik:under100ms",
    bucketSum(samples, "0.1"),
    ctx.bootGeneration,
  );
  const requestsUnder500ms = ctx.tracker.delta(
    "ingress:traefik:under500ms",
    bucketSum(samples, "0.5"),
    ctx.bootGeneration,
  );
  const requestsUnder1s = ctx.tracker.delta(
    "ingress:traefik:under1s",
    bucketSum(samples, "1"),
    ctx.bootGeneration,
  );
  const requestsUnder5s = ctx.tracker.delta(
    "ingress:traefik:under5s",
    bucketSum(samples, "5"),
    ctx.bootGeneration,
  );

  const inFlightSamples = samples.filter((sample) =>
    sample.name === "traefik_entrypoint_open_connections" &&
    isCustomerEntrypoint(sample.labels)
  );
  const requestsInFlight = inFlightSamples.length === 0
    ? null
    : inFlightSamples.reduce((sum, sample) => sum + sample.value, 0);

  const hasRetriesSeries = samples.some((sample) =>
    sample.name === "traefik_service_retries_total"
  );
  let retries: number | null;
  if (hasRetriesSeries) {
    retries = ctx.tracker.delta(
      "ingress:traefik:retries",
      sumSamples(samples, "traefik_service_retries_total"),
      ctx.bootGeneration,
    );
  } else {
    ctx.tracker.invalidate("ingress:traefik:retries");
    retries = null;
  }

  const serverUpSamples = samples.filter((sample) =>
    sample.name === "traefik_service_server_up"
  );
  const upstreamsHealthy = serverUpSamples.length === 0
    ? null
    : serverUpSamples.reduce((sum, sample) => sum + sample.value, 0);
  const upstreamsTotal = serverUpSamples.length === 0
    ? null
    : serverUpSamples.length;

  const reading: IngressReading = {
    requests,
    responses2xx,
    responses3xx,
    responses4xx,
    responses5xx,
    // No direct Traefik equivalent distinct from the 5xx response class.
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
    retries,
  };
  return reading;
}

export class TraefikIngressAdapter implements IngressAdapter {
  readonly id = "traefik" as const;
  readonly #scrape: () => Promise<PromSample[] | null>;

  constructor(deps?: {
    addr?: string;
    now?: () => number;
    fetchText?: (addr: string, path: string) => Promise<string | undefined>;
  }) {
    const addr = deps?.addr ?? TRAEFIK_METRICS_ADDR;
    const fetchText = deps?.fetchText ?? fetchLoopbackText;
    this.#scrape = createRetryBoundedProbe(async () => {
      const text = await fetchText(addr, "/metrics");
      if (text === undefined) return null;
      const samples = parsePrometheusExposition(text);
      if (!containsAnyMetricName(samples, TRAEFIK_EXPECTED_METRIC_NAMES)) {
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
    const samples = await this.#scrape();
    if (!samples) return null;
    try {
      const reading = parseTraefikExposition(samples, ctx);
      return { sourceId: "traefik", sourceKind: "traefik", reading };
    } catch {
      return null;
    }
  }
}
