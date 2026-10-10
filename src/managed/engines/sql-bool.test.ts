import { assertEquals } from "@std/assert";
import { parseSqlBool } from "./sql-bool.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const TRUE_CELLS = ["1", "ON", "on", "true", "TRUE", "yes", "YES"];
const FALSE_CELLS = ["0", "OFF", "off", "false", "FALSE", "no", "NO"];

test("parseSqlBool accepts true spellings case-insensitively", () => {
  for (const raw of TRUE_CELLS) {
    assertEquals(parseSqlBool(raw), true, raw);
  }
});

test("parseSqlBool accepts false spellings case-insensitively", () => {
  for (const raw of FALSE_CELLS) {
    assertEquals(parseSqlBool(raw), false, raw);
  }
});

test("parseSqlBool trims surrounding whitespace and newlines", () => {
  assertEquals(parseSqlBool("  1  "), true);
  assertEquals(parseSqlBool("\tON\n"), true);
  assertEquals(parseSqlBool(" 0 \r\n"), false);
  assertEquals(parseSqlBool("\nOFF\n"), false);
});

test("parseSqlBool returns undefined for empty and garbage cells", () => {
  assertEquals(parseSqlBool(""), undefined);
  assertEquals(parseSqlBool("   "), undefined);
  assertEquals(parseSqlBool("\n"), undefined);
  assertEquals(parseSqlBool("garbage"), undefined);
  assertEquals(parseSqlBool("2"), undefined);
  assertEquals(parseSqlBool("maybe"), undefined);
});
