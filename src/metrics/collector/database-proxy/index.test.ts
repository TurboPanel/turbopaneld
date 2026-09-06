import { assertEquals } from "@std/assert";
import { CounterBaselineTracker } from "../baseline.ts";
import type {
  DatabaseProxyAdapter,
  DatabaseProxyAdapterSet,
  DatabaseProxyReadContext,
  DatabaseProxyReading,
} from "./adapter.ts";
import { buildDatabaseProxies } from "./index.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function fakeAdapter(
  result:
    | { sourceId: string; sourceKind: string; reading: DatabaseProxyReading }
    | null,
): DatabaseProxyAdapter {
  return {
    id: "proxysql",
    probe: () => Promise.resolve(),
    read: () => Promise.resolve(result),
  };
}

function ctx(overrides: Partial<DatabaseProxyReadContext> = {}) {
  return {
    tracker: new CounterBaselineTracker(),
    bootGeneration: 1,
    seconds: 60,
    ...overrides,
  };
}

test("buildDatabaseProxies: adapters undefined returns []", async () => {
  const proxies = await buildDatabaseProxies(undefined, ctx());
  assertEquals(proxies, []);
});

test("buildDatabaseProxies: adapter absent returns []", async () => {
  const adapters: DatabaseProxyAdapterSet = { proxysql: fakeAdapter(null) };
  const proxies = await buildDatabaseProxies(adapters, ctx());
  assertEquals(proxies, []);
});

test("buildDatabaseProxies: adapter present returns exactly one source", async () => {
  const adapters: DatabaseProxyAdapterSet = {
    proxysql: fakeAdapter({
      sourceId: "proxysql",
      sourceKind: "proxysql",
      reading: { queries: 5 },
    }),
  };
  const proxies = await buildDatabaseProxies(adapters, ctx());
  assertEquals(proxies.length, 1);
  assertEquals(proxies[0].sourceId, "proxysql");
  assertEquals(proxies[0].sourceKind, "proxysql");
  assertEquals(proxies[0].queries, 5);
  // Every field the reading didn't set falls back to null, never undefined.
  assertEquals(proxies[0].backendsUp, null);
});

test("buildDatabaseProxies: an absent source invalidates its baseline namespace so a later readable tick re-origins", async () => {
  const tracker = new CounterBaselineTracker();
  tracker.rate("dbproxy:proxysql:queries", 100, 1, 60);
  assertEquals(tracker.rate("dbproxy:proxysql:queries", 105, 1, 60), 5 / 60);

  const adapters: DatabaseProxyAdapterSet = { proxysql: fakeAdapter(null) };
  await buildDatabaseProxies(adapters, {
    tracker,
    bootGeneration: 1,
    seconds: 60,
  });

  assertEquals(tracker.rate("dbproxy:proxysql:queries", 500, 1, 60), null);
});

test("buildDatabaseProxies: adapter throwing degrades to absent, not a rejected promise", async () => {
  const adapters: DatabaseProxyAdapterSet = {
    proxysql: {
      id: "proxysql",
      probe: () => Promise.resolve(),
      read: () => {
        throw new Error("boom");
      },
    },
  };
  const proxies = await buildDatabaseProxies(adapters, ctx());
  assertEquals(proxies, []);
});
