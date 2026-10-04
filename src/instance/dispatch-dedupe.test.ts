import { assertEquals } from "@std/assert";
import { SeenCommandIds } from "./dispatch-dedupe.ts";

Deno.test("SeenCommandIds flags a repeated id once and forgets after the ttl", () => {
  const seen = new SeenCommandIds(1_000, 10);
  assertEquals(seen.seenBefore("a", 0), false);
  assertEquals(seen.seenBefore("a", 500), true);
  assertEquals(seen.seenBefore("b", 500), false);
  assertEquals(seen.seenBefore("a", 1_500), false);
});

Deno.test("SeenCommandIds stays bounded", () => {
  const seen = new SeenCommandIds(60_000, 3);
  for (let i = 0; i < 10; i++) seen.seenBefore(`id${i}`, i);
  assertEquals(seen.seenBefore("id0", 11), false);
  assertEquals(seen.seenBefore("id9", 11), true);
});
