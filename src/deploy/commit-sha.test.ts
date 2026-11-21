import { assertEquals } from "@std/assert";
import { isResolvedCommitSha } from "./commit-sha.ts";

const test = Deno.test.bind(Deno);

test("only a full commit id counts as resolved", () => {
  assertEquals(isResolvedCommitSha("a".repeat(40)), true);
  assertEquals(isResolvedCommitSha("A1".repeat(20)), true);
  assertEquals(isResolvedCommitSha("b".repeat(64)), true);
  assertEquals(isResolvedCommitSha("main"), false);
  assertEquals(isResolvedCommitSha("a".repeat(39)), false);
  assertEquals(isResolvedCommitSha("g".repeat(40)), false);
  assertEquals(isResolvedCommitSha(""), false);
  assertEquals(isResolvedCommitSha(undefined), false);
});
