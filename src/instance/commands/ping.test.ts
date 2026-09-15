import { assert, assertEquals } from "@std/assert";
import { getBuildInfo } from "../../build-info.ts";
import { resolveUpdateChannelConfig } from "../../update/config.ts";
import { handlePing } from "./ping.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test({
  name: "handlePing returns timestamps, hostname, and build info",
  permissions: { env: true, sys: ["hostname"], read: true },
  fn: () => {
    const daemonReceivedAt = "2020-01-01T00:00:00.000Z";
    const result = handlePing(daemonReceivedAt);

    assertEquals(result.daemonReceivedAt, daemonReceivedAt);
    assert(typeof result.daemonRespondedAt === "string");
    assert(result.daemonRespondedAt! >= daemonReceivedAt);
    assert(
      typeof result.daemonHostname === "string" &&
        result.daemonHostname.length > 0,
    );
    assertEquals(result.daemonHostname, Deno.hostname());

    const build = getBuildInfo();
    assertEquals(result.daemonBuild?.commit, build.commit);
    assertEquals(result.daemonBuild?.buildId, build.buildId);
    // Channel is a placement fact, read live from resolveUpdateChannelConfig()
    // — never baked into BuildInfo — so it's compared against that, not build.
    assertEquals(
      result.daemonBuild?.channel,
      resolveUpdateChannelConfig().channel,
    );
  },
});
