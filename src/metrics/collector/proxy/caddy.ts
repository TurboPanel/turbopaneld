/**
 * Site Caddy traffic scrape (`orchestration/roles/site-caddy` — the
 * unprivileged per-site Caddy, not the hosting Caddy in `src/deploy/ingress.ts`
 * nor the control-plane Caddy). That role's `Caddyfile.j2` sets the global
 * `metrics` option, which is what actually exposes Prometheus text at
 * `/metrics` on the admin listener (`servers { metrics }` alone only turns on
 * per-server instrumentation and leaves `/metrics` 404); there is no
 * supported way to bind a *second* admin API for just metrics, so this reads
 * the same loopback admin address the role already reserves
 * (`site_caddy_admin_addr`, mirrored here as a constant the same way
 * `HOSTING_CADDY_ADMIN_ADDR` mirrors the hosting Caddy's in
 * `src/deploy/ingress.ts`).
 *
 * Caddy's `caddy_http_requests_total` counter carries no `code` label (see
 * `modules/caddyhttp/metrics.go` in the Caddy source) — only the
 * `caddy_http_request_duration_seconds` histogram is labeled by `code`, so
 * the 2xx/3xx/4xx/5xx breakdown is derived from that histogram's `_count`
 * series instead.
 */
import type { CaddyCounters } from "../types.ts";
import {
  containsAnyMetricName,
  fetchLoopbackText,
  parsePrometheusExposition,
  sumSamples,
} from "./prom-exposition.ts";

/** Mirrors `orchestration/roles/site-caddy/defaults/main.yml` `site_caddy_admin_addr`. */
export const SITE_CADDY_ADMIN_ADDR = "127.0.0.1:2039";

/**
 * Every metric name `parseCaddyExposition` reads. A body containing none of
 * these is not a Caddy `/metrics` response — an empty body, a misconfigured
 * endpoint (the global `metrics` option unset, see `Caddyfile.j2`), or the
 * wrong loopback service answering on `SITE_CADDY_ADMIN_ADDR` all look the
 * same otherwise: a 200 that `parseCaddyExposition` would happily reduce to
 * an all-zero snapshot instead of surfacing as a failed scrape.
 */
const CADDY_EXPECTED_METRIC_NAMES = [
  "caddy_http_requests_total",
  "caddy_http_request_duration_seconds_count",
  "caddy_http_request_duration_seconds_sum",
  "caddy_http_request_duration_seconds_bucket",
  "caddy_http_request_size_bytes_sum",
  "caddy_http_response_size_bytes_sum",
  "caddy_http_requests_in_flight",
] as const;

function classSum(
  samples: ReturnType<typeof parsePrometheusExposition>,
  digit: "2" | "3" | "4" | "5",
): number {
  return sumSamples(
    samples,
    "caddy_http_request_duration_seconds_count",
    (labels) => labels.code?.startsWith(digit) ?? false,
  );
}

/** Pure parser — exported for fixture tests. */
export function parseCaddyExposition(text: string): CaddyCounters {
  const samples = parsePrometheusExposition(text);
  return {
    requestsTotal: sumSamples(samples, "caddy_http_requests_total"),
    responses2xxTotal: classSum(samples, "2"),
    responses3xxTotal: classSum(samples, "3"),
    responses4xxTotal: classSum(samples, "4"),
    responses5xxTotal: classSum(samples, "5"),
    requestBytesTotal: sumSamples(
      samples,
      "caddy_http_request_size_bytes_sum",
    ),
    responseBytesTotal: sumSamples(
      samples,
      "caddy_http_response_size_bytes_sum",
    ),
    requestDurationSecondsSum: sumSamples(
      samples,
      "caddy_http_request_duration_seconds_sum",
    ),
    requestsUnder100msTotal: sumSamples(
      samples,
      "caddy_http_request_duration_seconds_bucket",
      (labels) => labels.le === "0.1",
    ),
    requestsUnder1sTotal: sumSamples(
      samples,
      "caddy_http_request_duration_seconds_bucket",
      (labels) => labels.le === "1",
    ),
    requestsInFlight: sumSamples(samples, "caddy_http_requests_in_flight"),
  };
}

/**
 * One scrape of the site Caddy's `/metrics`; `null` on any failure —
 * unreachable, no expected metric present (see
 * {@link CADDY_EXPECTED_METRIC_NAMES}), or a parse throw.
 */
export async function readCaddyMetrics(
  adminAddr: string = SITE_CADDY_ADMIN_ADDR,
): Promise<CaddyCounters | null> {
  const text = await fetchLoopbackText(adminAddr, "/metrics");
  if (text === undefined) return null;
  const samples = parsePrometheusExposition(text);
  if (!containsAnyMetricName(samples, CADDY_EXPECTED_METRIC_NAMES)) {
    return null;
  }
  try {
    return parseCaddyExposition(text);
  } catch {
    return null;
  }
}
