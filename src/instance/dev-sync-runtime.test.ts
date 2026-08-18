import { assertEquals } from "@std/assert";
import {
  enableCheckoutDevSync,
  getCheckoutDevSyncApply,
} from "./dev-sync-runtime.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("enableCheckoutDevSync registers apply for getCheckoutDevSyncApply", async () => {
  const payload = new Uint8Array([1, 2, 3]);
  let seen: Uint8Array | undefined;
  enableCheckoutDevSync((bytes) => {
    seen = bytes;
    return Promise.resolve();
  });

  const apply = getCheckoutDevSyncApply();
  if (typeof apply !== "function") {
    throw new TypeError("expected checkout-sync apply function");
  }
  await apply(payload);
  assertEquals(seen, payload);
});

test("enableCheckoutDevSync replaces the previous apply hook", () => {
  const first = () => Promise.resolve();
  const second = () => Promise.resolve();
  enableCheckoutDevSync(first);
  assertEquals(getCheckoutDevSyncApply(), first);
  enableCheckoutDevSync(second);
  assertEquals(getCheckoutDevSyncApply(), second);
});
