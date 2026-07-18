import { assertEquals } from "jsr:@std/assert";
import { withRetry } from "./retry.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("withRetry returns the first successful result without retrying", async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    return "ok";
  }, { label: "test op", baseDelayMs: 1, maxDelayMs: 1 });
  assertEquals(result, "ok");
  assertEquals(calls, 1);
});

test("withRetry retries transient failures and eventually succeeds", async () => {
  let calls = 0;
  const result = await withRetry(async (attempt) => {
    calls++;
    if (attempt < 3) throw new Error(`transient failure ${attempt}`);
    return "recovered";
  }, { label: "test op", attempts: 5, baseDelayMs: 1, maxDelayMs: 1 });
  assertEquals(result, "recovered");
  assertEquals(calls, 3);
});

test("withRetry throws the last error once attempts are exhausted", async () => {
  let calls = 0;
  try {
    await withRetry(async (attempt) => {
      calls++;
      throw new Error(`always fails ${attempt}`);
    }, { label: "test op", attempts: 3, baseDelayMs: 1, maxDelayMs: 1 });
    throw new Error("expected withRetry to throw");
  } catch (err) {
    assertEquals(
      err instanceof Error ? err.message : String(err),
      "always fails 3",
    );
  }
  assertEquals(calls, 3);
});
