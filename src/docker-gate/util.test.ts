import { assertEquals, assertRejects } from "@std/assert";
import {
  describeError,
  repeatSequential,
} from "../../orchestration/roles/docker-gate/files/util.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("repeatSequential runs steps one at a time until one resolves false", async () => {
  const order: string[] = [];
  let turn = 0;
  await repeatSequential(async () => {
    turn++;
    order.push(`start ${turn}`);
    await Promise.resolve();
    order.push(`end ${turn}`);
    return turn < 3;
  });
  assertEquals(order, [
    "start 1",
    "end 1",
    "start 2",
    "end 2",
    "start 3",
    "end 3",
  ]);
});

test("repeatSequential rejects with the first failure and starts nothing after it", async () => {
  let turns = 0;
  await assertRejects(
    () =>
      repeatSequential(() => {
        turns++;
        return turns === 2
          ? Promise.reject(new Error("boom"))
          : Promise.resolve(true);
      }),
    Error,
    "boom",
  );
  assertEquals(turns, 2);
});

test("repeatSequential survives a long run without recursion", async () => {
  let count = 0;
  await repeatSequential(() => {
    count++;
    return Promise.resolve(count < 20000);
  });
  assertEquals(count, 20000);
});

test("describeError names errors and never prints [object Object]", () => {
  assertEquals(describeError(new TypeError("bad")), "TypeError: bad");
  assertEquals(describeError("plain"), "plain");
  assertEquals(describeError({ a: 1 }), "non-error value thrown");
  assertEquals(describeError(undefined), "non-error value thrown");
});
