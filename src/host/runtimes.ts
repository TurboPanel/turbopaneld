/**
 * Runtimes actually installed on this host, for hello + change-detected
 * heartbeat.
 *
 * Reported over the **presence channel**, not a new command. Commands are a
 * downward rail with no request/response shape, so a `server.inventory` command
 * would mean inventing correlation, a scheduler, and a staleness policy. The
 * presence snapshot already has all three: it is change-detected, sent on hello
 * and on change, and carries `docker` the same way.
 *
 * Each area is omitted entirely when nothing is found, matching `docker.ts`, so
 * a host with no PHP reports no `php` key rather than an empty one. Probes read
 * the filesystem rather than forking where possible — `collectPresenceSnapshot`
 * runs on every idle tick.
 */

import { readEnv, resolveRuntimesDir } from "../paths/layout.ts";

/** Re-exported so the registry's band stays one definition. */
export { RUNTIME_GID_BAND as RUNTIME_ENTITLEMENT_GID_BAND } from "../runtime/registry.ts";

export type HostRuntimeMetadata = {
  /** php-fpm series installed from sury, e.g. `["8.3", "8.4"]`. */
  php?: { series: string[]; extensions?: Record<string, string[]> };
  /** Vendored tenant Node series (`vendor/node-app/<series>/current`). */
  node?: { series: string[] };
  /** Vendored OpenLiteSpeed LSAPI PHP series (`vendor/lsphp/<series>/current`). */
  lsphp?: { series: string[] };
};

/** `8.4` or `24` — the exec boundary, matching the registry's series shape. */
const SERIES_RE = /^\d{1,3}(\.\d{1,3})?$/;
const EXTENSION_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_SERIES = 16;
const MAX_EXTENSIONS = 128;

function readDirNames(path: string): string[] {
  try {
    const names: string[] = [];
    for (const entry of Deno.readDirSync(path)) names.push(entry.name);
    return names;
  } catch {
    return [];
  }
}

function pathExists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

function sortSeries(values: Iterable<string>): string[] {
  return [...new Set(values)]
    .filter((value) => SERIES_RE.test(value))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .slice(0, MAX_SERIES);
}

/**
 * PHP series installed by the sury packages, read from the binaries themselves.
 *
 * `/usr/sbin/php-fpm<series>` is the thing that has to exist for a master to
 * start, so it is the honest signal — more so than the config tree, which the
 * role could have written before an apt failure.
 *
 * Exported for fixture tests.
 */
export function parsePhpSeriesFromBinaries(names: readonly string[]): string[] {
  const series: string[] = [];
  for (const name of names) {
    const match = /^php-fpm(\d{1,3}\.\d{1,3})$/.exec(name);
    if (match?.[1]) series.push(match[1]);
  }
  return sortSeries(series);
}

/**
 * Extensions registered for one series.
 *
 * Read from `mods-available` (a cheap readdir) rather than `php<series> -m`
 * (a fork per series). The two can differ: `mods-available` lists what is
 * *installed*, while `-m` lists what is *loaded* for a SAPI. Installed is the
 * right question here — the control plane wants to know what it can offer.
 */
export function parsePhpExtensionsFromModsAvailable(
  names: readonly string[],
): string[] {
  const extensions: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".ini")) continue;
    const base = name.slice(0, -4).toLowerCase();
    if (EXTENSION_RE.test(base)) extensions.push(base);
  }
  return [...new Set(extensions)]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_EXTENSIONS);
}

/** Vendored series directories that actually resolved a `current` symlink. */
function vendoredSeries(root: string): string[] {
  return sortSeries(
    readDirNames(root).filter((name) =>
      SERIES_RE.test(name) && pathExists(`${root}/${name}/current`)
    ),
  );
}

export function readHostRuntimes(
  vendorDir?: string,
): HostRuntimeMetadata | undefined {
  const resolvedVendorDir = vendorDir ?? resolveRuntimesDir({
    TURBOPANEL_RUNTIMES_DIR: readEnv("TURBOPANEL_RUNTIMES_DIR"),
  });
  const meta: HostRuntimeMetadata = {};

  const phpSeries = parsePhpSeriesFromBinaries(readDirNames("/usr/sbin"));
  if (phpSeries.length > 0) {
    const extensions: Record<string, string[]> = {};
    for (const series of phpSeries) {
      const found = parsePhpExtensionsFromModsAvailable(
        readDirNames(`/etc/php/${series}/mods-available`),
      );
      if (found.length > 0) extensions[series] = found;
    }
    meta.php = {
      series: phpSeries,
      ...(Object.keys(extensions).length > 0 ? { extensions } : {}),
    };
  }

  const nodeSeries = vendoredSeries(`${resolvedVendorDir}/node-app`);
  if (nodeSeries.length > 0) meta.node = { series: nodeSeries };

  const lsphpSeries = vendoredSeries(`${resolvedVendorDir}/lsphp`);
  if (lsphpSeries.length > 0) meta.lsphp = { series: lsphpSeries };

  return Object.keys(meta).length > 0 ? meta : undefined;
}
