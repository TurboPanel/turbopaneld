/**
 * Removing a web engine (nginx, Apache, OpenLiteSpeed) no site uses any more.
 *
 * Installing is lazy: an engine lands on the first deploy with a site it
 * serves. This is the counterpart, as timid as the PHP series one
 * (`php-series-prune.ts`): an engine goes only when its config directories are
 * known to be empty, and any doubt keeps it. Caddy is never removed (the
 * panel's own and the site one both stay), nor is anything PHP.
 *
 * Installed: `<vendor>/<engine>/current` exists.
 * In use: its `sites/` directory holds a live, staged or snapshot config
 * (`.conf`, `.tpnew`, `.tpprev`: a rollout in progress may swap either back),
 * or, for OpenLiteSpeed, anything at all sits in `vhosts/`. A deploy in flight
 * holds every engine it serves (`engine:<id>` in `prune-holds.ts`).
 */

import { engineHoldKey, pruneUnheld } from "./prune-holds.ts";

/** Engines this removal may take away. Never Caddy. */
export const PRUNABLE_ENGINES = Object.freeze(
  ["nginx", "apache", "openlitespeed"] as const,
);
export type PrunableEngine = (typeof PRUNABLE_ENGINES)[number];

/** One installed engine's config entries, read by the caller. */
export type EngineUsage = Readonly<{
  engine: PrunableEngine;
  /** Entry names of `<config>/<engine>/sites` (empty when it is missing). */
  sites: readonly string[];
  /** Entry names of OpenLiteSpeed's `vhosts` (empty for the others). */
  vhosts: readonly string[];
}>;

const SITE_CONFIG_RE = /\.(?:conf|tpnew|tpprev)$/;

/** Whether an installed engine still has a site, from its config entries. */
export function engineInUse(usage: EngineUsage): boolean {
  return usage.sites.some((name) => SITE_CONFIG_RE.test(name)) ||
    usage.vhosts.length > 0;
}

/** Installed engines nothing uses, in {@link PRUNABLE_ENGINES} order. */
export function unusedEngines(
  installed: readonly EngineUsage[],
): PrunableEngine[] {
  const unused = new Set(
    installed.filter((usage) => !engineInUse(usage)).map((u) => u.engine),
  );
  return PRUNABLE_ENGINES.filter((engine) => unused.has(engine));
}

export type EnginePruneDeps = Readonly<{
  /**
   * Reads the host: every installed engine with its config entries. `null`
   * when any config directory could not be read: nothing is removed then.
   */
  gather: () => Promise<readonly EngineUsage[] | null>;
  /** Removes the given engines from the host (privileged). */
  remove: (engines: PrunableEngine[]) => Promise<void>;
}>;

/**
 * Remove every installed engine nothing uses and no deploy holds. Returns the
 * engines it removed. Never throws: a failed removal is logged and the engine
 * stays for the next try.
 */
export function pruneEngines(
  deps: EnginePruneDeps,
): Promise<PrunableEngine[]> {
  return pruneUnheld({
    label: "web engines",
    keyOf: engineHoldKey,
    findUnused: async () => {
      const installed = await deps.gather();
      return installed === null ? null : unusedEngines(installed);
    },
    remove: deps.remove,
  });
}
