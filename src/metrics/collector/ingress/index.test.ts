import { assertEquals } from "@std/assert";
import { CounterBaselineTracker } from "../baseline.ts";
import { parsePrometheusExposition } from "../proxy/prom-exposition.ts";
import { parseCaddyExpositionV5 } from "./caddy-v5.ts";
import { buildIngressSources } from "./index.ts";
import { parseTraefikExposition } from "./traefik.ts";
import type {
  IngressAdapter,
  IngressAdapterSet,
  IngressReadContext,
  IngressReading,
} from "./adapter.ts";

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

function fakeAdapter(
  id: "caddy" | "traefik",
  result:
    | { sourceId: string; sourceKind: string; reading: IngressReading }
    | null,
): IngressAdapter {
  return {
    id,
    probe: () => Promise.resolve(),
    read: () => Promise.resolve(result),
  };
}

function ctx(overrides: Partial<IngressReadContext> = {}) {
  return {
    tracker: new CounterBaselineTracker(),
    bootGeneration: 1,
    seconds: 60,
    ...overrides,
  };
}

const EMPTY_READING: IngressReading = {};

test("buildIngressSources: adapters undefined returns []", async () => {
  const sources = await buildIngressSources(undefined, ctx());
  assertEquals(sources, []);
});

test("buildIngressSources: both adapters absent returns []", async () => {
  const adapters: IngressAdapterSet = {
    caddy: fakeAdapter("caddy", null),
    traefik: fakeAdapter("traefik", null),
  };
  const sources = await buildIngressSources(adapters, ctx());
  assertEquals(sources, []);
});

test("buildIngressSources: one adapter present returns exactly one source", async () => {
  const adapters: IngressAdapterSet = {
    caddy: fakeAdapter("caddy", {
      sourceId: "caddy",
      sourceKind: "caddy",
      reading: EMPTY_READING,
    }),
    traefik: fakeAdapter("traefik", null),
  };
  const sources = await buildIngressSources(adapters, ctx());
  assertEquals(sources.length, 1);
  assertEquals(sources[0].sourceId, "caddy");
  assertEquals(sources[0].sourceKind, "caddy");
  // Every field the reading didn't set falls back to null, never undefined.
  assertEquals(sources[0].requests, null);
  assertEquals(sources[0].upstreamsHealthy, null);
});

test("buildIngressSources: both adapters present returns both sources", async () => {
  const adapters: IngressAdapterSet = {
    caddy: fakeAdapter("caddy", {
      sourceId: "caddy",
      sourceKind: "caddy",
      reading: EMPTY_READING,
    }),
    traefik: fakeAdapter("traefik", {
      sourceId: "traefik",
      sourceKind: "traefik",
      reading: EMPTY_READING,
    }),
  };
  const sources = await buildIngressSources(adapters, ctx());
  assertEquals(sources.map((s) => s.sourceId).sort(), ["caddy", "traefik"]);
});

test("buildIngressSources: an absent source invalidates its baseline namespace so a later readable tick re-origins", async () => {
  const tracker = new CounterBaselineTracker();
  tracker.rate("ingress:caddy:requests", 100, 1, 60);
  assertEquals(tracker.rate("ingress:caddy:requests", 105, 1, 60), 5 / 60);

  let present = false;
  const adapters: IngressAdapterSet = {
    caddy: {
      id: "caddy",
      probe: () => Promise.resolve(),
      read: () =>
        Promise.resolve(
          present
            ? {
              sourceId: "caddy",
              sourceKind: "caddy",
              reading: { requests: null },
            }
            : null,
        ),
    },
    traefik: fakeAdapter("traefik", null),
  };

  // Tick where caddy is absent — invalidates the baseline.
  await buildIngressSources(adapters, {
    tracker,
    bootGeneration: 1,
    seconds: 60,
  });

  // A later readable tick must not diff against the stale pre-gap baseline —
  // it should behave like a fresh first observation.
  present = true;
  assertEquals(tracker.rate("ingress:caddy:requests", 500, 1, 60), null);
});

test("buildIngressSources: adapter throwing degrades to absent, not a rejected promise", async () => {
  const adapters: IngressAdapterSet = {
    caddy: {
      id: "caddy",
      probe: () => Promise.resolve(),
      read: () => {
        throw new Error("boom");
      },
    },
    traefik: fakeAdapter("traefik", null),
  };
  const sources = await buildIngressSources(adapters, ctx());
  assertEquals(sources, []);
});

// ---------------------------------------------------------------------------
// Adapter parity — Caddy and Traefik must expose the identical
// IngressSourceSampleV5 field set for equivalent synthetic traffic; only
// sourceKind (and fields with no vendor equivalent) differ.
// ---------------------------------------------------------------------------

test("Caddy and Traefik parsers produce the identical field set for equivalent traffic, differing only in sourceKind", () => {
  const caddyTracker = new CounterBaselineTracker();
  const traefikTracker = new CounterBaselineTracker();

  // Prime both trackers so rate fields resolve to real numbers, not
  // first-observation nulls.
  parseCaddyExpositionV5(
    parsePrometheusExposition(fixture("proxy-caddy-metrics-v5-partial.txt")),
    { tracker: caddyTracker, bootGeneration: 1, seconds: 60 },
  );
  parseTraefikExposition(
    parsePrometheusExposition(fixture("proxy-traefik-metrics-partial.txt")),
    { tracker: traefikTracker, bootGeneration: 1, seconds: 60 },
  );

  // Both fixtures encode the same synthetic traffic shape: 100 requests
  // (90×200, 10×404), 47000 request bytes, 504000 response bytes, 10s
  // cumulative duration, and identical bucket-boundary counts.
  const caddyReading = parseCaddyExpositionV5(
    parsePrometheusExposition(fixture("proxy-caddy-metrics-v5-base.txt")),
    { tracker: caddyTracker, bootGeneration: 1, seconds: 60 },
  );
  const traefikReading = parseTraefikExposition(
    parsePrometheusExposition(fixture("proxy-traefik-metrics.txt")),
    { tracker: traefikTracker, bootGeneration: 1, seconds: 60 },
  );

  const caddy = { sourceId: "caddy", sourceKind: "caddy", ...caddyReading };
  const traefik = {
    sourceId: "traefik",
    sourceKind: "traefik",
    ...traefikReading,
  };

  assertEquals(Object.keys(caddy).sort(), Object.keys(traefik).sort());

  // Equivalent synthetic traffic must produce equal values field-by-field,
  // except: sourceId/sourceKind (which name the adapter); requestsInFlight/
  // upstreamsHealthy/upstreamsTotal (the two fixtures deliberately use
  // different gauge values to also cover their own presence/absence
  // semantics elsewhere); and retries, which has no Caddy
  // equivalent at all (always null there) but resolves a real Traefik rate.
  const EXPECTED_TO_DIFFER = new Set([
    "sourceId",
    "sourceKind",
    "requestsInFlight",
    "upstreamsHealthy",
    "upstreamsTotal",
    "retries",
  ]);
  for (const key of Object.keys(caddy)) {
    if (EXPECTED_TO_DIFFER.has(key)) continue;
    assertEquals(
      (caddy as Record<string, unknown>)[key],
      (traefik as Record<string, unknown>)[key],
      `field ${key} diverged between Caddy and Traefik for equivalent traffic`,
    );
  }
});
