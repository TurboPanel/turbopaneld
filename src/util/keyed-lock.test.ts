import { assertEquals } from "@std/assert";
import { withKeyedLock } from "./keyed-lock.ts";

Deno.test("withKeyedLock runs same-key work one at a time, in order, even after a failure", async () => {
  const order: string[] = [];
  const slow = withKeyedLock("k", async () => {
    order.push("a start");
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push("a end");
    throw new Error("boom");
  }).catch(() => order.push("a failed"));
  const second = withKeyedLock("k", () => {
    order.push("b");
    return Promise.resolve();
  });
  const other = withKeyedLock("other", () => {
    order.push("other");
    return Promise.resolve();
  });
  await Promise.all([slow, second, other]);
  assertEquals(order.indexOf("other") < order.indexOf("a end"), true);
  assertEquals(order.indexOf("b") > order.indexOf("a end"), true);
});
