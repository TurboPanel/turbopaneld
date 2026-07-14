import { assertEquals } from "jsr:@std/assert";
import { withRetry } from "./retry.ts";

Deno.test("withRetry returns the first successful result without retrying", async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    return "ok";
  }, { label: "test op", baseDelayMs: 1, maxDelayMs: 1 });
  assertEquals(result, "ok");
  assertEquals(calls, 1);
});

Deno.test("withRetry retries transient failures and eventually succeeds", async () => {
  let calls = 0;
  const result = await withRetry(async (attempt) => {
    calls++;
    if (attempt < 3) throw new Error(`transient failure ${attempt}`);
    return "recovered";
  }, { label: "test op", attempts: 5, baseDelayMs: 1, maxDelayMs: 1 });
  assertEquals(result, "recovered");
  assertEquals(calls, 3);
});

Deno.test("withRetry throws the last error once attempts are exhausted", async () => {
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
