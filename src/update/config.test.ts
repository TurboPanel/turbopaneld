import { assertEquals, assertThrows } from "@std/assert";
import { resolveUpdateChannelConfig } from "./config.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("resolveUpdateChannelConfig defaults to trunk", () => {
  assertEquals(resolveUpdateChannelConfig({}), {
    app: "daemon",
    channel: "trunk",
  });
  assertEquals(
    resolveUpdateChannelConfig({ TURBOPANEL_UPDATE_CHANNEL: "  " }),
    { app: "daemon", channel: "trunk" },
  );
});

test("resolveUpdateChannelConfig accepts each valid channel", () => {
  for (const channel of ["trunk", "edge", "canary", "rc", "release"] as const) {
    assertEquals(
      resolveUpdateChannelConfig({ TURBOPANEL_UPDATE_CHANNEL: channel }),
      { app: "daemon", channel },
    );
  }
});

test("resolveUpdateChannelConfig trims and rejects invalid values", () => {
  assertEquals(
    resolveUpdateChannelConfig({ TURBOPANEL_UPDATE_CHANNEL: "  canary  " }),
    { app: "daemon", channel: "canary" },
  );
  assertThrows(
    () => resolveUpdateChannelConfig({ TURBOPANEL_UPDATE_CHANNEL: "nightly" }),
    Error,
    'Invalid TURBOPANEL_UPDATE_CHANNEL: "nightly"',
  );
});
