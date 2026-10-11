import { assertEquals } from "@std/assert";
import {
  holdPhpSeries,
  phpSeriesInUse,
  phpSeriesNamedIn,
  phpSeriesOfRuntimeId,
  type PhpSeriesUsageInput,
  prunePhpSeries,
  resetPhpSeriesPruneForTests,
  unusedPhpSeries,
} from "./php-series-prune.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const host = (
  over: Partial<PhpSeriesUsageInput> = {},
): PhpSeriesUsageInput => ({
  installed: ["8.1", "8.4", "8.5"],
  pools: new Map([
    ["8.1", ["default.conf"]],
    ["8.4", ["default.conf", "tp-env1-web.conf"]],
    ["8.5", ["default.conf"]],
  ]),
  runtimeIds: [],
  configTexts: [],
  ...over,
});

test("a runtime id says which series it runs on", () => {
  assertEquals(phpSeriesOfRuntimeId("shop-0123456789ab-fpm84"), "8.4");
  assertEquals(phpSeriesOfRuntimeId("shop-0123456789ab-fcgi81"), "8.1");
  assertEquals(phpSeriesOfRuntimeId("shop-0123456789ab-lsd85"), "8.5");
  assertEquals(phpSeriesOfRuntimeId("shop-0123456789ab"), null);
  assertEquals(phpSeriesOfRuntimeId("web-fpm"), null);
});

test("a config names the series of its pool socket, lsphp and runtime socket", () => {
  const text = [
    "fastcgi_pass unix:/run/turbopanel/php/8.2/tp-env-web.sock;",
    "path /opt/turbopanel/vendor/lsphp/8.5/current/bin/lsphp",
    "SetHandler proxy:unix:/run/turbopanel-php-shop-0123456789ab-fpm81/php.sock",
  ].join("\n");
  assertEquals(
    [...phpSeriesNamedIn(text)].sort((a, b) => a.localeCompare(b)),
    ["8.1", "8.2", "8.5"],
  );
  assertEquals(phpSeriesNamedIn("listen 80;").size, 0);
});

test("a series is used by a site pool, a runtime or a config, never by the bootstrap pool alone", () => {
  assertEquals([...phpSeriesInUse(host())], ["8.4"]);
  assertEquals(
    [...phpSeriesInUse(host({ runtimeIds: ["a-0123456789ab-fcgi81"] }))].sort(
      (a, b) => a.localeCompare(b),
    ),
    ["8.1", "8.4"],
  );
  assertEquals(
    [
      ...phpSeriesInUse(
        host({ configTexts: ["x /vendor/lsphp/8.5/current/bin/lsphp"] }),
      ),
    ].sort((a, b) => a.localeCompare(b)),
    ["8.4", "8.5"],
  );
});

test("unusedPhpSeries lists installed series nothing uses, oldest first, series-shaped only", () => {
  assertEquals(unusedPhpSeries(host()), ["8.1", "8.5"]);
  assertEquals(
    unusedPhpSeries(host({ installed: ["8.5", "8.1", "latest", "8.1"] })),
    ["8.1", "8.5"],
  );
  assertEquals(unusedPhpSeries(host({ installed: [] })), []);
});

test("prunePhpSeries removes only the unused series, and reports them", async () => {
  resetPhpSeriesPruneForTests();
  const removed: string[][] = [];
  const result = await prunePhpSeries({
    gather: () => Promise.resolve(host()),
    remove: (series) => {
      removed.push(series);
      return Promise.resolve();
    },
  });
  assertEquals(result, ["8.1", "8.5"]);
  assertEquals(removed, [["8.1", "8.5"]]);
});

test("prunePhpSeries removes nothing when the host could not be read", async () => {
  resetPhpSeriesPruneForTests();
  let called = false;
  const result = await prunePhpSeries({
    gather: () => Promise.resolve(null),
    remove: () => {
      called = true;
      return Promise.resolve();
    },
  });
  assertEquals(result, []);
  assertEquals(called, false);
});

test("a series a deploy holds is never removed, and goes once the deploy lets go", async () => {
  resetPhpSeriesPruneForTests();
  const removed: string[][] = [];
  const deps = {
    gather: () => Promise.resolve(host()),
    remove: (series: string[]) => {
      removed.push(series);
      return Promise.resolve();
    },
  };
  const release = await holdPhpSeries(["8.1"]);
  assertEquals(await prunePhpSeries(deps), ["8.5"]);
  release();
  release(); // releasing twice never drops another deploy's hold
  assertEquals(await prunePhpSeries(deps), ["8.1", "8.5"]);
  assertEquals(removed, [["8.5"], ["8.1", "8.5"]]);
});

test("two deploys holding one series keep it until both let go", async () => {
  resetPhpSeriesPruneForTests();
  const deps = {
    gather: () => Promise.resolve(host({ installed: ["8.1"] })),
    remove: () => Promise.resolve(),
  };
  const first = await holdPhpSeries(["8.1"]);
  const second = await holdPhpSeries(["8.1"]);
  first();
  assertEquals(await prunePhpSeries(deps), []);
  second();
  assertEquals(await prunePhpSeries(deps), ["8.1"]);
});

test("a deploy that wants a series being removed waits for the removal, then holds it", async () => {
  resetPhpSeriesPruneForTests();
  let finish: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const events: string[] = [];
  const pruning = prunePhpSeries({
    gather: () => Promise.resolve(host({ installed: ["8.1"] })),
    remove: async () => {
      events.push("remove started");
      await gate;
      events.push("remove done");
    },
  });
  // The removal has begun by the time gather resolves and remove is entered.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const held = holdPhpSeries(["8.1"]).then((release) => {
    events.push("held");
    return release;
  });
  await Promise.resolve();
  assertEquals(events.includes("held"), false);
  finish();
  assertEquals(await pruning, ["8.1"]);
  (await held)();
  assertEquals(events, ["remove started", "remove done", "held"]);
});

test("a deploy for other series does not wait for a removal", async () => {
  resetPhpSeriesPruneForTests();
  let finish: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const pruning = prunePhpSeries({
    gather: () => Promise.resolve(host({ installed: ["8.1"] })),
    remove: () => gate,
  });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const release = await holdPhpSeries(["8.4"]);
  release();
  finish();
  assertEquals(await pruning, ["8.1"]);
});

test("a second prune while one runs does nothing, and a failed removal is not fatal", async () => {
  resetPhpSeriesPruneForTests();
  let finish: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let removals = 0;
  const deps = {
    gather: () => Promise.resolve(host({ installed: ["8.1"] })),
    remove: async () => {
      removals++;
      await gate;
      throw new Error("apt is busy");
    },
  };
  const first = prunePhpSeries(deps);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(await prunePhpSeries(deps), []);
  finish();
  assertEquals(await first, []);
  assertEquals(removals, 1);
  // The failure left nothing locked: the next try runs again.
  assertEquals(await prunePhpSeries(deps).catch(() => "threw"), []);
  assertEquals(removals, 2);
});
