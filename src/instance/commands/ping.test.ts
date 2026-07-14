import { assert, assertEquals } from "jsr:@std/assert";
import { getBuildInfo } from "../../build-info.ts";
import { handlePing } from "./ping.ts";

Deno.test({
  name: "handlePing returns timestamps, hostname, and build info",
  permissions: { sys: ["hostname"] },
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
