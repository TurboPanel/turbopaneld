import { assertEquals } from "@std/assert";
import { CounterBaselineTracker } from "../baseline.ts";
import { buildIngressSources } from "./index.ts";
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

function fakeAdapter(
  result:
    | { sourceId: string; sourceKind: string; reading: IngressReading }
    | null,
): IngressAdapter {
  return {
    id: "caddy",
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

test("buildIngressSources: the adapter absent returns []", async () => {
  const adapters: IngressAdapterSet = { caddy: fakeAdapter(null) };
  const sources = await buildIngressSources(adapters, ctx());
  assertEquals(sources, []);
});

test("buildIngressSources: adapter present returns exactly one source with every unset field null", async () => {
  const adapters: IngressAdapterSet = {
    caddy: fakeAdapter({
      sourceId: "caddy",
      sourceKind: "caddy",
      reading: EMPTY_READING,
    }),
  };
  const sources = await buildIngressSources(adapters, ctx());
  assertEquals(sources.length, 1);
  assertEquals(sources[0].sourceId, "caddy");
  assertEquals(sources[0].sourceKind, "caddy");
  // Every field the reading didn't set falls back to null, never undefined.
  assertEquals(sources[0].requests, null);
  assertEquals(sources[0].upstreamsHealthy, null);
  assertEquals(sources[0].requestDurationSecondsSum, null);
  assertEquals(sources[0].bucket10ms, null);
  assertEquals(sources[0].bucket5s, null);
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
  };
  const sources = await buildIngressSources(adapters, ctx());
  assertEquals(sources, []);
});
