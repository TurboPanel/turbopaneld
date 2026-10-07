import { assert, assertEquals } from "@std/assert";
import { parse } from "yaml";
import registryJson from "../../orchestration/runtime-registry.json" with {
  type: "json",
};

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

type LsphpSeries = {
  version: string;
  pkg: string;
  packages: string[];
  arch_all: string[];
};
type Defaults = {
  openlitespeed_lsphp_deb_revision: string;
  openlitespeed_lsphp_series_map: Record<string, LsphpSeries>;
  openlitespeed_lsphp_sha256: Record<string, string>;
  openlitespeed_lsphp_runtime_packages: Record<string, string[]>;
};

const defaults = parse(
  await Deno.readTextFile(
    new URL(
      "../../orchestration/roles/openlitespeed/defaults/main.yml",
      import.meta.url,
    ),
  ),
) as Defaults;
const php = registryJson.runtimes.php as {
  series: Record<string, unknown>;
  suiteSeries: Record<string, string[]>;
  builtinExtensions: Record<string, string[]>;
};

/** The `.deb` file names the lsphp role downloads for one series on one suite. */
function lsphpDebs(series: string, suite: string, arch: string): string[] {
  const entry = defaults.openlitespeed_lsphp_series_map[series];
  const stem =
    `${entry.version}-${defaults.openlitespeed_lsphp_deb_revision}+${suite}`;
  return [
    ...entry.packages.filter((pkg) => !entry.arch_all.includes(pkg))
      .map((pkg) => `${pkg}_${stem}_${arch}.deb`),
    ...entry.arch_all.map((pkg) => `${pkg}_${stem}_all.deb`),
  ];
}

test("every series a suite offers has pinned, digested lsphp packages on that suite", () => {
  for (const [suite, series] of Object.entries(php.suiteSeries)) {
    assert(
      suite in defaults.openlitespeed_lsphp_runtime_packages,
      `no lsphp runtime libraries listed for ${suite}`,
    );
    for (const entry of series) {
      assert(
        entry in php.series,
        `${suite} lists ${entry}, not in the registry`,
      );
      assert(
        entry in defaults.openlitespeed_lsphp_series_map,
        `${suite} offers PHP ${entry}, but the lsphp role has no pin for it`,
      );
      for (const arch of ["amd64", "arm64"]) {
        for (const deb of lsphpDebs(entry, suite, arch)) {
          assert(
            /^[0-9a-f]{64}$/.test(
              defaults.openlitespeed_lsphp_sha256[deb] ?? "",
            ),
            `no sha256 for ${deb}`,
          );
        }
      }
    }
  }
});

test("lsphp pins name only registry series, each package named after its series", () => {
  for (
    const [series, entry] of Object.entries(
      defaults.openlitespeed_lsphp_series_map,
    )
  ) {
    assert(series in php.series, `lsphp ${series} has no registry group`);
    const nodot = series.replace(".", "");
    assertEquals(entry.pkg, `lsphp${nodot}`);
    assert(entry.version.startsWith(`${series}.`));
    for (const pkg of entry.packages) assert(pkg.startsWith(entry.pkg), pkg);
  }
});

test("a series with a compiled-in opcache ships no opcache package and the registry says so", () => {
  for (
    const [series, entry] of Object.entries(
      defaults.openlitespeed_lsphp_series_map,
    )
  ) {
    const builtin = (php.builtinExtensions[series] ?? []).includes("opcache");
    assertEquals(
      entry.packages.includes(`${entry.pkg}-opcache`),
      !builtin,
      `lsphp ${series}: opcache package vs registry builtinExtensions disagree`,
    );
  }
});

test("the php-fpm role leaves a compiled-in extension out of the apt list", async () => {
  const series = await Deno.readTextFile(
    new URL(
      "../../orchestration/roles/php-fpm/tasks/series.yml",
      import.meta.url,
    ),
  );
  assert(series.includes("builtinExtensions[php_fpm_series_item]"));
});
