/**
 * Upstream version watch: compares what we pin (PHP per OS suite, lsphp
 * packages, nginx, OpenLiteSpeed, Apache httpd/APR/APR-util) with what the
 * upstream repositories publish today, and renders one Markdown report.
 *
 * Pure: every network read goes through the `fetchText` callback the caller
 * passes in (`scripts/check-upstream-versions.ts` in production, fixtures in
 * the tests). Auto-bumping pins is out of scope; the report only says what
 * needs a human.
 */
import { parse as parseYaml } from "yaml";

export type Level = "action" | "info";

export type Finding = Readonly<{ level: Level; area: string; message: string }>;

export type Pins = Readonly<{
  /** lsphp series map from the openlitespeed role: series -> pinned version. */
  lsphpSeries: Readonly<
    Record<string, Readonly<{ version: string; pkg: string }>>
  >;
  /** Pinned lsphp `.deb` file name -> sha256. */
  lsphpDebs: Readonly<Record<string, string>>;
  /** PHP series offered per Debian suite (registry `suiteSeries`). */
  suiteSeries: Readonly<Record<string, readonly string[]>>;
  /** Every PHP series the registry knows. */
  registrySeries: readonly string[];
  baselineExtensions: readonly string[];
  builtinExtensions: Readonly<Record<string, readonly string[]>>;
  nginxVersion: string;
  nginxDist: string;
  openlitespeedVersion: string;
  httpdVersion: string;
  aprVersion: string;
  aprUtilVersion: string;
}>;

export type PinSources = Readonly<{
  registryJson: string;
  openlitespeedDefaults: string;
  nginxDefaults: string;
  apacheDefaults: string;
}>;

type YamlMap = Record<string, unknown>;

function requireString(map: YamlMap, key: string, file: string): string {
  const value = map[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${file}: ${key} is missing or not a string`);
  }
  return value;
}

/** Reads our pins out of the registry JSON and the role defaults YAML. */
export function readPins(sources: PinSources): Pins {
  const registry = JSON.parse(sources.registryJson) as {
    runtimes: {
      php: {
        series: Record<string, unknown>;
        suiteSeries?: Record<string, string[]>;
        baselineExtensions?: string[];
        builtinExtensions?: Record<string, string[]>;
      };
    };
  };
  const php = registry.runtimes.php;
  const ols = parseYaml(sources.openlitespeedDefaults) as YamlMap;
  const nginx = parseYaml(sources.nginxDefaults) as YamlMap;
  const apache = parseYaml(sources.apacheDefaults) as YamlMap;

  const seriesMap = (ols.openlitespeed_lsphp_series_map ?? {}) as Record<
    string,
    { version?: unknown; pkg?: unknown }
  >;
  const lsphpSeries: Record<string, { version: string; pkg: string }> = {};
  for (const [series, entry] of Object.entries(seriesMap)) {
    lsphpSeries[series] = {
      version: String(entry.version ?? ""),
      pkg: String(entry.pkg ?? ""),
    };
  }

  return {
    lsphpSeries,
    lsphpDebs: (ols.openlitespeed_lsphp_sha256 ?? {}) as Record<string, string>,
    suiteSeries: php.suiteSeries ?? {},
    registrySeries: Object.keys(php.series),
    baselineExtensions: php.baselineExtensions ?? [],
    builtinExtensions: php.builtinExtensions ?? {},
    nginxVersion: requireString(nginx, "nginx_version", "nginx defaults"),
    nginxDist: requireString(nginx, "nginx_deb_dist", "nginx defaults"),
    openlitespeedVersion: requireString(
      ols,
      "openlitespeed_version",
      "openlitespeed defaults",
    ),
    httpdVersion: requireString(apache, "apache_version", "apache defaults"),
    aprVersion: requireString(apache, "apache_apr_version", "apache defaults"),
    aprUtilVersion: requireString(
      apache,
      "apache_apr_util_version",
      "apache defaults",
    ),
  };
}

/** Numeric, segment-wise compare (`1.9.0.1` < `1.9.1`, `8.10` > `8.9`). */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** Highest version in `versions`, or `undefined` when the list is empty. */
export function newestVersion(versions: readonly string[]): string | undefined {
  let newest: string | undefined;
  for (const version of versions) {
    if (newest === undefined || compareVersions(version, newest) > 0) {
      newest = version;
    }
  }
  return newest;
}

/** Upstream part of a Debian version: `8.5.11-1+trixie` -> `8.5.11`. */
export function upstreamVersion(debVersion: string): string {
  const withoutEpoch = debVersion.includes(":")
    ? debVersion.slice(debVersion.indexOf(":") + 1)
    : debVersion;
  const dash = withoutEpoch.indexOf("-");
  return dash === -1 ? withoutEpoch : withoutEpoch.slice(0, dash);
}

export type DebPackage = Readonly<{
  name: string;
  version: string;
  architecture: string;
  /** Base name of `Filename:` (the `.deb` file). */
  file: string;
  sha256: string;
}>;

/** Parses a Debian `Packages` index (stanzas separated by blank lines). */
export function parsePackages(text: string): DebPackage[] {
  const packages: DebPackage[] = [];
  for (const stanza of text.split(/\r?\n\s*\r?\n/)) {
    const fields: Record<string, string> = {};
    for (const line of stanza.split(/\r?\n/)) {
      if (line === "" || line.startsWith(" ") || line.startsWith("\t")) {
        continue;
      }
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      fields[line.slice(0, colon)] = line.slice(colon + 1).trim();
    }
    if (!fields.Package) continue;
    const filename = fields.Filename ?? "";
    packages.push({
      name: fields.Package,
      version: fields.Version ?? "",
      architecture: fields.Architecture ?? "",
      file: filename.slice(filename.lastIndexOf("/") + 1),
      sha256: (fields.SHA256 ?? "").toLowerCase(),
    });
  }
  return packages;
}

export type PinnedDeb = Readonly<{
  file: string;
  sha256: string;
  suite: string;
  arch: string;
}>;

const LSPHP_DEB = /^lsphp\d+[a-z0-9-]*_[^_]+\+([a-z]+)_([a-z0-9]+)\.deb$/;

/** Pinned lsphp `.deb` files with the suite and architecture in their names. */
export function pinnedLsphpDebs(pins: Pins): PinnedDeb[] {
  const debs: PinnedDeb[] = [];
  for (const [file, sha256] of Object.entries(pins.lsphpDebs)) {
    const match = LSPHP_DEB.exec(file);
    if (!match) {
      throw new Error(`cannot read suite and architecture from ${file}`);
    }
    debs.push({
      file,
      sha256: sha256.toLowerCase(),
      suite: match[1],
      arch: match[2],
    });
  }
  return debs;
}

/** Suites and architectures our lsphp pins cover (`all` maps to none). */
export function lsphpIndexes(
  pins: Pins,
): { suite: string; arch: string }[] {
  const seen = new Set<string>();
  const indexes: { suite: string; arch: string }[] = [];
  for (const deb of pinnedLsphpDebs(pins)) {
    if (deb.arch === "all") continue;
    const key = `${deb.suite}/${deb.arch}`;
    if (seen.has(key)) continue;
    seen.add(key);
    indexes.push({ suite: deb.suite, arch: deb.arch });
  }
  return indexes.sort((a, b) =>
    `${a.suite}/${a.arch}`.localeCompare(`${b.suite}/${b.arch}`)
  );
}

export type SuiteIndex = Readonly<{
  suite: string;
  arch: string;
  packages: readonly DebPackage[];
}>;

/** `lsphp85` -> `8.5`; `undefined` for anything that is not a base package. */
export function lsphpSeriesOf(name: string): string | undefined {
  const match = /^lsphp(\d)(\d+)$/.exec(name);
  return match ? `${match[1]}.${match[2]}` : undefined;
}

/**
 * Compares LiteSpeed's per-suite package indexes with our lsphp pins.
 *
 * Action needed: a pinned `.deb` is no longer listed (the role would 404), its
 * listed digest differs from ours, or LiteSpeed publishes a series newer than
 * every series we know. Information only: a newer patch release of a series
 * we pin. Older series LiteSpeed still ships (7.4/8.0 on bookworm) are not
 * reported.
 */
export function checkLsphp(
  pins: Pins,
  indexes: readonly SuiteIndex[],
): Finding[] {
  const findings: Finding[] = [];
  const area = "lsphp (LiteSpeed)";
  const byKey = new Map(
    indexes.map((index) => [`${index.suite}/${index.arch}`, index]),
  );

  for (const deb of pinnedLsphpDebs(pins)) {
    const arches = deb.arch === "all"
      ? indexes.filter((index) => index.suite === deb.suite)
      : [byKey.get(`${deb.suite}/${deb.arch}`)].filter((index) =>
        index !== undefined
      );
    if (arches.length === 0) continue;
    const listed = arches
      .flatMap((index) => index.packages)
      .find((pkg) => pkg.file === deb.file);
    if (!listed) {
      findings.push({
        level: "action",
        area,
        message:
          `\`${deb.file}\` is no longer in LiteSpeed's ${deb.suite} package list. ` +
          "New servers cannot install this pin: bump the version and digests.",
      });
    } else if (listed.sha256 && listed.sha256 !== deb.sha256) {
      findings.push({
        level: "action",
        area,
        message:
          `\`${deb.file}\` is listed with a different sha256 than our pin ` +
          `(${listed.sha256}). The role will refuse the download.`,
      });
    }
  }

  const known = newestVersion([
    ...pins.registrySeries,
    ...Object.keys(pins.lsphpSeries),
  ]) ?? "0";
  const suites = [...new Set(indexes.map((index) => index.suite))].sort();
  for (const suite of suites) {
    const packages = indexes
      .filter((index) => index.suite === suite)
      .flatMap((index) => index.packages);
    const published = new Map<string, string[]>();
    for (const pkg of packages) {
      const series = lsphpSeriesOf(pkg.name);
      if (!series) continue;
      published.set(series, [
        ...(published.get(series) ?? []),
        upstreamVersion(pkg.version),
      ]);
    }
    for (
      const [series, versions] of [...published].sort(([a], [b]) =>
        compareVersions(a, b)
      )
    ) {
      const newest = newestVersion(versions) ?? "";
      if (compareVersions(series, known) > 0) {
        findings.push({
          level: "action",
          area,
          message:
            `LiteSpeed publishes a new series, PHP ${series} (lsphp ${newest}), ` +
            `for ${suite}. Decide whether to offer it (registry series, suiteSeries, lsphp pins).`,
        });
        continue;
      }
      const pinned = pins.lsphpSeries[series];
      if (pinned && compareVersions(newest, pinned.version) > 0) {
        findings.push({
          level: "info",
          area,
          message:
            `PHP ${series}: LiteSpeed has ${newest} for ${suite}; we pin ${pinned.version}.`,
        });
      }
    }
  }
  return findings;
}

/** Package names php-fpm needs from sury for one series. */
export function suryPackagesFor(pins: Pins, series: string): string[] {
  const builtin = new Set(pins.builtinExtensions[series] ?? []);
  const extensions = pins.baselineExtensions.filter((ext) => !builtin.has(ext));
  return [
    `php${series}-fpm`,
    `php${series}-cli`,
    `php${series}-cgi`,
    ...extensions.map((ext) => `php${series}-${ext}`),
  ];
}

/**
 * Every PHP series offered for a suite must be installable from sury: fpm,
 * cli, cgi and each baseline extension that is not compiled in. Series only
 * sury publishes are never reported (the offered list follows LiteSpeed).
 */
export function checkSury(
  pins: Pins,
  indexes: readonly SuiteIndex[],
): Finding[] {
  const findings: Finding[] = [];
  for (const index of indexes) {
    const offered = pins.suiteSeries[index.suite] ?? [];
    const names = new Set(index.packages.map((pkg) => pkg.name));
    for (const series of offered) {
      const missing = suryPackagesFor(pins, series).filter((name) =>
        !names.has(name)
      );
      if (missing.length === 0) continue;
      findings.push({
        level: "action",
        area: "php-fpm (sury)",
        message:
          `PHP ${series} on ${index.suite}/${index.arch}: sury does not list ` +
          `${missing.map((name) => `\`${name}\``).join(", ")}. ` +
          "Deploys of this series on nginx or Apache would fail.",
      });
    }
  }
  return findings;
}

/** Stable nginx versions in an nginx.org pool listing for `dist`. */
export function parseNginxPool(html: string, dist: string): string[] {
  const pattern = new RegExp(
    `nginx_(\\d+\\.\\d+\\.\\d+)-\\d+~${dist}_[a-z0-9]+\\.deb`,
    "g",
  );
  const versions = new Set<string>();
  for (const match of html.matchAll(pattern)) {
    // nginx stable lines have an even minor number; odd is mainline.
    if (Number(match[1].split(".")[1]) % 2 === 0) versions.add(match[1]);
  }
  return [...versions];
}

/** Published (not draft, not pre-release) release tags, without a leading `v`. */
export function parseGithubReleases(json: string): string[] {
  const releases = JSON.parse(json) as {
    tag_name?: string;
    draft?: boolean;
    prerelease?: boolean;
  }[];
  return releases
    .filter((release) =>
      !release.draft && !release.prerelease && release.tag_name
    )
    .map((release) => String(release.tag_name).replace(/^v/, ""))
    .filter((tag) => /^\d+(\.\d+)*$/.test(tag));
}

/** Source tarball versions named `<name>-<version>.tar.gz` in an index page. */
export function parseTarballIndex(html: string, name: string): string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(?:^|[^a-z-])${escaped}-(\\d+(?:\\.\\d+)+)\\.tar\\.gz(?![.\\w])`,
    "g",
  );
  return [...new Set([...html.matchAll(pattern)].map((match) => match[1]))];
}

/** One "newer than our pin" informational finding, or none. */
export function newerThanPin(
  area: string,
  label: string,
  pinned: string,
  published: readonly string[],
): Finding[] {
  const newest = newestVersion(published);
  if (newest === undefined || compareVersions(newest, pinned) <= 0) return [];
  return [{
    level: "info",
    area,
    message: `${label} ${newest} is out; we pin ${pinned}.`,
  }];
}

export const LSPHP_REPO = "https://rpms.litespeedtech.com/debian";
export const SURY_REPO = "https://packages.sury.org/php";
export const NGINX_POOL =
  "https://nginx.org/packages/debian/pool/nginx/n/nginx/";
export const OPENLITESPEED_RELEASES =
  "https://api.github.com/repos/litespeedtech/openlitespeed/releases?per_page=30";
export const APACHE_HTTPD = "https://downloads.apache.org/httpd/";
export const APACHE_APR = "https://downloads.apache.org/apr/";

/** Fetches a URL as text (a `.gz` URL is returned decompressed). */
export type FetchText = (url: string) => Promise<string>;

export type Failure = Readonly<{ source: string; error: string }>;

export type WatchResult = Readonly<
  { findings: Finding[]; failures: Failure[] }
>;

/** Debian architectures we pin lsphp for, used for the sury lists too. */
function architectures(pins: Pins): string[] {
  return [...new Set(lsphpIndexes(pins).map((index) => index.arch))].sort();
}

/** Runs every check; a source that cannot be read is a failure, not a crash. */
export async function watchUpstream(
  pins: Pins,
  fetchText: FetchText,
): Promise<WatchResult> {
  const findings: Finding[] = [];
  const failures: Failure[] = [];

  async function attempt(source: string, run: () => Promise<Finding[]>) {
    try {
      findings.push(...await run());
    } catch (error) {
      failures.push({
        source,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function packagesFor(
    base: string,
    suite: string,
    arch: string,
  ): Promise<SuiteIndex> {
    const text = await fetchText(
      `${base}/dists/${suite}/main/binary-${arch}/Packages.gz`,
    );
    return { suite, arch, packages: parsePackages(text) };
  }

  await attempt("LiteSpeed lsphp package lists", async () => {
    const indexes = await Promise.all(
      lsphpIndexes(pins).map(({ suite, arch }) =>
        packagesFor(LSPHP_REPO, suite, arch)
      ),
    );
    return checkLsphp(pins, indexes);
  });

  await attempt("sury PHP package lists", async () => {
    const arches = architectures(pins);
    const indexes = await Promise.all(
      Object.keys(pins.suiteSeries).sort().flatMap((suite) =>
        arches.map((arch) => packagesFor(SURY_REPO, suite, arch))
      ),
    );
    return checkSury(pins, indexes);
  });

  await attempt("nginx.org package pool", async () =>
    newerThanPin(
      "nginx",
      "nginx stable",
      pins.nginxVersion,
      parseNginxPool(await fetchText(NGINX_POOL), pins.nginxDist),
    ));

  await attempt("OpenLiteSpeed releases", async () =>
    newerThanPin(
      "OpenLiteSpeed",
      "OpenLiteSpeed",
      pins.openlitespeedVersion,
      parseGithubReleases(await fetchText(OPENLITESPEED_RELEASES)),
    ));

  await attempt("downloads.apache.org", async () => {
    const httpd = await fetchText(APACHE_HTTPD);
    const apr = await fetchText(APACHE_APR);
    return [
      ...newerThanPin(
        "Apache",
        "httpd",
        pins.httpdVersion,
        parseTarballIndex(httpd, "httpd"),
      ),
      ...newerThanPin(
        "Apache",
        "APR",
        pins.aprVersion,
        parseTarballIndex(apr, "apr"),
      ),
      ...newerThanPin(
        "Apache",
        "APR-util",
        pins.aprUtilVersion,
        parseTarballIndex(apr, "apr-util"),
      ),
    ];
  });

  return { findings, failures };
}

export const ISSUE_TITLE = "Upstream versions to review";

function section(
  title: string,
  lines: readonly string[],
  empty: string,
): string {
  return `## ${title}\n\n${lines.length === 0 ? empty : lines.join("\n")}\n`;
}

/** The tracking issue body. */
export function renderReport(result: WatchResult, checkedOn: string): string {
  const line = (finding: Finding) =>
    `- **${finding.area}**: ${finding.message}`;
  const action = result.findings.filter((finding) =>
    finding.level === "action"
  );
  const info = result.findings.filter((finding) => finding.level === "info");
  const parts = [
    `Checked on ${checkedOn} by the Upstream Version Watch workflow, which rewrites ` +
    "this issue every week. Nothing here is changed automatically: pins are bumped by hand.\n",
    section(
      "Action needed",
      action.map(line),
      "Nothing needs action.",
    ),
    section("Information only", info.map(line), "Nothing new."),
  ];
  if (result.failures.length > 0) {
    parts.push(
      section(
        "Could not check",
        result.failures.map((failure) =>
          `- **${failure.source}**: ${failure.error}`
        ),
        "",
      ),
    );
  }
  return parts.join("\n");
}
