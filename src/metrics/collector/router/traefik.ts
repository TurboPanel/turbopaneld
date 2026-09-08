/**
 * Shared hosting-ingress Traefik router adapter (`src/deploy/ingress.ts`'s
 * `traefikCompose` — the loopback-only HTTP/HTTPS proxy fronting Docker
 * hostings, not any per-service tenant Traefik). Scrapes the dedicated
 * loopback Prometheus metrics entrypoint `traefikCompose` publishes
 * (`TRAEFIK_METRICS_ADDR`) and reuses the shared Prometheus text parser
 * (`../proxy/prom-exposition.ts`).
 *
 * **Why this is not an ingress source.** v5 reported Traefik as a second
 * `ingressSources[]` entry alongside the site Caddy, which forced both onto
 * one 17-field layout that fit neither: Traefik's `traefik_service_*` /
 * `traefik_router_*` view (backends, services, retries, config reloads, TLS
 * expiry) has no Caddy analogue, and Caddy's per-handler request accounting
 * has none in Traefik. v6 gives the router its own host-wide family, so each
 * side reports what its exposition actually answers.
 *
 * Every metric name below is verified against Traefik v3's documented
 * Prometheus reference for the pinned `TRAEFIK_IMAGE` in
 * `src/deploy/ingress.ts`. Note the label-set defaults that reference also
 * documents: `addServicesLabels` and `addEntryPointsLabels` are on by
 * default, `addRoutersLabels` is **off** — `src/deploy/ingress.ts` passes
 * `--metrics.prometheus.addRoutersLabels=true` explicitly, without which
 * `traefik_router_*` never appears and `routersTotal` would be permanently
 * `null`.
 *
 * `src/deploy/ingress.ts` also configures a dedicated `metrics` entrypoint
 * (`--entrypoints.metrics.address`) purely so this adapter has somewhere
 * loopback-only to scrape `/metrics` from. Every scrape of that endpoint is
 * itself an HTTP request Traefik routes through the `metrics` entrypoint, so
 * `traefik_open_connections{entrypoint="metrics"}` describes the collector's
 * own monitoring traffic, not hosted application traffic, and is excluded.
 * The `traefik_service_*` families carry no `entrypoint` label at all — they
 * are already scoped to real backend services, and the metrics entrypoint has
 * no service behind it — so they need no such exclusion.
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
  RouterAdapter,
  RouterReadContext,
  RouterReading,
} from "./adapter.ts";

export { TRAEFIK_METRICS_ADDR };

/**
 * Every metric name `parseTraefikRouterExposition` requires at least one of
 * to treat a scrape as a genuine Traefik `/metrics` response.
 *
 * Deliberately only the two always-present global families: a freshly-started
 * router with no services configured yet emits `traefik_config_reloads_total`
 * and `traefik_config_last_reload_success` but no `traefik_service_*` series
 * at all, and that state should degrade the service-derived fields to `null`
 * rather than the whole router to absent. That degrade rule is also why a
 * wrong metric name below fails silently: the names must track the pinned
 * image in `src/deploy/ingress.ts`.
 */
const TRAEFIK_EXPECTED_METRIC_NAMES = [
  "traefik_config_reloads_total",
  "traefik_config_last_reload_success",
] as const;

/**
 * The dedicated Prometheus-scrape entrypoint `src/deploy/ingress.ts`
 * configures for this adapter — never customer-facing traffic.
 */
const METRICS_ENTRYPOINT = "metrics";

const SECONDS_PER_DAY = 86_400;

function isCustomerEntrypoint(labels: Record<string, string>): boolean {
  return labels.entrypoint !== METRICS_ENTRYPOINT;
}

function samplesNamed(
  samples: readonly PromSample[],
  name: string,
): PromSample[] {
  return samples.filter((sample) => sample.name === name);
}

/**
 * A gauge summed across its label set, or `null` when the family is absent
 * entirely. The `null` distinction matters: "no `traefik_service_server_up`
 * series exist" (no services configured) must not read as "0 backends up".
 */
function gaugeSumOrNull(
  samples: readonly PromSample[],
  name: string,
  predicate?: (labels: Record<string, string>) => boolean,
): number | null {
  const matching = samplesNamed(samples, name).filter((sample) =>
    predicate ? predicate(sample.labels) : true
  );
  if (matching.length === 0) return null;
  return matching.reduce((sum, sample) => sum + sample.value, 0);
}

/**
 * How many distinct values of `label` appear across `name`'s series — the
 * cardinality of a Traefik dimension (services, routers). `null` when the
 * family is absent, so an unconfigured router reads as "unknown", not "zero".
 */
function distinctLabelCount(
  samples: readonly PromSample[],
  name: string,
  label: string,
): number | null {
  const values = new Set<string>();
  let sawFamily = false;
  for (const sample of samplesNamed(samples, name)) {
    sawFamily = true;
    const value = sample.labels[label];
    if (value !== undefined) values.add(value);
  }
  if (!sawFamily) return null;
  return values.size;
}

/**
 * A cumulative counter's per-interval delta, or `null` (with the baseline
 * key invalidated) when the family is absent this tick. Invalidating rather
 * than diffing against a stale baseline is what keeps a later readable tick
 * from reporting one enormous catch-up delta across the gap.
 */
function counterDeltaOrNull(
  samples: readonly PromSample[],
  ctx: RouterReadContext,
  key: string,
  name: string,
  predicate?: (labels: Record<string, string>) => boolean,
): number | null {
  if (samplesNamed(samples, name).length === 0) {
    ctx.tracker.invalidate(key);
    return null;
  }
  return ctx.tracker.delta(
    key,
    sumSamples(samples, name, predicate),
    ctx.bootGeneration,
  );
}

/** Pure parser — exported for fixture tests. */
export function parseTraefikRouterExposition(
  samples: readonly PromSample[],
  ctx: RouterReadContext,
): RouterReading {
  const serverUpSamples = samplesNamed(samples, "traefik_service_server_up");
  // `traefik_service_server_up` is one gauge per (service, backend URL), 1 when
  // that backend is healthy. Summing gives "how many are up"; counting the
  // series gives "how many exist".
  const backendsUp = serverUpSamples.length === 0
    ? null
    : serverUpSamples.reduce((sum, sample) => sum + sample.value, 0);
  const backendsTotal = serverUpSamples.length === 0
    ? null
    : serverUpSamples.length;

  const servicesTotal = distinctLabelCount(
    samples,
    "traefik_service_server_up",
    "service",
  );
  // Requires `--metrics.prometheus.addRoutersLabels=true` (Traefik defaults it
  // off) — `src/deploy/ingress.ts` passes it.
  const routersTotal = distinctLabelCount(
    samples,
    "traefik_router_requests_total",
    "router",
  );

  const retries = counterDeltaOrNull(
    samples,
    ctx,
    "router:traefik:retries",
    "traefik_service_retries_total",
  );

  const backendRequests = counterDeltaOrNull(
    samples,
    ctx,
    "router:traefik:backendRequests",
    "traefik_service_requests_total",
  );
  const backendErrors5xx = counterDeltaOrNull(
    samples,
    ctx,
    "router:traefik:backendErrors5xx",
    "traefik_service_requests_total",
    (labels) => labels.code?.startsWith("5") ?? false,
  );

  // Mean backend latency for the interval: the histogram's `_sum` delta over
  // its `_count` delta. Both are read from the same scrape, so a counter reset
  // nulls one and therefore the ratio, never producing a half-reset figure.
  const backendDurationSumDelta = counterDeltaOrNull(
    samples,
    ctx,
    "router:traefik:backendDurationSum",
    "traefik_service_request_duration_seconds_sum",
  );
  const backendDurationCountDelta = counterDeltaOrNull(
    samples,
    ctx,
    "router:traefik:backendDurationCount",
    "traefik_service_request_duration_seconds_count",
  );
  const backendLatencyMsAvg =
    backendDurationSumDelta === null || backendDurationCountDelta === null ||
      backendDurationCountDelta === 0
      ? null
      : (backendDurationSumDelta / backendDurationCountDelta) * 1000;

  // Traefik v3 replaced v2's per-scope `traefik_entrypoint_open_connections` /
  // `traefik_service_open_connections` gauges with one
  // `traefik_open_connections{entrypoint,protocol}` gauge — the v2 names are
  // simply absent from a v3 exposition. Summed across `protocol`: this router
  // only carries HTTP/HTTPS, so every customer entrypoint row is hosted
  // traffic.
  const httpOpenConnections = gaugeSumOrNull(
    samples,
    "traefik_open_connections",
    isCustomerEntrypoint,
  );

  const configReloads = counterDeltaOrNull(
    samples,
    ctx,
    "router:traefik:configReloads",
    "traefik_config_reloads_total",
  );

  // `traefik_config_last_reload_success` is a Unix-timestamp gauge (seconds),
  // not a duration — the age is only meaningful against the collector's own
  // clock. A zero value means "never reloaded successfully", which is not an
  // age at all; a negative age means the router's clock is ahead of ours.
  // Both read as "no answer" rather than a fabricated number.
  const lastReloadUnix = gaugeSumOrNull(
    samples,
    "traefik_config_last_reload_success",
  );
  const nowSeconds = ctx.nowMs / 1000;
  const configLastReloadAgeSeconds =
    lastReloadUnix === null || lastReloadUnix <= 0
      ? null
      : Math.max(0, nowSeconds - lastReloadUnix);

  // `traefik_tls_certs_not_after` is one Unix-timestamp gauge per certificate.
  // The *soonest* expiry is the operational signal — one cert about to lapse
  // matters regardless of how healthy the others are — so this is a min, not a
  // sum or a mean. An already-expired cert floors at 0 rather than going
  // negative, matching the field's non-negative descriptor range.
  const certSamples = samplesNamed(samples, "traefik_tls_certs_not_after");
  let tlsCertSoonestExpiryDays: number | null = null;
  if (certSamples.length > 0) {
    const soonestUnix = Math.min(...certSamples.map((sample) => sample.value));
    tlsCertSoonestExpiryDays = Math.max(
      0,
      (soonestUnix - nowSeconds) / SECONDS_PER_DAY,
    );
  }

  const reading: RouterReading = {
    backendsUp,
    backendsTotal,
    servicesTotal,
    routersTotal,
    retries,
    backendErrors5xx,
    backendLatencyMsAvg,
    backendRequests,
    httpOpenConnections,
    configReloads,
    configLastReloadAgeSeconds,
    tlsCertSoonestExpiryDays,
  };
  return reading;
}

export class TraefikRouterAdapter implements RouterAdapter {
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

  async read(ctx: RouterReadContext): Promise<RouterReading | null> {
    const samples = await this.#scrape();
    if (!samples) return null;
    try {
      return parseTraefikRouterExposition(samples, ctx);
    } catch {
      return null;
    }
  }
}
