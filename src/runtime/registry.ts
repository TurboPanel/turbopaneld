/**
 * Runtime entitlement registry — the daemon's view of
 * `orchestration/runtime-registry.json`.
 *
 * The JSON is imported rather than re-declared so the daemon and Ansible read
 * the same bytes. Anything derived from it (group names, gids, binary paths,
 * unit names) belongs here, not scattered across call sites the way
 * `NATIVE_APP_RUNTIME_GROUP` used to be.
 *
 * **Why per-(runtime, series) groups.** A group means "this principal may
 * execute this runtime series". Co-installed PHP versions are distinct
 * binaries, so one `tpphp` group would mean granting 8.4 also grants 8.3 —
 * including whatever CVEs another tenant's pinned app is carrying. It is also
 * what lets a shell wrapper resolve a caller's series from its group list.
 */

import registryJson from "../../orchestration/runtime-registry.json" with {
  type: "json",
};

export type RuntimeName = "php" | "node";

export type RuntimeSeriesEntry = Readonly<{
  /** Unix group whose only meaning is "may exec this runtime series". */
  group: string;
  gid: number;
}>;

type RuntimeEntry = Readonly<{
  seriesKey: string;
  default: string;
  series: Readonly<Record<string, RuntimeSeriesEntry>>;
  baselineExtensions?: readonly string[];
  optionalExtensions?: readonly string[];
}>;

const RUNTIMES = registryJson.runtimes as unknown as Readonly<
  Record<RuntimeName, RuntimeEntry>
>;

/** Access levels that correspond to a unix group. `none` holds no group. */
export type PrincipalAccessGroupLevel = "sftp" | "shell";

const ACCESS_GROUPS = registryJson.accessGroups as unknown as Readonly<
  Record<PrincipalAccessGroupLevel, RuntimeSeriesEntry>
>;

/**
 * Group that puts a principal in one `sshd` Match block.
 *
 * Not an entitlement group: it protects no inode and grants no `execve`. It
 * exists because `sshd` matches on groups rather than on shells, so
 * `ForceCommand internal-sftp` needs a group of its own to hang from.
 */
export function accessGroup(
  level: PrincipalAccessGroupLevel,
): string | undefined {
  return ACCESS_GROUPS[level]?.group;
}

/** Every SSH access group the registry defines. */
export function allAccessGroups(): ReadonlySet<string> {
  return new Set(Object.values(ACCESS_GROUPS).map((entry) => entry.group));
}

export const RUNTIME_GID_BAND = Object.freeze({
  min: registryJson.gidBand.min,
  max: registryJson.gidBand.max,
});

/** Runtime names the registry knows, sorted. */
export const RUNTIME_NAMES: readonly RuntimeName[] = Object.freeze(
  Object.keys(RUNTIMES).sort() as RuntimeName[],
);

export function isRuntimeName(value: string): value is RuntimeName {
  return Object.hasOwn(RUNTIMES, value);
}

/**
 * Normalize a version to the **exec boundary**, which is what a group protects.
 *
 * `php 8.4.3 -> 8.4`, `node 24.17.0 -> 24`. Compose accepts three-component
 * Node pins, so without this the group set would grow one entry per patch.
 */
export function entitlementSeries(
  runtime: RuntimeName,
  version: string,
): string {
  const parts = version.trim().split(".");
  const take = RUNTIMES[runtime].seriesKey === "major" ? 1 : 2;
  return parts.slice(0, take).join(".");
}

/** Series this host is willing to run, sorted. */
export function supportedSeries(runtime: RuntimeName): readonly string[] {
  return Object.keys(RUNTIMES[runtime].series).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );
}

export function defaultSeries(runtime: RuntimeName): string {
  return RUNTIMES[runtime].default;
}

/**
 * Entitlement group for one runtime series, or `undefined` when the series is
 * not in the registry. Callers treat `undefined` as "not supported here" rather
 * than inventing a group name — an invented name would `usermod -aG` a group
 * that does not exist and fail at a confusing distance from the cause.
 */
export function runtimeGroup(
  runtime: RuntimeName,
  version: string,
): string | undefined {
  return RUNTIMES[runtime].series[entitlementSeries(runtime, version)]?.group;
}

export function runtimeGid(
  runtime: RuntimeName,
  version: string,
): number | undefined {
  return RUNTIMES[runtime].series[entitlementSeries(runtime, version)]?.gid;
}

/**
 * Every entitlement group the registry defines.
 *
 * Not the containment set for revocation on its own — {@link allManagedGroups}
 * is, and it has to be, because SSH access is reconciled in the same pass.
 */
export function allRuntimeGroups(): ReadonlySet<string> {
  const groups = new Set<string>();
  for (const runtime of RUNTIME_NAMES) {
    for (const entry of Object.values(RUNTIMES[runtime].series)) {
      groups.add(entry.group);
    }
  }
  return groups;
}

/**
 * Every group TurboPanel reconciles on a principal — runtime entitlements plus
 * SSH access.
 *
 * **This is the containment set for revocation**, and it must be exactly one
 * set. `ensurePrincipalManagedGroups` removes stale membership only for names
 * in here, so `<username>-grp`, `tp`, an engine group, and anything an operator
 * added by hand survive untouched. Two sets would mean two containment rules,
 * and a principal downgraded from shell to files-only would keep `tpshell`
 * because the entitlement pass did not recognize it.
 */
export function allManagedGroups(): ReadonlySet<string> {
  return new Set([...allRuntimeGroups(), ...allAccessGroups()]);
}

/** Extensions installed on every series, whether or not a site asked. */
export function baselineExtensions(runtime: RuntimeName): readonly string[] {
  return RUNTIMES[runtime].baselineExtensions ?? [];
}

/**
 * Extensions a site may opt into.
 *
 * A closed list because the name becomes an apt package name and an `.ini`
 * filename, and some extensions change a pool's security model. Requests
 * resolve by **union** across every site on a series — `extension=` is
 * `PHP_INI_SYSTEM` and there is no per-pool loading — so an operator opting in
 * loads it for every other site on that series too.
 */
export function optionalExtensions(runtime: RuntimeName): readonly string[] {
  return RUNTIMES[runtime].optionalExtensions ?? [];
}

/** Extension names allowed for a runtime: baseline plus opt-in. */
export function isAllowedExtension(
  runtime: RuntimeName,
  name: string,
): boolean {
  return baselineExtensions(runtime).includes(name) ||
    optionalExtensions(runtime).includes(name);
}

/** php-fpm master and CLI for a series — sury installs both under /usr. */
export function phpBinaryPaths(series: string): { fpm: string; cli: string } {
  return { fpm: `/usr/sbin/php-fpm${series}`, cli: `/usr/bin/php${series}` };
}

/** systemd instance that owns one PHP series' FPM master. */
export function phpFpmUnit(series: string): string {
  return `turbopanel-php-fpm@${series}`;
}
