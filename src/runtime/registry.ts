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

export type RuntimeName = "php" | "node" | "deno";

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
  /** Series offered per Debian/Ubuntu suite (`VERSION_CODENAME`). PHP only. */
  suiteSeries?: Readonly<Record<string, readonly string[]>>;
  /** Extensions compiled into a series, so no package exists for them. */
  builtinExtensions?: Readonly<Record<string, readonly string[]>>;
}>;

const RUNTIMES = registryJson.runtimes as unknown as Readonly<
  Record<RuntimeName, RuntimeEntry>
>;

/**
 * Access groups the registry defines. `sftp` / `shell` are levels (`none`
 * holds no group); `password` is an additive credential group — its Match
 * block turns `PasswordAuthentication` on for members and rides alongside a
 * level group, never instead of one. `principal` is held by every principal
 * whatever its level, so the drop-in's backstop block also covers an account
 * with no SSH access at all.
 */
export type PrincipalAccessGroupLevel =
  | "sftp"
  | "shell"
  | "password"
  | "principal";

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
  (Object.keys(RUNTIMES) as RuntimeName[]).sort((a, b) => a.localeCompare(b)),
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

/**
 * PHP series offered on a host whose `VERSION_CODENAME` is `codename`.
 *
 * The table mirrors what LiteSpeed's repository publishes per suite and is the
 * same list for every engine (lsphp and php-fpm), so hosting is at parity
 * across engines and server versions. A suite the table does not list (or an
 * unreadable codename) gets every series the registry knows rather than none:
 * the roles then fail with their own clear message if a pin is missing.
 */
export function phpSeriesForSuite(
  codename: string | undefined,
): readonly string[] {
  const listed = codename
    ? RUNTIMES.php.suiteSeries?.[codename.trim().toLowerCase()]
    : undefined;
  return listed ? [...listed] : supportedSeries("php");
}

/**
 * Clear error for a PHP series the host's OS does not offer, or `undefined`
 * when it does. Checked before any playbook runs, like
 * {@link unsupportedSeriesMessage}.
 */
export function unsupportedPhpSeriesMessage(
  version: string,
  codename: string | undefined,
): string | undefined {
  const series = entitlementSeries("php", version);
  const offered = phpSeriesForSuite(codename);
  if (offered.includes(series) && runtimeGroup("php", series)) return undefined;
  return `php ${version} is not offered on this server's operating system. Offered series: ${
    offered.join(", ")
  }.`;
}

/** Extensions compiled into a PHP series (no package to install for them). */
export function phpBuiltinExtensions(series: string): readonly string[] {
  return RUNTIMES.php.builtinExtensions?.[series] ?? [];
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

/**
 * Clear error for a requested series this host does not offer, or `undefined`
 * when it is supported. Checked before any playbook runs: an unknown series
 * has no entitlement group, so the playbook would otherwise die with only
 * "ansible-playbook failed".
 */
export function unsupportedSeriesMessage(
  runtime: RuntimeName,
  version: string,
): string | undefined {
  if (runtimeGroup(runtime, version)) return undefined;
  return `${runtime} ${version} is not a supported ${runtime} version on this server. Supported series: ${
    supportedSeries(runtime).join(", ")
  }.`;
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
 * in here, so the user's own group, `tp`, an engine group, and anything an operator
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
