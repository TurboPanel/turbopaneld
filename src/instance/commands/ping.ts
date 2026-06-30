import { getBuildInfo } from "../../build-info.ts";
import type { PingResult } from "./contracts.ts";

export function handlePing(daemonReceivedAt: string): PingResult {
  const daemonRespondedAt = new Date().toISOString();
  const build = getBuildInfo();

  return {
    daemonReceivedAt,
    daemonRespondedAt,
    daemonHostname: Deno.hostname(),
    daemonBuild: {
      commit: build.commit,
      buildId: build.buildId,
      builtAt: build.builtAt,
      channel: build.channel,
    },
  };
}
