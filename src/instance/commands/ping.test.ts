import { assert, assertEquals } from "jsr:@std/assert";
import { getBuildInfo } from "../../build-info.ts";
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
    assertEquals(result.daemonBuild?.channel, build.channel);
    assertEquals(build.channel, "trunk");
  },
});
