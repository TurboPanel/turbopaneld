import { assertEquals } from "@std/assert";
import { CounterBaselineTracker } from "../baseline.ts";
import { buildRouterSample } from "./index.ts";
import type {
  RouterAdapter,
  RouterAdapterSet,
  RouterReadContext,
  RouterReading,
} from "./adapter.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function fakeAdapter(result: RouterReading | null): RouterAdapter {
  return {
    id: "traefik",
    probe: () => Promise.resolve(),
    read: () => Promise.resolve(result),
  };
}

function ctx(overrides: Partial<RouterReadContext> = {}) {
  return {
    tracker: new CounterBaselineTracker(),
    bootGeneration: 1,
    seconds: 60,
    nowMs: 1_767_200_000_000,
    ...overrides,
  };
}

test("buildRouterSample: adapters undefined returns null", async () => {
  assertEquals(await buildRouterSample(undefined, ctx()), null);
});

test("buildRouterSample: the adapter absent returns null, never an all-null placeholder", async () => {
  const adapters: RouterAdapterSet = { traefik: fakeAdapter(null) };
  assertEquals(await buildRouterSample(adapters, ctx()), null);
});

test("buildRouterSample: a partial reading fills every unset field with null, never undefined", async () => {
  const adapters: RouterAdapterSet = {
    traefik: fakeAdapter({ backendsUp: 2 }),
  };
  const sample = await buildRouterSample(adapters, ctx());
  assertEquals(sample?.backendsUp, 2);
  assertEquals(sample?.backendsTotal, null);
  assertEquals(sample?.servicesTotal, null);
  assertEquals(sample?.routersTotal, null);
  assertEquals(sample?.retries, null);
  assertEquals(sample?.backendErrors5xx, null);
  assertEquals(sample?.backendLatencyMsAvg, null);
  assertEquals(sample?.backendRequests, null);
  assertEquals(sample?.httpOpenConnections, null);
  assertEquals(sample?.configReloads, null);
  assertEquals(sample?.configLastReloadAgeSeconds, null);
  assertEquals(sample?.tlsCertSoonestExpiryDays, null);
});

test("buildRouterSample: an absent router invalidates its baseline namespace so a later readable tick re-origins", async () => {
  const tracker = new CounterBaselineTracker();
  tracker.delta("router:traefik:configReloads", 100, 1);
  assertEquals(tracker.delta("router:traefik:configReloads", 105, 1), 5);

  const adapters: RouterAdapterSet = { traefik: fakeAdapter(null) };
  await buildRouterSample(adapters, ctx({ tracker }));

  // A later readable tick must not diff against the stale pre-gap baseline —
  // it should behave like a fresh first observation.
  assertEquals(tracker.delta("router:traefik:configReloads", 500, 1), null);
});

test("buildRouterSample: adapter throwing degrades to absent, not a rejected promise", async () => {
  const adapters: RouterAdapterSet = {
    traefik: {
      id: "traefik",
      probe: () => Promise.resolve(),
      read: () => {
        throw new Error("boom");
      },
    },
  };
  assertEquals(await buildRouterSample(adapters, ctx()), null);
});
