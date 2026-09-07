import { assertEquals } from "@std/assert";
import { CounterBaselineTracker } from "../baseline.ts";
import { parsePrometheusExposition } from "../proxy/prom-exposition.ts";
import { parseTraefikExposition, TraefikIngressAdapter } from "./traefik.ts";
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

test("parseTraefikExposition computes every rate/avg/bucket-boundary field from a primed baseline", () => {
  const tracker = new CounterBaselineTracker();
  const partial = parsePrometheusExposition(
    fixture("proxy-traefik-metrics-partial.txt"),
  );
  parseTraefikExposition(partial, ctx({ tracker })); // prime baseline at 0

  const samples = parsePrometheusExposition(
    fixture("proxy-traefik-metrics.txt"),
  );
  const reading = parseTraefikExposition(samples, ctx({ tracker }));

  assertEquals(reading.requests, 100);
  assertEquals(reading.responses2xx, 90);
  assertEquals(reading.responses4xx, 10);
  assertEquals(reading.responses3xx, 0);
  assertEquals(reading.responses5xx, 0);
  assertEquals(reading.requestBytes, 45000 + 2000);
  assertEquals(reading.responseBytes, 500000 + 4000);
  assertEquals(reading.requestDurationSecondsAvg, 0.1);
  assertEquals(reading.requestsUnder100ms, 60 + 8);
  assertEquals(reading.requestsUnder500ms, 85 + 10);
  assertEquals(reading.requestsUnder1s, 88 + 10);
  assertEquals(reading.requestsUnder5s, 90 + 10);
  assertEquals(reading.requestsInFlight, 3);
  // The partial priming fixture has no retries series at all, so this is
  // that series' first-ever observation — null, not a fabricated rate over
  // an unknown backlog (see the dedicated retries tests below).
  assertEquals(reading.retries, null);
  assertEquals(reading.upstreamsHealthy, 1);
  assertEquals(reading.upstreamsTotal, 2);
  // No Traefik equivalent distinct from the 5xx response class.
  assertEquals(reading.requestErrors, null);
});

test("parseTraefikExposition: self-scrapes of the dedicated 'metrics' entrypoint never count as customer ingress traffic", () => {
  const tracker = new CounterBaselineTracker();
  parseTraefikExposition(
    parsePrometheusExposition(fixture("proxy-traefik-metrics-partial.txt")),
    ctx({ tracker }),
  );

  const samples = parsePrometheusExposition(
    fixture("proxy-traefik-metrics.txt"),
  );
  const reading = parseTraefikExposition(samples, ctx({ tracker }));

  // The fixture's "metrics" entrypoint carries 5000 requests / 900000 request
  // bytes / 7000000 response bytes / 9 open connections — none of that may
  // leak into these customer-facing "web"-entrypoint-only figures.
  assertEquals(reading.requests, 100);
  assertEquals(reading.requestBytes, 45000 + 2000);
  assertEquals(reading.responseBytes, 500000 + 4000);
  assertEquals(reading.requestDurationSecondsAvg, 0.1);
  assertEquals(reading.requestsInFlight, 3);
});

test("parseTraefikExposition: a freshly-started proxy with no services nulls every rate/avg field on the first observation", () => {
  const samples = parsePrometheusExposition(
    fixture("proxy-traefik-metrics-partial.txt"),
  );
  const reading = parseTraefikExposition(samples, ctx());
  assertEquals(reading.requests, null);
  assertEquals(reading.responses2xx, null);
  assertEquals(reading.requestBytes, null);
  assertEquals(reading.responseBytes, null);
  assertEquals(reading.requestDurationSecondsAvg, null);
  assertEquals(reading.requestsUnder100ms, null);
  // No traefik_open_connections series in this fixture at all.
  assertEquals(reading.requestsInFlight, null);
  // No service registered yet — no retries/server-up series at all.
  assertEquals(reading.retries, null);
  assertEquals(reading.upstreamsHealthy, null);
  assertEquals(reading.upstreamsTotal, null);
  assertEquals(reading.requestErrors, null);
});

test("parseTraefikExposition: requestErrors stays null even with real traffic (no Traefik equivalent)", () => {
  const tracker = new CounterBaselineTracker();
  parseTraefikExposition(
    parsePrometheusExposition(fixture("proxy-traefik-metrics-partial.txt")),
    ctx({ tracker }),
  );
  const reading = parseTraefikExposition(
    parsePrometheusExposition(fixture("proxy-traefik-metrics.txt")),
    ctx({ tracker }),
  );
  assertEquals(reading.requestErrors, null);
});

test("parseTraefikExposition: retries nulls on the retries series' first appearance, then resolves a real rate", () => {
  const tracker = new CounterBaselineTracker();
  // No service registered yet — no retries series at all.
  parseTraefikExposition(
    parsePrometheusExposition(fixture("proxy-traefik-metrics-partial.txt")),
    ctx({ tracker }),
  );

  // The retries series appears for the first time — treated as a first
  // observation (the counter's prior accrual is unknown), not a fabricated
  // rate over an unknown backlog.
  const firstSeen = parseTraefikExposition(
    parsePrometheusExposition(fixture("proxy-traefik-metrics.txt")),
    ctx({ tracker }),
  );
  assertEquals(firstSeen.retries, null);

  // Same series, incremented on the next tick — now a real rate.
  const incremented = fixture("proxy-traefik-metrics.txt").replace(
    'traefik_service_retries_total{service="hosting-svc@docker"} 4',
    'traefik_service_retries_total{service="hosting-svc@docker"} 10',
  );
  const reading = parseTraefikExposition(
    parsePrometheusExposition(incremented),
    ctx({ tracker }),
  );
  assertEquals(reading.retries, 6);
});

test("parseTraefikExposition: an absent retries series stays null across two consecutive scrapes, never degrading to a fabricated zero", () => {
  const tracker = new CounterBaselineTracker();
  const noRetriesSamples = parsePrometheusExposition(
    fixture("proxy-traefik-metrics-partial.txt"),
  );

  const first = parseTraefikExposition(noRetriesSamples, ctx({ tracker }));
  assertEquals(first.retries, null);

  const second = parseTraefikExposition(noRetriesSamples, ctx({ tracker }));
  assertEquals(second.retries, null);
});

test("parseTraefikExposition: a retries series that later disappears re-origins instead of leaving a stale baseline", () => {
  const tracker = new CounterBaselineTracker();
  // First appearance of the series — establishes a baseline of 4, itself null.
  parseTraefikExposition(
    parsePrometheusExposition(fixture("proxy-traefik-metrics.txt")),
    ctx({ tracker }),
  );
  // Confirms the baseline is live: a real, non-null rate on the next tick.
  const steady = parseTraefikExposition(
    parsePrometheusExposition(fixture("proxy-traefik-metrics.txt")),
    ctx({ tracker }),
  );
  assertEquals(steady.retries, 0);

  // The service (and its retries series) disappears on a later tick.
  const afterServiceRemoved = parseTraefikExposition(
    parsePrometheusExposition(fixture("proxy-traefik-metrics-partial.txt")),
    ctx({ tracker }),
  );
  assertEquals(afterServiceRemoved.retries, null);

  // The service returns with a much higher cumulative retry count. If the
  // stale pre-gap baseline (4) had survived, this would fabricate a huge
  // spike; instead the invalidated baseline forces a fresh first
  // observation — null, not a spike.
  const serviceReturns = parseTraefikExposition(
    parsePrometheusExposition(
      fixture("proxy-traefik-metrics.txt").replace(
        'traefik_service_retries_total{service="hosting-svc@docker"} 4',
        'traefik_service_retries_total{service="hosting-svc@docker"} 9000',
      ),
    ),
    ctx({ tracker }),
  );
  assertEquals(serviceReturns.retries, null);
});

const RESETTABLE_EXPOSITION = (requestsTotal: number) => `
# HELP traefik_entrypoint_requests_total requests
# TYPE traefik_entrypoint_requests_total counter
traefik_entrypoint_requests_total{code="200",entrypoint="web",method="GET",protocol="http"} ${requestsTotal}
`;

test("parseTraefikExposition: a counter decrease (proxy restart) nulls that field and re-baselines", () => {
  const tracker = new CounterBaselineTracker();
  const first = parseTraefikExposition(
    parsePrometheusExposition(RESETTABLE_EXPOSITION(100)),
    ctx({ tracker, bootGeneration: 1 }),
  );
  assertEquals(first.requests, null);

  const second = parseTraefikExposition(
    parsePrometheusExposition(RESETTABLE_EXPOSITION(160)),
    ctx({ tracker, bootGeneration: 1 }),
  );
  assertEquals(second.requests, 60);

  const third = parseTraefikExposition(
    parsePrometheusExposition(RESETTABLE_EXPOSITION(10)),
    ctx({ tracker, bootGeneration: 1 }),
  );
  assertEquals(third.requests, null);
});

test("parseTraefikExposition: a boot generation change nulls the counter and re-baselines", () => {
  const tracker = new CounterBaselineTracker();
  parseTraefikExposition(
    parsePrometheusExposition(RESETTABLE_EXPOSITION(100)),
    ctx({ tracker, bootGeneration: 1 }),
  );
  parseTraefikExposition(
    parsePrometheusExposition(RESETTABLE_EXPOSITION(160)),
    ctx({ tracker, bootGeneration: 1 }),
  );
  const afterRestart = parseTraefikExposition(
    parsePrometheusExposition(RESETTABLE_EXPOSITION(5)),
    ctx({ tracker, bootGeneration: 2 }),
  );
  assertEquals(afterRestart.requests, null);
});

test("TraefikIngressAdapter.read returns null when the endpoint is unreachable", async () => {
  const adapter = new TraefikIngressAdapter({
    fetchText: () => Promise.resolve(undefined),
  });
  const result = await adapter.read(ctx());
  assertEquals(result, null);
});

test("TraefikIngressAdapter.read returns null when the body has none of the expected metric names", async () => {
  const adapter = new TraefikIngressAdapter({
    fetchText: () => Promise.resolve("some_unrelated_metric 1\n"),
  });
  const result = await adapter.read(ctx());
  assertEquals(result, null);
});

test("TraefikIngressAdapter.read succeeds on a valid scrape", async () => {
  const adapter = new TraefikIngressAdapter({
    fetchText: () => Promise.resolve(fixture("proxy-traefik-metrics.txt")),
  });
  const result = await adapter.read(ctx());
  assertEquals(result?.sourceId, "traefik");
  assertEquals(result?.sourceKind, "traefik");
  assertEquals(result?.reading.requestsInFlight, 3);
});
