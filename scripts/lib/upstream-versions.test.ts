import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  APACHE_APR,
  APACHE_HTTPD,
  checkLsphp,
  checkSury,
  compareVersions,
  type DebPackage,
  type Finding,
  LSPHP_REPO,
  lsphpIndexes,
  lsphpSeriesOf,
  newerThanPin,
  newestVersion,
  NGINX_POOL,
  OPENLITESPEED_RELEASES,
  parseGithubReleases,
  parseNginxPool,
  parsePackages,
  parseTarballIndex,
  pinnedLsphpDebs,
  type Pins,
  readPins,
  renderReport,
  SURY_REPO,
  suryPackagesFor,
  upstreamVersion,
  watchUpstream,
} from "./upstream-versions.ts";

const orchestration = new URL("../../orchestration/", import.meta.url);
const readRepo = (path: string) =>
  Deno.readTextFile(new URL(path, orchestration));

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

/** Small pin set: PHP 8.4 and 8.5 on trixie, lsphp 8.4 pinned for amd64. */
const PINS: Pins = {
  lsphpSeries: {
    "8.4": { version: "8.4.25", pkg: "lsphp84" },
    "8.5": { version: "8.5.11", pkg: "lsphp85" },
  },
  lsphpDebs: {
    "lsphp84_8.4.25-1+trixie_amd64.deb": SHA_A,
    "lsphp84-common_8.4.25-1+trixie_all.deb": SHA_B,
  },
  suiteSeries: { trixie: ["8.4", "8.5"] },
  registrySeries: ["8.4", "8.5"],
  baselineExtensions: ["curl", "opcache"],
  builtinExtensions: { "8.5": ["opcache"] },
  nginxVersion: "1.28.3",
  nginxDist: "bookworm",
  openlitespeedVersion: "1.9.1",
  httpdVersion: "2.4.63",
  aprVersion: "1.7.5",
  aprUtilVersion: "1.6.3",
};

function stanza(
  name: string,
  version: string,
  arch: string,
  sha = SHA_A,
  suite = "trixie",
): string {
  return [
    `Package: ${name}`,
    `Source: php`,
    `Version: ${version}`,
    `Architecture: ${arch}`,
    `Depends: libc6 (>= 2.38),`,
    ` zlib1g (>= 1:1.1.4)`,
    `Filename: pool/main/${suite}/${name}_${version}_${arch}.deb`,
    `SHA256: ${sha.toUpperCase()}`,
  ].join("\n");
}

function deb(
  name: string,
  version: string,
  arch: string,
  sha = SHA_A,
): DebPackage {
  return parsePackages(stanza(name, version, arch, sha))[0];
}

const levels = (findings: Finding[]) =>
  findings.map((finding) => finding.level);

Deno.test("readPins reads the real registry and role defaults", async () => {
  const pins = readPins({
    registryJson: await readRepo("runtime-registry.json"),
    openlitespeedDefaults: await readRepo(
      "roles/openlitespeed/defaults/main.yml",
    ),
    nginxDefaults: await readRepo("roles/nginx/defaults/main.yml"),
    apacheDefaults: await readRepo("roles/apache/defaults/main.yml"),
  });
  assert(pins.registrySeries.includes("8.4"));
  assert(pins.suiteSeries.trixie.includes("8.4"));
  assert(pins.baselineExtensions.includes("opcache"));
  assertEquals(pins.builtinExtensions["8.5"], ["opcache"]);
  assertEquals(pins.lsphpSeries["8.4"].pkg, "lsphp84");
  assert(/^\d+\.\d+\.\d+$/.test(pins.nginxVersion));
  assertEquals(pins.nginxDist, "bookworm");
  assert(/^\d+(\.\d+)+$/.test(pins.openlitespeedVersion));
  assert(/^\d+\.\d+\.\d+$/.test(pins.httpdVersion));
  // Every pinned .deb name must carry a suite and an architecture.
  const debs = pinnedLsphpDebs(pins);
  assert(debs.length > 0);
  for (const pinned of debs) {
    assert(["amd64", "arm64", "all"].includes(pinned.arch), pinned.file);
  }
  const suites = new Set(lsphpIndexes(pins).map((index) => index.suite));
  assert(suites.has("trixie"));
});

Deno.test("readPins rejects a defaults file without a version pin", () => {
  assertThrows(
    () =>
      readPins({
        registryJson: JSON.stringify({ runtimes: { php: { series: {} } } }),
        openlitespeedDefaults: "openlitespeed_version: '1.9.1'\n",
        nginxDefaults: "nginx_deb_dist: bookworm\n",
        apacheDefaults: "apache_version: '2.4.63'\n",
      }),
    Error,
    "nginx_version",
  );
});

Deno.test("readPins tolerates missing optional registry and role fields", () => {
  const pins = readPins({
    registryJson: JSON.stringify({
      runtimes: { php: { series: { "8.4": {} } } },
    }),
    openlitespeedDefaults: "openlitespeed_version: '1.9.1'\n" +
      "openlitespeed_lsphp_series_map:\n  '8.4': {}\n",
    nginxDefaults: "nginx_version: 1.28.3\nnginx_deb_dist: bookworm\n",
    apacheDefaults: "apache_version: 2.4.63\napache_apr_version: 1.7.5\n" +
      "apache_apr_util_version: 1.6.3\n",
  });
  assertEquals(pins.suiteSeries, {});
  assertEquals(pins.baselineExtensions, []);
  assertEquals(pins.builtinExtensions, {});
  assertEquals(pins.lsphpDebs, {});
  assertEquals(pins.lsphpSeries["8.4"], { version: "", pkg: "" });
});

Deno.test("compareVersions compares numerically, segment by segment", () => {
  assertEquals(compareVersions("1.9.0.1", "1.9.1"), -1);
  assertEquals(compareVersions("8.10", "8.9"), 1);
  assertEquals(compareVersions("1.9", "1.9.0"), 0);
  assertEquals(newestVersion(["1.7.6", "1.6.5", "1.7.10"]), "1.7.10");
  assertEquals(newestVersion([]), undefined);
});

Deno.test("upstreamVersion drops the epoch and Debian revision", () => {
  assertEquals(upstreamVersion("8.5.11-1+trixie"), "8.5.11");
  assertEquals(upstreamVersion("1:2.4.63-1"), "2.4.63");
  assertEquals(upstreamVersion("1.9.1"), "1.9.1");
});

Deno.test("parsePackages reads stanzas and skips continuation lines", () => {
  const text = `${stanza("lsphp84", "8.4.25-1+trixie", "amd64")}\n\n` +
    `${stanza("lsphp84-common", "8.4.25-1+trixie", "all", SHA_B)}\n\n` +
    "Description: no package field here\n\n";
  const packages = parsePackages(text);
  assertEquals(packages.length, 2);
  assertEquals(packages[0], {
    name: "lsphp84",
    version: "8.4.25-1+trixie",
    architecture: "amd64",
    file: "lsphp84_8.4.25-1+trixie_amd64.deb",
    sha256: SHA_A,
  });
  assertEquals(packages[1].architecture, "all");
  assertEquals(parsePackages("Package: bare\nnot a field\n")[0], {
    name: "bare",
    version: "",
    architecture: "",
    file: "",
    sha256: "",
  });
});

Deno.test("pinnedLsphpDebs refuses a file name without suite and arch", () => {
  assertThrows(
    () => pinnedLsphpDebs({ ...PINS, lsphpDebs: { "lsphp84.deb": SHA_A } }),
    Error,
    "lsphp84.deb",
  );
});

Deno.test("lsphpIndexes lists each suite/arch once and skips arch-all files", () => {
  const pins: Pins = {
    ...PINS,
    lsphpDebs: {
      ...PINS.lsphpDebs,
      "lsphp84_8.4.25-1+trixie_arm64.deb": SHA_A,
      "lsphp84_8.4.25-1+bookworm_amd64.deb": SHA_A,
      "lsphp84-curl_8.4.25-1+trixie_amd64.deb": SHA_A,
    },
  };
  assertEquals(lsphpIndexes(pins), [
    { suite: "bookworm", arch: "amd64" },
    { suite: "trixie", arch: "amd64" },
    { suite: "trixie", arch: "arm64" },
  ]);
});

Deno.test("lsphpSeriesOf reads base packages only", () => {
  assertEquals(lsphpSeriesOf("lsphp85"), "8.5");
  assertEquals(lsphpSeriesOf("lsphp74"), "7.4");
  assertEquals(lsphpSeriesOf("lsphp85-common"), undefined);
});

Deno.test("checkLsphp: pins present with matching digests are quiet", () => {
  const findings = checkLsphp(PINS, [{
    suite: "trixie",
    arch: "amd64",
    packages: [
      deb("lsphp84", "8.4.25-1+trixie", "amd64"),
      deb("lsphp84-common", "8.4.25-1+trixie", "all", SHA_B),
      deb("lsphp85", "8.5.11-1+trixie", "amd64"),
    ],
  }]);
  assertEquals(findings, []);
});

Deno.test("checkLsphp: a pinned .deb that is gone needs action", () => {
  const findings = checkLsphp(PINS, [{
    suite: "trixie",
    arch: "amd64",
    packages: [
      deb("lsphp84", "8.4.26-1+trixie", "amd64"),
      deb("lsphp84-common", "8.4.25-1+trixie", "all", SHA_B),
    ],
  }]);
  assertEquals(levels(findings), ["action", "info"]);
  assert(findings[0].message.includes("lsphp84_8.4.25-1+trixie_amd64.deb"));
  assert(findings[1].message.includes("8.4.26"));
});

Deno.test("checkLsphp: a changed digest needs action", () => {
  const findings = checkLsphp(PINS, [{
    suite: "trixie",
    arch: "amd64",
    packages: [
      deb("lsphp84", "8.4.25-1+trixie", "amd64", SHA_B),
      deb("lsphp84-common", "8.4.25-1+trixie", "all", SHA_B),
    ],
  }]);
  assertEquals(levels(findings), ["action"]);
  assert(findings[0].message.includes("different sha256"));
});

Deno.test("checkLsphp: suites we did not fetch are not reported as gone", () => {
  const pins: Pins = {
    ...PINS,
    lsphpDebs: { "lsphp84_8.4.25-1+bookworm_amd64.deb": SHA_A },
  };
  assertEquals(checkLsphp(pins, []), []);
});

Deno.test("checkLsphp: a new series is action, older unoffered ones are not", () => {
  const pins: Pins = { ...PINS, lsphpDebs: {} };
  const findings = checkLsphp(pins, [{
    suite: "bookworm",
    arch: "amd64",
    packages: [
      deb("lsphp74", "7.4.33-1+bookworm", "amd64"),
      deb("lsphp80", "8.0.30-1+bookworm", "amd64"),
      deb("lsphp84", "8.4.25-1+bookworm", "amd64"),
      deb("lsphp86", "8.6.0-1+bookworm", "amd64"),
    ],
  }]);
  assertEquals(levels(findings), ["action"]);
  assert(findings[0].message.includes("PHP 8.6"));
  assert(findings[0].message.includes("bookworm"));
});

Deno.test("suryPackagesFor leaves out compiled-in extensions", () => {
  assertEquals(suryPackagesFor(PINS, "8.4"), [
    "php8.4-fpm",
    "php8.4-cli",
    "php8.4-cgi",
    "php8.4-curl",
    "php8.4-opcache",
  ]);
  assertEquals(suryPackagesFor(PINS, "8.5"), [
    "php8.5-fpm",
    "php8.5-cli",
    "php8.5-cgi",
    "php8.5-curl",
  ]);
});

Deno.test("checkSury: missing packages for an offered series need action", () => {
  const complete = [
    ...suryPackagesFor(PINS, "8.4"),
    ...suryPackagesFor(PINS, "8.5"),
  ].map((name) => deb(name, "1", "amd64"));
  // sury-only series (8.6) are never reported.
  const extra = deb("php8.6-fpm", "8.6.0~alpha1", "amd64");
  assertEquals(
    checkSury(PINS, [{
      suite: "trixie",
      arch: "amd64",
      packages: [...complete, extra],
    }]),
    [],
  );

  const missing = complete.filter((pkg) =>
    pkg.name !== "php8.5-cgi" && pkg.name !== "php8.5-curl"
  );
  const findings = checkSury(PINS, [
    { suite: "trixie", arch: "arm64", packages: missing },
    { suite: "bookworm", arch: "amd64", packages: [] },
  ]);
  assertEquals(levels(findings), ["action"]);
  assert(findings[0].message.includes("`php8.5-cgi`, `php8.5-curl`"));
  assert(findings[0].message.includes("trixie/arm64"));
});

Deno.test("parseNginxPool keeps stable releases for the pinned dist", () => {
  const html = `
<a href="nginx_1.28.3-1~bookworm_amd64.deb">nginx_1.28.3-1~bookworm_amd64.deb</a>
<a href="nginx_1.28.3-1~bookworm_arm64.deb">nginx_1.28.3-1~bookworm_arm64.deb</a>
<a href="nginx_1.29.4-1~bookworm_amd64.deb">nginx_1.29.4-1~bookworm_amd64.deb</a>
<a href="nginx_1.30.5-1~bookworm_amd64.deb">nginx_1.30.5-1~bookworm_amd64.deb</a>
<a href="nginx_1.32.0-1~trixie_amd64.deb">nginx_1.32.0-1~trixie_amd64.deb</a>
<a href="nginx-dbg_1.34.0-1~bookworm_amd64.deb">nginx-dbg</a>`;
  assertEquals(parseNginxPool(html, "bookworm").sort(), ["1.28.3", "1.30.5"]);
});

Deno.test("parseGithubReleases skips drafts, pre-releases and odd tags", () => {
  const json = JSON.stringify([
    { tag_name: "v1.9.3", draft: false, prerelease: false },
    { tag_name: "v1.9.4", draft: true, prerelease: false },
    { tag_name: "v2.0.0", draft: false, prerelease: true },
    { tag_name: "v1.9.0.1", draft: false, prerelease: false },
    { tag_name: "nightly", draft: false, prerelease: false },
    { draft: false, prerelease: false },
  ]);
  assertEquals(parseGithubReleases(json), ["1.9.3", "1.9.0.1"]);
});

Deno.test("parseTarballIndex tells apr from apr-util and skips signatures", () => {
  const html = `
<a href="apr-1.6.5.tar.gz">apr-1.6.5.tar.gz</a>
<a href="apr-1.7.6.tar.gz">apr-1.7.6.tar.gz</a>
<a href="apr-1.7.6.tar.gz.asc">apr-1.7.6.tar.gz.asc</a>
<a href="apr-1.7.7.tar.bz2">apr-1.7.7.tar.bz2</a>
<a href="apr-util-1.6.5.tar.gz">apr-util-1.6.5.tar.gz</a>`;
  assertEquals(parseTarballIndex(html, "apr").sort(), ["1.6.5", "1.7.6"]);
  assertEquals(parseTarballIndex(html, "apr-util"), ["1.6.5"]);
});

Deno.test("newerThanPin reports only a strictly newer version", () => {
  assertEquals(newerThanPin("nginx", "nginx stable", "1.28.3", ["1.28.3"]), []);
  assertEquals(newerThanPin("nginx", "nginx stable", "1.28.3", []), []);
  assertEquals(
    newerThanPin("Apache", "httpd", "2.4.63", ["2.4.62", "2.4.69"]),
    [{
      level: "info",
      area: "Apache",
      message: "httpd 2.4.69 is out; we pin 2.4.63.",
    }],
  );
});

/** Fake upstreams keyed by URL; anything else throws like a failed fetch. */
function fakeUpstream(pages: Record<string, string>) {
  const requested: string[] = [];
  const fetchText = (url: string) => {
    requested.push(url);
    const page = pages[url];
    return page === undefined
      ? Promise.reject(new Error(`${url}: HTTP 404`))
      : Promise.resolve(page);
  };
  return { fetchText, requested };
}

const packagesUrl = (base: string, suite: string, arch: string) =>
  `${base}/dists/${suite}/main/binary-${arch}/Packages.gz`;

Deno.test("watchUpstream runs every check against the fetched pages", async () => {
  const lsphp = [
    stanza("lsphp84", "8.4.25-1+trixie", "amd64"),
    stanza("lsphp84-common", "8.4.25-1+trixie", "all", SHA_B),
    stanza("lsphp85", "8.5.12-1+trixie", "amd64"),
  ].join("\n\n");
  const sury = [
    ...suryPackagesFor(PINS, "8.4"),
    ...suryPackagesFor(PINS, "8.5"),
  ]
    .map((name) => `Package: ${name}\nVersion: 1\n`)
    .join("\n");
  const { fetchText, requested } = fakeUpstream({
    [packagesUrl(LSPHP_REPO, "trixie", "amd64")]: lsphp,
    [packagesUrl(SURY_REPO, "trixie", "amd64")]: sury,
    [NGINX_POOL]: `<a href="nginx_1.30.5-1~bookworm_amd64.deb">x</a>`,
    [OPENLITESPEED_RELEASES]: JSON.stringify([{ tag_name: "v1.9.1" }]),
    [APACHE_HTTPD]: `<a href="httpd-2.4.69.tar.gz">httpd-2.4.69.tar.gz</a>`,
    [APACHE_APR]:
      `<a href="apr-1.7.5.tar.gz">x</a> <a href="apr-util-1.6.5.tar.gz">x</a>`,
  });
  const result = await watchUpstream(PINS, fetchText);
  assertEquals(result.failures, []);
  assertEquals(
    result.findings.map((finding) => `${finding.level} ${finding.area}`),
    [
      "info lsphp (LiteSpeed)",
      "info nginx",
      "info Apache",
      "info Apache",
    ],
  );
  assertEquals(requested.length, 6);
});

Deno.test("watchUpstream records an unreadable upstream and keeps going", async () => {
  const { fetchText } = fakeUpstream({
    [OPENLITESPEED_RELEASES]: JSON.stringify([{ tag_name: "v1.9.3" }]),
  });
  const result = await watchUpstream(PINS, fetchText);
  assertEquals(
    result.failures.map((failure) => failure.source),
    [
      "LiteSpeed lsphp package lists",
      "sury PHP package lists",
      "nginx.org package pool",
      "downloads.apache.org",
    ],
  );
  assert(result.failures[0].error.includes("HTTP 404"));
  assertEquals(levels(result.findings), ["info"]);

  const thrown = await watchUpstream(
    PINS,
    () => Promise.reject("plain string"),
  );
  assertEquals(thrown.failures[0].error, "plain string");
});

Deno.test("renderReport groups findings and lists sources it could not read", () => {
  const quiet = renderReport({ findings: [], failures: [] }, "2026-10-07");
  assert(quiet.includes("Checked on 2026-10-07"));
  assert(quiet.includes("Nothing needs action."));
  assert(quiet.includes("Nothing new."));
  assert(!quiet.includes("Could not check"));

  const busy = renderReport({
    findings: [
      { level: "action", area: "php-fpm (sury)", message: "gone" },
      { level: "info", area: "nginx", message: "newer" },
    ],
    failures: [{ source: "nginx.org package pool", error: "HTTP 500" }],
  }, "2026-10-07");
  assert(busy.includes("## Action needed\n\n- **php-fpm (sury)**: gone"));
  assert(busy.includes("## Information only\n\n- **nginx**: newer"));
  assert(
    busy.includes(
      "## Could not check\n\n- **nginx.org package pool**: HTTP 500",
    ),
  );
});
