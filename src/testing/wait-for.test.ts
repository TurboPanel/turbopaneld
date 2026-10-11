import { assertEquals, assertRejects } from "@std/assert";
import { waitFor } from "./wait-for.ts";

const test = Deno.test.bind(Deno);

test("waitFor returns as soon as the condition holds", async () => {
  let calls = 0;
  await waitFor("third call", () => ++calls >= 3, { intervalMs: 1 });
  assertEquals(calls, 3);
});

test("waitFor fails with the thing it waited for after the timeout", async () => {
  await assertRejects(
    () => waitFor("never", () => false, { timeoutMs: 20, intervalMs: 1 }),
    Error,
    "waiting for never",
  );
});
