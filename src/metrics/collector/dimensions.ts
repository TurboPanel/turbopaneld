import { getBuildInfo } from "../../build-info.ts";
import { readOsRelease } from "../../host/os-release.ts";
import {
  type HostMetricsDimensions,
  METRICS_SCHEMA_VERSION,
} from "../contract.ts";
import { readProcFile } from "./proc-read.ts";

/**
 * Resolve static host dimensions for each metrics sample.
 *
 * `runtimeMode` is intentionally unset on the daemon — deployment mode is an
 * adapter/instance concern filled in upstream when needed.
 */
export async function resolveDimensions(): Promise<HostMetricsDimensions> {
  const osRelease = readOsRelease();
  const kernelRelease =
    (await readProcFile("/proc/sys/kernel/osrelease"))?.trim() ?? "";

  return {
    schemaVersion: METRICS_SCHEMA_VERSION,
    daemonVersion: getBuildInfo().commit,
    operatingSystem: osRelease?.prettyName ?? Deno.build.os,
    architecture: Deno.build.arch,
    kernelRelease,
  };
}
