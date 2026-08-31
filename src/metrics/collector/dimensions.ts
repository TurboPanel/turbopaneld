import { getBuildInfo } from "../../build-info.ts";
import { type HostOsMetadata, readOsRelease } from "../../host/os-release.ts";
import { METRICS_SCHEMA_VERSION } from "../contract.ts";
import { readProcFile } from "./proc-read.ts";
import type { StaticDimensions } from "./types.ts";

/** Optional seams for host-free `resolveDimensions` tests. */
export type ResolveDimensionsDeps = {
  readOsRelease?: () => HostOsMetadata | undefined;
  readProcFile?: (
    path: string,
  ) => Promise<string | undefined> | string | undefined;
  getBuildInfo?: () => { commit: string };
  build?: { os: string; arch: string };
};

/**
 * Resolve static host dimensions for each metrics sample.
 *
 * `runtimeMode` is intentionally unset on the daemon — deployment mode is an
 * adapter/instance concern filled in upstream when needed. `collectionMode`
 * and the sensor/interface identities are per-collect facts the collector
 * itself fills in.
 */
export async function resolveDimensions(
  deps: ResolveDimensionsDeps = {},
): Promise<StaticDimensions> {
  const osRelease = (deps.readOsRelease ?? readOsRelease)();
  const kernelRaw = await (deps.readProcFile ?? readProcFile)(
    "/proc/sys/kernel/osrelease",
  );
  const kernelRelease = kernelRaw?.trim() ?? "";
  const build = deps.build ?? Deno.build;
  const commit = (deps.getBuildInfo ?? getBuildInfo)().commit;

  return {
    schemaVersion: METRICS_SCHEMA_VERSION,
    daemonVersion: commit,
    operatingSystem: osRelease?.prettyName ?? build.os,
    architecture: build.arch,
    kernelRelease,
  };
}
