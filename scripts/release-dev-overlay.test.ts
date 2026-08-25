import { assertEquals } from "@std/assert";
import { stampBuildInfo } from "./release-dev-overlay.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("stampBuildInfo replaces commit, buildId, and builtAt", () => {
  const source = [
    "export const BUILD_INFO = {",
    '  commit: "oldsha",',
    '  buildId: "old-build",',
    '  builtAt: "2020-01-01T00:00:00.000Z",',
    "};",
  ].join("\n");
  const stamped = stampBuildInfo(source, {
    commit: "abc1234+99",
    buildId: "dev-abc1234+99",
    builtAt: "2026-08-25T00:00:00.000Z",
  });
  assertEquals(stamped.includes('commit: "abc1234+99"'), true);
  assertEquals(stamped.includes('buildId: "dev-abc1234+99"'), true);
  assertEquals(stamped.includes('builtAt: "2026-08-25T00:00:00.000Z"'), true);
  assertEquals(stamped.includes("oldsha"), false);
});
