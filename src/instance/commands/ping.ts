import { getBuildInfo } from "../../build-info.ts";
import { resolveUpdateChannelConfig } from "../../update/config.ts";
import { DAEMON_VERSION } from "../../version.ts";
import type { PingResult } from "./contracts.ts";

export function handlePing(daemonReceivedAt: string): PingResult {
  const daemonRespondedAt = new Date().toISOString();
  const build = getBuildInfo();
  // Channel is a placement fact (which channel this daemon is configured to
  // follow), not a build fact — read live, never baked into BuildInfo.
  const { channel } = resolveUpdateChannelConfig();

  return {
    daemonReceivedAt,
    daemonRespondedAt,
    daemonHostname: Deno.hostname(),
    daemonBuild: {
      commit: build.commit,
      buildId: build.buildId,
      builtAt: build.builtAt,
      channel,
      version: DAEMON_VERSION,
    },
  };
}
