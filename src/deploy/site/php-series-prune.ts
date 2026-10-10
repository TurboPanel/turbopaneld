/**
 * Removing a PHP series nobody uses any more.
 *
 * Installing is lazy: a series lands on the first deploy that names it (the
 * `php-fpm` and `openlitespeed` roles install only the series a deploy's sites
 * declare). This is the counterpart, and it is deliberately timid: a series
 * goes only when **every** place that can use it is known to be empty, and any
 * doubt keeps it.
 *
 * Where a series is used:
 * - a site pool on the shared php-fpm master (any pool file but the bootstrap
 *   `default.conf`);
 * - a per-site runtime (`turbopanel-php-<id>-<fcgi|fpm|lsd><digits>` units);
 * - a vhost or OpenLiteSpeed config that names a pool socket, a runtime socket
 *   or the vendored `lsphp` of that series;
 * - a deploy in flight in this process: the series is installed minutes before
 *   its pool exists (the release builds in between), so a deploy holds every
 *   series it names for its whole length.
 */

import { sitePhpRuntimeIdsIn } from "./php-runtime.ts";
import { holdPruneKeys, phpSeriesHoldKey, pruneUnheld } from "./prune-holds.ts";

/** What the host looks like, gathered by the caller (all reads, no writes). */
export type PhpSeriesUsageInput = Readonly<{
  /** Series with anything installed: packages, a vendored lsphp, a config tree. */
  installed: readonly string[];
  /** Pool file names per series. A series missing here has none. */
  pools: ReadonlyMap<string, readonly string[]>;
  /** Every per-site runtime id with a unit file. */
  runtimeIds: readonly string[];
  /** Text of every nginx, Apache and OpenLiteSpeed vhost; read only when needed. */
  configTexts: readonly string[];
}>;

const SERIES_RE = /^\d\.\d{1,2}$/;
const RUNTIME_SERIES_RE = /-(?:fcgi|fpm|lsd)(\d)(\d{1,2})$/;
const POOL_SOCKET_RE = /\/php\/(\d\.\d{1,2})\//g;
const LSPHP_RE = /\/lsphp\/(\d\.\d{1,2})\//g;

/** `8.4` for a runtime id ending `-fpm84`; `null` for anything else. */
export function phpSeriesOfRuntimeId(id: string): string | null {
  const match = RUNTIME_SERIES_RE.exec(id);
  return match ? `${match[1]}.${match[2]}` : null;
}

/** Series a config file names: pool sockets, per-site runtimes, vendored lsphp. */
export function phpSeriesNamedIn(text: string): Set<string> {
  const series = new Set<string>();
  for (const re of [POOL_SOCKET_RE, LSPHP_RE]) {
    for (const match of text.matchAll(re)) series.add(match[1]);
  }
  for (const id of sitePhpRuntimeIdsIn(text)) {
    const fromId = phpSeriesOfRuntimeId(id);
    if (fromId) series.add(fromId);
  }
  return series;
}

/** Series something on the host uses, from what is on disk. */
export function phpSeriesInUse(input: PhpSeriesUsageInput): Set<string> {
  const used = new Set<string>();
  for (const [series, pools] of input.pools) {
    // `default.conf` is the bootstrap pool the role installs.
    if (
      pools.some((name) => name.endsWith(".conf") && name !== "default.conf")
    ) {
      used.add(series);
    }
  }
  for (const id of input.runtimeIds) {
    const series = phpSeriesOfRuntimeId(id);
    if (series) used.add(series);
  }
  for (const text of input.configTexts) {
    for (const series of phpSeriesNamedIn(text)) used.add(series);
  }
  return used;
}

/** Installed series nothing uses, oldest first. */
export function unusedPhpSeries(input: PhpSeriesUsageInput): string[] {
  const used = phpSeriesInUse(input);
  return [...new Set(input.installed)]
    .filter((series) => SERIES_RE.test(series) && !used.has(series))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/**
 * Keep `series` from being removed until the returned function is called; see
 * {@link holdPruneKeys}.
 */
export function holdPhpSeries(
  series: readonly string[],
): Promise<() => void> {
  return holdPruneKeys(series.map(phpSeriesHoldKey));
}

export type PhpSeriesPruneDeps = Readonly<{
  /**
   * Reads the host. `null` when something that could use a series could not be
   * read: nothing is removed on the strength of a reference that was not seen.
   */
  gather: () => Promise<PhpSeriesUsageInput | null>;
  /** Removes the given series from the host (privileged). */
  remove: (series: string[]) => Promise<void>;
}>;

/**
 * Remove every installed series nothing uses and no deploy holds. Returns the
 * series it removed. Never throws: a failed removal is logged and the series
 * stays for the next try.
 */
export function prunePhpSeries(deps: PhpSeriesPruneDeps): Promise<string[]> {
  return pruneUnheld({
    label: "PHP series",
    keyOf: phpSeriesHoldKey,
    findUnused: async () => {
      const input = await deps.gather();
      return input === null ? null : unusedPhpSeries(input);
    },
    remove: deps.remove,
  });
}

/** Test seam: forget holds and a running prune between cases. */
export { resetPruneHoldsForTests as resetPhpSeriesPruneForTests } from "./prune-holds.ts";
