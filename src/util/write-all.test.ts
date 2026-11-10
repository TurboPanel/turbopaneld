import { assertEquals } from "@std/assert";
import { writeAll } from "./write-all.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("every byte is written even when each write takes only two", async () => {
  const seen: number[] = [];
  await writeAll({
    write: (bytes) => {
      const part = bytes.subarray(0, 2);
      seen.push(...part);
      return Promise.resolve(part.length);
    },
  }, Uint8Array.of(1, 2, 3, 4, 5));
  assertEquals(seen, [1, 2, 3, 4, 5]);
});

test("nothing to write calls nothing", async () => {
  let calls = 0;
  await writeAll({
    write: () => {
      calls += 1;
      return Promise.resolve(0);
    },
  }, new Uint8Array());
  assertEquals(calls, 0);
});

test("a writer that takes nothing is an error, not a hang", async () => {
  let failed = false;
  try {
    await writeAll({ write: () => Promise.resolve(0) }, Uint8Array.of(1));
  } catch (err) {
    failed = err instanceof Deno.errors.WriteZero;
  }
  assertEquals(failed, true);
});
