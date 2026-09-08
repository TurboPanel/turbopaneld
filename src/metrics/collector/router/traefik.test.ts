import { assertEquals } from "@std/assert";
import { CounterBaselineTracker } from "../baseline.ts";
import { parsePrometheusExposition } from "../proxy/prom-exposition.ts";
import {
  parseTraefikRouterExposition,
  TraefikRouterAdapter,
} from "./traefik.ts";
import type { RouterReadContext } from "./adapter.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/**
 * The fixtures' `traefik_config_last_reload_success` is 1.7671e9 and their
 * soonest `traefik_tls_certs_not_after` is 1.7692e9, so pinning "now" here
 * makes the two clock-relative fields exactly checkable.
 */
const NOW_MS = 1_767_200_000_000;

function fixture(name: string): string {
  return Deno.readTextFileSync(
    new URL(`../testdata/${name}`, import.meta.url),
  );
}

function ctx(overrides: Partial<RouterReadContext> = {}): RouterReadContext {
  return {
    tracker: new CounterBaselineTracker(),
    bootGeneration: 1,
    seconds: 60,
    nowMs: NOW_MS,
    ...overrides,
  };
}

test("parseTraefikRouterExposition resolves every field from a primed baseline", () => {
  const tracker = new CounterBaselineTracker();
  // Prime every counter baseline against the freshly-started fixture, so the
  // deltas below are real per-interval figures rather than first observations.
  parseTraefikRouterExposition(
    parsePrometheusExposition(
      fixture("proxy-router-traefik-metrics-partial.txt"),
    ),
    ctx({ tracker }),
  );

  const reading = parseTraefikRouterExposition(
    parsePrometheusExposition(fixture("proxy-router-traefik-metrics.txt")),
    ctx({ tracker }),
  );

  // Three `traefik_service_server_up` series across two services, one down.
  assertEquals(reading.backendsUp, 2);
  assertEquals(reading.backendsTotal, 3);
  assertEquals(reading.servicesTotal, 2);
  // Two distinct `router` label values on `traefik_router_requests_total`.
  assertEquals(reading.routersTotal, 2);

  // The partial fixture has no service/router series at all, so these are
  // each their series' first observation — null, not a fabricated delta over
  // an unknown backlog.
  assertEquals(reading.retries, null);
  assertEquals(reading.backendRequests, null);
  assertEquals(reading.backendErrors5xx, null);
  assertEquals(reading.backendLatencyMsAvg, null);

  // `traefik_config_reloads_total` went 1 -> 12 across the two scrapes.
  assertEquals(reading.configReloads, 11);
  // 2 TCP + 1 UDP on "web"; the 9 on the "metrics" entrypoint are the
  // collector's own scrapes and never count.
  assertEquals(reading.httpOpenConnections, 3);
  assertEquals(reading.configLastReloadAgeSeconds, NOW_MS / 1000 - 1.7671e9);
  // Soonest of the two certs (1.7692e9), in days from now.
  assertEquals(
    reading.tlsCertSoonestExpiryDays,
    (1.7692e9 - NOW_MS / 1000) / 86_400,
  );
});

test("parseTraefikRouterExposition resolves service-derived deltas on a second identical scrape", () => {
  const tracker = new CounterBaselineTracker();
  const samples = parsePrometheusExposition(
    fixture("proxy-router-traefik-metrics.txt"),
  );
  // First appearance establishes the baseline (every counter null).
  parseTraefikRouterExposition(samples, ctx({ tracker }));

  const incremented = parsePrometheusExposition(
    fixture("proxy-router-traefik-metrics.txt")
      .replace(
        'traefik_service_retries_total{service="hosting-svc@docker"} 4',
        'traefik_service_retries_total{service="hosting-svc@docker"} 9',
      )
      .replace(
        'traefik_service_requests_total{code="200",method="GET",protocol="http",service="hosting-svc@docker"} 80',
        'traefik_service_requests_total{code="200",method="GET",protocol="http",service="hosting-svc@docker"} 100',
      )
      .replace(
        'traefik_service_requests_total{code="503",method="GET",protocol="http",service="hosting-svc@docker"} 5',
        'traefik_service_requests_total{code="503",method="GET",protocol="http",service="hosting-svc@docker"} 8',
      )
      .replace(
        'traefik_service_request_duration_seconds_sum{code="200",method="GET",protocol="http",service="hosting-svc@docker"} 8.0',
        'traefik_service_request_duration_seconds_sum{code="200",method="GET",protocol="http",service="hosting-svc@docker"} 10.0',
      )
      .replace(
        'traefik_service_request_duration_seconds_count{code="200",method="GET",protocol="http",service="hosting-svc@docker"} 80',
        'traefik_service_request_duration_seconds_count{code="200",method="GET",protocol="http",service="hosting-svc@docker"} 100',
      ),
  );
  const reading = parseTraefikRouterExposition(incremented, ctx({ tracker }));

  assertEquals(reading.retries, 5);
  // 5xx only: 8 - 5. The 200s and the other service never contribute.
  assertEquals(reading.backendErrors5xx, 3);
  // Every code/service summed: (100 + 8 + 15) - (80 + 5 + 15).
  assertEquals(reading.backendRequests, 23);
  // Duration sum delta 2.0s over count delta 20 requests = 100ms mean.
  assertEquals(reading.backendLatencyMsAvg, 100);
});

test("parseTraefikRouterExposition: a freshly-started router nulls every service/router-derived field", () => {
  const reading = parseTraefikRouterExposition(
    parsePrometheusExposition(
      fixture("proxy-router-traefik-metrics-partial.txt"),
    ),
    ctx(),
  );

  // No `traefik_service_*` / `traefik_router_*` series exist at all — "no
  // services configured" must never read as "0 backends up".
  assertEquals(reading.backendsUp, null);
  assertEquals(reading.backendsTotal, null);
  assertEquals(reading.servicesTotal, null);
  assertEquals(reading.routersTotal, null);
  assertEquals(reading.retries, null);
  assertEquals(reading.backendRequests, null);
  assertEquals(reading.backendErrors5xx, null);
  assertEquals(reading.backendLatencyMsAvg, null);
  // No `traefik_open_connections` and no certificates in this fixture.
  assertEquals(reading.httpOpenConnections, null);
  assertEquals(reading.tlsCertSoonestExpiryDays, null);
  // First observation of the reloads counter.
  assertEquals(reading.configReloads, null);
  // `traefik_config_last_reload_success` is 0 — "never reloaded
  // successfully", which is not an age.
  assertEquals(reading.configLastReloadAgeSeconds, null);
});

test("parseTraefikRouterExposition: routersTotal stays null when addRoutersLabels is off", () => {
  // Traefik defaults `--metrics.prometheus.addRoutersLabels` to false, in
  // which case `traefik_router_*` is simply absent. That must degrade the one
  // field derived from it, not the whole reading.
  const withoutRouterSeries = fixture("proxy-router-traefik-metrics.txt")
    .split("\n")
    .filter((line) => !line.startsWith("traefik_router_"))
    .join("\n");
  const reading = parseTraefikRouterExposition(
    parsePrometheusExposition(withoutRouterSeries),
    ctx(),
  );
  assertEquals(reading.routersTotal, null);
  assertEquals(reading.servicesTotal, 2);
  assertEquals(reading.backendsTotal, 3);
});

test("parseTraefikRouterExposition: an already-expired certificate floors at zero days rather than going negative", () => {
  const expired = fixture("proxy-router-traefik-metrics.txt").replace(
    'traefik_tls_certs_not_after{cn="b.example.com",sans="b.example.com",serial="02"} 1.7692e+09',
    'traefik_tls_certs_not_after{cn="b.example.com",sans="b.example.com",serial="02"} 1.0e+09',
  );
  const reading = parseTraefikRouterExposition(
    parsePrometheusExposition(expired),
    ctx(),
  );
  assertEquals(reading.tlsCertSoonestExpiryDays, 0);
});

const RESETTABLE_EXPOSITION = (reloads: number) => `
# HELP traefik_config_reloads_total reloads
# TYPE traefik_config_reloads_total counter
traefik_config_reloads_total ${reloads}
# HELP traefik_config_last_reload_success last reload
# TYPE traefik_config_last_reload_success gauge
traefik_config_last_reload_success 1.7671e+09
`;

test("parseTraefikRouterExposition: a counter decrease (router restart) nulls that field and re-baselines", () => {
  const tracker = new CounterBaselineTracker();
  const first = parseTraefikRouterExposition(
    parsePrometheusExposition(RESETTABLE_EXPOSITION(100)),
    ctx({ tracker }),
  );
  assertEquals(first.configReloads, null);

  const second = parseTraefikRouterExposition(
    parsePrometheusExposition(RESETTABLE_EXPOSITION(160)),
    ctx({ tracker }),
  );
  assertEquals(second.configReloads, 60);

  const third = parseTraefikRouterExposition(
    parsePrometheusExposition(RESETTABLE_EXPOSITION(10)),
    ctx({ tracker }),
  );
  assertEquals(third.configReloads, null);
});

test("parseTraefikRouterExposition: a boot generation change nulls the counter and re-baselines", () => {
  const tracker = new CounterBaselineTracker();
  parseTraefikRouterExposition(
    parsePrometheusExposition(RESETTABLE_EXPOSITION(100)),
    ctx({ tracker, bootGeneration: 1 }),
  );
  parseTraefikRouterExposition(
    parsePrometheusExposition(RESETTABLE_EXPOSITION(160)),
    ctx({ tracker, bootGeneration: 1 }),
  );
  const afterRestart = parseTraefikRouterExposition(
    parsePrometheusExposition(RESETTABLE_EXPOSITION(5)),
    ctx({ tracker, bootGeneration: 2 }),
  );
  assertEquals(afterRestart.configReloads, null);
});

test("parseTraefikRouterExposition: a service that disappears re-origins instead of leaving a stale baseline", () => {
  const tracker = new CounterBaselineTracker();
  const full = parsePrometheusExposition(
    fixture("proxy-router-traefik-metrics.txt"),
  );
  // First appearance establishes the baseline (4 retries), itself null.
  parseTraefikRouterExposition(full, ctx({ tracker }));
  // Confirms the baseline is live: a real, non-null delta on the next tick.
  assertEquals(
    parseTraefikRouterExposition(full, ctx({ tracker })).retries,
    0,
  );

  // The service (and its retries series) disappears on a later tick.
  assertEquals(
    parseTraefikRouterExposition(
      parsePrometheusExposition(
        fixture("proxy-router-traefik-metrics-partial.txt"),
      ),
      ctx({ tracker }),
    ).retries,
    null,
  );

  // The service returns with a much higher cumulative retry count. If the
  // stale pre-gap baseline (4) had survived, this would fabricate a huge
  // spike; the invalidated baseline forces a fresh first observation instead.
  const serviceReturns = parseTraefikRouterExposition(
    parsePrometheusExposition(
      fixture("proxy-router-traefik-metrics.txt").replace(
        'traefik_service_retries_total{service="hosting-svc@docker"} 4',
        'traefik_service_retries_total{service="hosting-svc@docker"} 9000',
      ),
    ),
    ctx({ tracker }),
  );
  assertEquals(serviceReturns.retries, null);
});

test("TraefikRouterAdapter.read returns null when the endpoint is unreachable", async () => {
  const adapter = new TraefikRouterAdapter({
    fetchText: () => Promise.resolve(undefined),
  });
  assertEquals(await adapter.read(ctx()), null);
});

test("TraefikRouterAdapter.read returns null when the body has none of the expected metric names", async () => {
  const adapter = new TraefikRouterAdapter({
    fetchText: () => Promise.resolve("some_unrelated_metric 1\n"),
  });
  assertEquals(await adapter.read(ctx()), null);
});

test("TraefikRouterAdapter.read succeeds on a valid scrape", async () => {
  const adapter = new TraefikRouterAdapter({
    fetchText: () =>
      Promise.resolve(fixture("proxy-router-traefik-metrics.txt")),
  });
  const reading = await adapter.read(ctx());
  assertEquals(reading?.httpOpenConnections, 3);
  assertEquals(reading?.backendsUp, 2);
});
