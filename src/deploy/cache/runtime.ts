/**
 * The project cache engine and where its files live.
 *
 * A project cache is a native Valkey process the host runs as one Hosting
 * Account. The wire names a series (`8.1`); the daemon maps it to the pinned
 * patch release it vendors. The pins here, the `valkey-runtime` role defaults
 * and `tp-host`'s unit check move together (a test keeps them equal).
 */

import { join } from "node:path";
import type { LayoutPaths } from "../../paths/layout.ts";
import { principalHomePath } from "../../paths/layout.ts";
import { CACHE_RUNTIMES } from "./limits.ts";

export type CacheEngine = "valkey";

export { CACHE_RUNTIMES, MAX_CACHES_PER_COMMAND } from "./limits.ts";

/** The patch release for a series, or undefined when none is vendored. */
export function cachePatchVersion(
  engine: CacheEngine,
  series: string,
): string | undefined {
  return Object.hasOwn(CACHE_RUNTIMES[engine], series)
    ? CACHE_RUNTIMES[engine][series]
    : undefined;
}

/** A cache id: a lower-case canonical UUID (it forms paths and unit names). */
export const CACHE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `<runtimesDir>/valkey/<patch>`. */
export function cacheRuntimeDir(
  layout: Pick<LayoutPaths, "runtimesDir">,
  patch: string,
): string {
  return join(layout.runtimesDir, "valkey", patch);
}

/** `<runtimesDir>/valkey/<patch>/bin/valkey-server`. */
export function cacheBinaryPath(
  layout: Pick<LayoutPaths, "runtimesDir">,
  patch: string,
): string {
  return join(cacheRuntimeDir(layout, patch), "bin", "valkey-server");
}

/** `turbopanel-cache-<id>.service`. */
export function cacheUnitName(id: string): string {
  return `turbopanel-cache-${id}.service`;
}

/** `/run/turbopanel-cache-<id>` (the unit's RuntimeDirectory, `/run` is fixed). */
export function cacheRuntimeDirectory(id: string): string {
  return `/run/turbopanel-cache-${id}`;
}

/** The unix socket of a socket-access cache. */
export function cacheSocketPath(id: string): string {
  return `${cacheRuntimeDirectory(id)}/valkey.sock`;
}

/**
 * `<principalHome>/cache/<id>`: the data folder. `cache` is one of the scope
 * names no environment may take, so it never collides with an environment's
 * folder.
 */
export function cacheDataDir(
  layout: Pick<LayoutPaths, "principalHomeRoot">,
  username: string,
  id: string,
): string {
  return join(principalHomePath(layout, username), "cache", id);
}

/** `<config>/cache/<id>`: the root-owned folder holding `valkey.conf`. */
export function cacheConfigDir(
  layout: Pick<LayoutPaths, "configDir">,
  id: string,
): string {
  return join(layout.configDir, "cache", id);
}

/** `<config>/cache/<id>/valkey.conf`. */
export function cacheConfigPath(
  layout: Pick<LayoutPaths, "configDir">,
  id: string,
): string {
  return join(cacheConfigDir(layout, id), "valkey.conf");
}

/** The daemon's folder for staged configs that `cache-config-install` copies. */
export function cacheStageDir(layout: Pick<LayoutPaths, "stateDir">): string {
  return join(layout.stateDir, "caches", ".stage");
}

/** `<state>/caches/<environmentId>.json`: the caches this host runs for an environment. */
export function cacheIndexPath(
  layout: Pick<LayoutPaths, "stateDir">,
  environmentId: string,
): string {
  return join(layout.stateDir, "caches", `${environmentId}.json`);
}
