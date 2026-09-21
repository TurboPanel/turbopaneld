/**
 * Host-free coverage for the optional-field builder.
 */

import { assertEquals } from "@std/assert";
import { definedFields } from "./optional-fields.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("definedFields drops only undefined values", () => {
  const fields = definedFields({
    kept: "value",
    missing: undefined,
    nulled: null,
    zero: 0,
    blank: "",
    empty: [] as string[],
  });
  assertEquals(Object.keys(fields), [
    "kept",
    "nulled",
    "zero",
    "blank",
    "empty",
  ]);
  assertEquals(fields.kept, "value");
});

test("definedFields leaves an all-present object untouched", () => {
  assertEquals(definedFields({ a: 1, b: "two" }), { a: 1, b: "two" });
});

test("definedFields returns an empty object when nothing is defined", () => {
  const fields: Record<string, unknown> = definedFields({
    a: undefined,
    b: undefined,
  });
  assertEquals(Object.keys(fields), []);
});
