import { assertEquals } from "@std/assert";
import {
  engineInUse,
  type EngineUsage,
  pruneEngines,
  unusedEngines,
} from "./engine-prune.ts";
import {
  engineHoldKey,
  holdPruneKeys,
  phpSeriesHoldKey,
  resetPruneHoldsForTests,
} from "./prune-holds.ts";
import { prunePhpSeries } from "./php-series-prune.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const usage = (
  engine: EngineUsage["engine"],
  sites: string[] = [],
  vhosts: string[] = [],
): EngineUsage => ({ engine, sites, vhosts });

test("an engine is in use while its sites dir holds a live, staged or snapshot config", () => {
  assertEquals(engineInUse(usage("nginx")), false);
  assertEquals(engineInUse(usage("nginx", ["tp-env-www.conf"])), true);
  assertEquals(engineInUse(usage("nginx", ["tp-env-www.conf.tpnew"])), true);
  assertEquals(engineInUse(usage("apache", ["tp-env-www.conf.tpprev"])), true);
  // Anything else in sites/ is not a site.
  assertEquals(engineInUse(usage("apache", ["README", "x.bak"])), false);
});

test("anything in OpenLiteSpeed's vhosts keeps it", () => {
  assertEquals(engineInUse(usage("openlitespeed", [], ["tp-env-www"])), true);
  assertEquals(engineInUse(usage("openlitespeed", [], [".hidden"])), true);
});

test("unusedEngines lists installed engines nothing uses, in a fixed order", () => {
  assertEquals(
    unusedEngines([
      usage("openlitespeed"),
      usage("nginx", ["a.conf"]),
      usage("apache"),
    ]),
    ["apache", "openlitespeed"],
  );
  assertEquals(unusedEngines([]), []);
});

test("pruneEngines removes nothing when the configs could not be read", async () => {
  resetPruneHoldsForTests();
  let called = false;
  const result = await pruneEngines({
    gather: () => Promise.resolve(null),
    remove: () => {
      called = true;
      return Promise.resolve();
    },
  });
  assertEquals(result, []);
  assertEquals(called, false);
});

test("an engine a deploy holds stays; a PHP series hold does not keep an engine", async () => {
  resetPruneHoldsForTests();
  const removed: string[][] = [];
  const deps = {
    gather: () => Promise.resolve([usage("nginx"), usage("apache")]),
    remove: (engines: string[]) => {
      removed.push(engines);
      return Promise.resolve();
    },
  };
  const engine = await holdPruneKeys([engineHoldKey("nginx")]);
  const php = await holdPruneKeys([phpSeriesHoldKey("8.4")]);
  assertEquals(await pruneEngines(deps), ["apache"]);
  engine();
  assertEquals(await pruneEngines(deps), ["nginx", "apache"]);
  php();
  assertEquals(removed, [["apache"], ["nginx", "apache"]]);
});

test("an engine hold does not keep a PHP series", async () => {
  resetPruneHoldsForTests();
  const release = await holdPruneKeys([engineHoldKey("nginx")]);
  const result = await prunePhpSeries({
    gather: () =>
      Promise.resolve({
        installed: ["8.4"],
        pools: new Map(),
        runtimeIds: [],
        configTexts: [],
      }),
    remove: () => Promise.resolve(),
  });
  release();
  assertEquals(result, ["8.4"]);
});

test("a failed engine removal is not fatal and leaves nothing locked", async () => {
  resetPruneHoldsForTests();
  let removals = 0;
  const deps = {
    gather: () => Promise.resolve([usage("nginx")]),
    remove: () => {
      removals++;
      return Promise.reject(new Error("unit busy"));
    },
  };
  assertEquals(await pruneEngines(deps), []);
  assertEquals(await pruneEngines(deps), []);
  assertEquals(removals, 2);
});
