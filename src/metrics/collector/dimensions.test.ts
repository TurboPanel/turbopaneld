import { assertEquals } from "@std/assert";
import { METRICS_SCHEMA_VERSION } from "../contract.ts";
import { resolveDimensions } from "./dimensions.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("resolveDimensions returns the schema version only — no per-sample host facts", () => {
  assertEquals(resolveDimensions(), {
    schemaVersion: METRICS_SCHEMA_VERSION,
  });
});
