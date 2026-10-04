import { assertEquals } from "@std/assert";
import { clipKeepingEnd, lastNonEmptyLines, oneLine } from "./error-line.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("lastNonEmptyLines skips blank lines and keeps the newest", () => {
  assertEquals(lastNonEmptyLines("a\n\n b \r\n\nc\n", 2), [" b ", "c"]);
  assertEquals(lastNonEmptyLines("", 3), []);
});

test("oneLine collapses whitespace", () => {
  assertEquals(oneLine("a\n  b\t\tc "), "a b c");
});

test("clipKeepingEnd leaves short text alone and keeps the end of long text", () => {
  assertEquals(clipKeepingEnd("short", 10), "short");
  assertEquals(clipKeepingEnd("0123456789abcdef", 8), "…9abcdef");
  assertEquals(clipKeepingEnd("x".repeat(1000)).length, 300);
});
