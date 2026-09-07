import { assertEquals } from "@std/assert";
import { CounterBaselineTracker } from "../baseline.ts";
import { parsePrometheusExposition } from "../proxy/prom-exposition.ts";
import { CaddyIngressAdapter, parseCaddyExpositionV5 } from "./caddy-v5.ts";
import type { IngressReadContext } from "./adapter.ts";

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

function ctx(overrides: Partial<IngressReadContext> = {}): IngressReadContext {
  return {
    tracker: new CounterBaselineTracker(),
    bootGeneration: 1,
    seconds: 60,
    ...overrides,
  };
}

test("parseCaddyExpositionV5: single-handler group computes every rate/avg/bucket field from a primed baseline", () => {
  const tracker = new CounterBaselineTracker();
  const partial = parsePrometheusExposition(
    fixture("proxy-caddy-metrics-v5-partial.txt"),
  );
  parseCaddyExpositionV5(partial, ctx({ tracker })); // prime baseline at 0

  const samples = parsePrometheusExposition(
    fixture("proxy-caddy-metrics-v5-base.txt"),
  );
  const reading = parseCaddyExpositionV5(samples, ctx({ tracker }));

  assertEquals(reading.requests, 100);
  assertEquals(reading.responses2xx, 90);
  assertEquals(reading.responses4xx, 10);
  assertEquals(reading.responses3xx, 0);
  assertEquals(reading.responses5xx, 0);
  assertEquals(reading.requestBytes, 45000 + 2000);
  assertEquals(reading.responseBytes, 500000 + 4000);
  // (9.0 + 1.0) seconds of cumulative duration over (90 + 10) requests = 0.1s avg.
  assertEquals(reading.requestDurationSecondsAvg, 0.1);
  assertEquals(reading.requestsUnder100ms, 60 + 8);
  assertEquals(reading.requestsUnder500ms, 85 + 10);
  assertEquals(reading.requestsUnder1s, 88 + 10);
  assertEquals(reading.requestsUnder5s, 90 + 10);
  assertEquals(reading.requestsInFlight, 3);
  assertEquals(reading.upstreamsHealthy, null);
  assertEquals(reading.upstreamsTotal, null);
  assertEquals(reading.retries, null);
  assertEquals(reading.requestErrors, null);
});

test("parseCaddyExpositionV5: two handler groups fully duplicating the same requests collapse to one authoritative scope, never double-counted", () => {
  const tracker = new CounterBaselineTracker();
  const partial = parsePrometheusExposition(
    fixture("proxy-caddy-metrics-v5-partial.txt"),
  );
  parseCaddyExpositionV5(partial, ctx({ tracker }));

  const samples = parsePrometheusExposition(
    fixture("proxy-caddy-metrics-multi-handler.txt"),
  );
  const reading = parseCaddyExpositionV5(samples, ctx({ tracker }));

  // "subroute" and "reverse_proxy" both wrap the same 100 requests — tied at
  // the max, so the scope resolves to exactly one of them (never both, and
  // never neither), and nothing is doubled.
  assertEquals(reading.requests, 100);
  assertEquals(reading.responses2xx, 100);
  assertEquals(reading.requestBytes, 40000);
  assertEquals(reading.responseBytes, 400000);
  assertEquals(reading.requestDurationSecondsAvg, 0.1);
  assertEquals(reading.requestsUnder100ms, 100);
  // Not 4 — only the chosen handler's in-flight gauge is counted.
  assertEquals(reading.requestsInFlight, 2);
});

test("parseCaddyExpositionV5: legitimate split-handler traffic under a shared top-level wrapper is fully aggregated, not zeroed", () => {
  // "subroute" is the top-level wrapper every request passes through; it
  // then splits traffic between "file_server" (60) and "reverse_proxy" (40).
  // Neither inner handler alone matches the server total, but "subroute" —
  // the max — does, so it is the authoritative scope.
  const exposition = `
# HELP caddy_http_requests_in_flight Number of requests currently handled by this server.
# TYPE caddy_http_requests_in_flight gauge
caddy_http_requests_in_flight{handler="subroute",server="srv0"} 4
caddy_http_requests_in_flight{handler="file_server",server="srv0"} 3
caddy_http_requests_in_flight{handler="reverse_proxy",server="srv0"} 1
# HELP caddy_http_requests_total Counter of HTTP(S) requests made.
# TYPE caddy_http_requests_total counter
caddy_http_requests_total{handler="subroute",server="srv0"} 100
caddy_http_requests_total{handler="file_server",server="srv0"} 60
caddy_http_requests_total{handler="reverse_proxy",server="srv0"} 40
# HELP caddy_http_request_duration_seconds Histogram of round-trip request durations.
# TYPE caddy_http_request_duration_seconds histogram
caddy_http_request_duration_seconds_bucket{code="200",handler="subroute",method="GET",server="srv0",le="0.1"} 100
caddy_http_request_duration_seconds_bucket{code="200",handler="subroute",method="GET",server="srv0",le="+Inf"} 100
caddy_http_request_duration_seconds_sum{code="200",handler="subroute",method="GET",server="srv0"} 10.0
caddy_http_request_duration_seconds_count{code="200",handler="subroute",method="GET",server="srv0"} 100
caddy_http_request_duration_seconds_bucket{code="200",handler="file_server",method="GET",server="srv0",le="0.1"} 60
caddy_http_request_duration_seconds_bucket{code="200",handler="file_server",method="GET",server="srv0",le="+Inf"} 60
caddy_http_request_duration_seconds_sum{code="200",handler="file_server",method="GET",server="srv0"} 3.0
caddy_http_request_duration_seconds_count{code="200",handler="file_server",method="GET",server="srv0"} 60
caddy_http_request_duration_seconds_bucket{code="200",handler="reverse_proxy",method="GET",server="srv0",le="0.1"} 40
caddy_http_request_duration_seconds_bucket{code="200",handler="reverse_proxy",method="GET",server="srv0",le="+Inf"} 40
caddy_http_request_duration_seconds_sum{code="200",handler="reverse_proxy",method="GET",server="srv0"} 7.0
caddy_http_request_duration_seconds_count{code="200",handler="reverse_proxy",method="GET",server="srv0"} 40
# HELP caddy_http_request_size_bytes Total size of the request. Includes body
# TYPE caddy_http_request_size_bytes histogram
caddy_http_request_size_bytes_sum{code="200",handler="subroute",method="GET",server="srv0"} 50000
caddy_http_request_size_bytes_sum{code="200",handler="file_server",method="GET",server="srv0"} 30000
caddy_http_request_size_bytes_sum{code="200",handler="reverse_proxy",method="GET",server="srv0"} 20000
# HELP caddy_http_response_size_bytes Size of the returned response.
# TYPE caddy_http_response_size_bytes histogram
caddy_http_response_size_bytes_sum{code="200",handler="subroute",method="GET",server="srv0"} 600000
caddy_http_response_size_bytes_sum{code="200",handler="file_server",method="GET",server="srv0"} 350000
caddy_http_response_size_bytes_sum{code="200",handler="reverse_proxy",method="GET",server="srv0"} 250000
`;

  const tracker = new CounterBaselineTracker();
  parseCaddyExpositionV5(parsePrometheusExposition(""), ctx({ tracker }));
  const reading = parseCaddyExpositionV5(
    parsePrometheusExposition(exposition),
    ctx({ tracker }),
  );

  assertEquals(reading.requests, 100);
  assertEquals(reading.responses2xx, 100);
  assertEquals(reading.requestBytes, 50000);
  assertEquals(reading.responseBytes, 600000);
  assertEquals(reading.requestDurationSecondsAvg, 0.1);
  assertEquals(reading.requestsUnder100ms, 100);
  assertEquals(reading.requestsInFlight, 4);
});

test("parseCaddyExpositionV5: a single HTTP request through duplicated handler labels increments the normalized rate exactly once", () => {
  const duplicatedHandlerExposition = (n: number) => `
# HELP caddy_http_requests_total Counter of HTTP(S) requests made.
# TYPE caddy_http_requests_total counter
caddy_http_requests_total{handler="subroute",server="srv0"} ${n}
caddy_http_requests_total{handler="reverse_proxy",server="srv0"} ${n}
`;

  const tracker = new CounterBaselineTracker();
  parseCaddyExpositionV5(
    parsePrometheusExposition(duplicatedHandlerExposition(100)),
    ctx({ tracker }),
  ); // prime baseline

  // Exactly one real HTTP request served — both duplicated handler labels
  // advance by 1, not 2.
  const reading = parseCaddyExpositionV5(
    parsePrometheusExposition(duplicatedHandlerExposition(101)),
    ctx({ tracker, seconds: 60 }),
  );
  assertEquals(reading.requests, 1);
});

test("parseCaddyExpositionV5: reverse-proxy upstream health gauges", () => {
  const samples = parsePrometheusExposition(
    fixture("proxy-caddy-metrics-v5-reverse-proxy.txt"),
  );
  const reading = parseCaddyExpositionV5(samples, ctx());
  assertEquals(reading.upstreamsHealthy, 1);
  assertEquals(reading.upstreamsTotal, 2);
});

test("parseCaddyExpositionV5: a freshly-started Caddy nulls every rate/avg field on the first observation, gauges resolve to real numbers", () => {
  const samples = parsePrometheusExposition(
    fixture("proxy-caddy-metrics-v5-partial.txt"),
  );
  const reading = parseCaddyExpositionV5(samples, ctx());
  assertEquals(reading.requests, null);
  assertEquals(reading.responses2xx, null);
  assertEquals(reading.responses3xx, null);
  assertEquals(reading.responses4xx, null);
  assertEquals(reading.responses5xx, null);
  assertEquals(reading.requestBytes, null);
  assertEquals(reading.responseBytes, null);
  assertEquals(reading.requestDurationSecondsAvg, null);
  assertEquals(reading.requestsUnder100ms, null);
  assertEquals(reading.requestsUnder500ms, null);
  assertEquals(reading.requestsUnder1s, null);
  assertEquals(reading.requestsUnder5s, null);
  assertEquals(reading.requestsInFlight, 0);
  assertEquals(reading.upstreamsHealthy, null);
  assertEquals(reading.upstreamsTotal, null);
});

const RESETTABLE_EXPOSITION = (requestsTotal: number) => `
# HELP caddy_http_requests_total Counter of HTTP(S) requests made.
# TYPE caddy_http_requests_total counter
caddy_http_requests_total{handler="subroute",server="srv0"} ${requestsTotal}
`;

test("parseCaddyExpositionV5: a counter decrease (sidecar restart) nulls that field and re-baselines", () => {
  const tracker = new CounterBaselineTracker();
  const first = parseCaddyExpositionV5(
    parsePrometheusExposition(RESETTABLE_EXPOSITION(100)),
    ctx({ tracker, bootGeneration: 1 }),
  );
  assertEquals(first.requests, null); // first observation

  const second = parseCaddyExpositionV5(
    parsePrometheusExposition(RESETTABLE_EXPOSITION(160)),
    ctx({ tracker, bootGeneration: 1 }),
  );
  assertEquals(second.requests, 60);

  // Sidecar restarted: cumulative counter dropped back down.
  const third = parseCaddyExpositionV5(
    parsePrometheusExposition(RESETTABLE_EXPOSITION(10)),
    ctx({ tracker, bootGeneration: 1 }),
  );
  assertEquals(third.requests, null);

  const fourth = parseCaddyExpositionV5(
    parsePrometheusExposition(RESETTABLE_EXPOSITION(25)),
    ctx({ tracker, bootGeneration: 1 }),
  );
  assertEquals(fourth.requests, 15);
});

test("parseCaddyExpositionV5: a boot generation change nulls the counter and re-baselines", () => {
  const tracker = new CounterBaselineTracker();
  parseCaddyExpositionV5(
    parsePrometheusExposition(RESETTABLE_EXPOSITION(100)),
    ctx({ tracker, bootGeneration: 1 }),
  );
  parseCaddyExpositionV5(
    parsePrometheusExposition(RESETTABLE_EXPOSITION(160)),
    ctx({ tracker, bootGeneration: 1 }),
  );

  const afterReboot = parseCaddyExpositionV5(
    parsePrometheusExposition(RESETTABLE_EXPOSITION(5)),
    ctx({ tracker, bootGeneration: 2 }),
  );
  assertEquals(afterReboot.requests, null);

  const nextTick = parseCaddyExpositionV5(
    parsePrometheusExposition(RESETTABLE_EXPOSITION(65)),
    ctx({ tracker, bootGeneration: 2 }),
  );
  assertEquals(nextTick.requests, 60);
});

test("CaddyIngressAdapter.read returns null when the endpoint is unreachable", async () => {
  const adapter = new CaddyIngressAdapter({
    fetchText: () => Promise.resolve(undefined),
  });
  const result = await adapter.read(ctx());
  assertEquals(result, null);
});

test("CaddyIngressAdapter.read returns null when the body has none of the expected metric names", async () => {
  const adapter = new CaddyIngressAdapter({
    fetchText: () => Promise.resolve("some_unrelated_metric 1\n"),
  });
  const result = await adapter.read(ctx());
  assertEquals(result, null);
});

test("CaddyIngressAdapter.read succeeds on a valid scrape", async () => {
  const adapter = new CaddyIngressAdapter({
    fetchText: () =>
      Promise.resolve(fixture("proxy-caddy-metrics-v5-base.txt")),
  });
  const result = await adapter.read(ctx());
  assertEquals(result?.sourceId, "caddy");
  assertEquals(result?.sourceKind, "caddy");
  assertEquals(result?.reading.requestsInFlight, 3);
});
