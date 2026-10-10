import { assertEquals } from "@std/assert";
import registryJson from "../../orchestration/runtime-registry.json" with {
  type: "json",
};
import {
  accessGroup,
  allAccessGroups,
  allManagedGroups,
  baselineExtensions,
  defaultSeries,
  isAllowedExtension,
  isRuntimeName,
  isSupportedSeries,
  optionalExtensions,
  phpBinaryPaths,
  phpBuiltinExtensions,
  phpFpmUnit,
  phpSeriesForSuite,
  RUNTIME_NAMES,
  runtimeSeries,
  supportedSeries,
  unsupportedPhpSeriesMessage,
  unsupportedSeriesMessage,
} from "./registry.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("RUNTIME_NAMES is the sorted runtime set", () => {
  assertEquals([...RUNTIME_NAMES], ["deno", "node", "php"]);
});

test("isRuntimeName accepts only registry names", () => {
  assertEquals(isRuntimeName("php"), true);
  assertEquals(isRuntimeName("node"), true);
  assertEquals(isRuntimeName("deno"), true);
  assertEquals(isRuntimeName("python"), false);
  assertEquals(isRuntimeName(""), false);
});

test("accessGroup and allAccessGroups cover SSH levels", () => {
  assertEquals(accessGroup("sftp"), "tpsftp");
  assertEquals(accessGroup("shell"), "tpshell");
  assertEquals(accessGroup("password"), "tppasswd");
  assertEquals(accessGroup("principal"), "tpprincipal");
  assertEquals(
    [...allAccessGroups()].sort((a, b) => a.localeCompare(b)),
    ["tppasswd", "tpprincipal", "tpsftp", "tpshell"],
  );
});

test("runtimeSeries uses major.minor for php and major for node", () => {
  assertEquals(runtimeSeries("php", "8.4.3"), "8.4");
  assertEquals(runtimeSeries("php", " 8.3 "), "8.3");
  assertEquals(runtimeSeries("node", "24.17.0"), "24");
  assertEquals(runtimeSeries("node", "22"), "22");
  assertEquals(runtimeSeries("deno", "2.9.7"), "2");
});

test("supportedSeries and defaultSeries come from the registry", () => {
  assertEquals(supportedSeries("php"), ["8.1", "8.2", "8.3", "8.4", "8.5"]);
  assertEquals(supportedSeries("node"), ["22", "24", "26"]);
  assertEquals(supportedSeries("deno"), ["2"]);
  assertEquals(defaultSeries("deno"), "2");
  assertEquals(defaultSeries("php"), "8.4");
  assertEquals(defaultSeries("node"), "24");
});

test("isSupportedSeries resolves known series and refuses unknown ones", () => {
  assertEquals(isSupportedSeries("php", "8.4.3"), true);
  assertEquals(isSupportedSeries("php", "8.1"), true);
  assertEquals(isSupportedSeries("node", "24.17.0"), true);
  assertEquals(isSupportedSeries("deno", "2.9.7"), true);
  assertEquals(isSupportedSeries("php", "7.4"), false);
  assertEquals(isSupportedSeries("deno", "3"), false);
  assertEquals(isSupportedSeries("node", "18"), false);
});

test("allManagedGroups is the SSH access groups and nothing per runtime", () => {
  const managed = [...allManagedGroups()].sort((a, b) => a.localeCompare(b));
  assertEquals(managed, ["tppasswd", "tpprincipal", "tpsftp", "tpshell"]);
});

test("no runtime series carries a group any more", () => {
  for (const runtime of RUNTIME_NAMES) {
    const series = (registryJson.runtimes as Record<
      string,
      { series: Record<string, Record<string, unknown>> }
    >)[runtime]?.series ?? {};
    for (const entry of Object.values(series)) {
      assertEquals(Object.keys(entry), []);
    }
  }
});

test("php extensions: baseline, optional, and allowlist", () => {
  assertEquals(baselineExtensions("php").includes("mbstring"), true);
  assertEquals(optionalExtensions("php").includes("redis"), true);
  assertEquals(baselineExtensions("node"), []);
  assertEquals(optionalExtensions("node"), []);
  assertEquals(isAllowedExtension("php", "mbstring"), true);
  assertEquals(isAllowedExtension("php", "redis"), true);
  assertEquals(isAllowedExtension("php", "xdebug"), false);
  assertEquals(isAllowedExtension("node", "anything"), false);
});

test("phpBinaryPaths and phpFpmUnit are series-scoped", () => {
  assertEquals(phpBinaryPaths("8.4"), {
    fpm: "/usr/sbin/php-fpm8.4",
    cli: "/usr/bin/php8.4",
  });
  assertEquals(phpFpmUnit("8.3"), "turbopanel-php-fpm@8.3");
});

test("unsupportedSeriesMessage names the supported series, and is silent for known ones", () => {
  assertEquals(unsupportedSeriesMessage("node", "26.10.0"), undefined);
  assertEquals(
    unsupportedSeriesMessage("node", "27"),
    "node 27 is not a supported node version on this server. Supported series: 22, 24, 26.",
  );
});

test("phpSeriesForSuite lists what the OS offers, and every series for an unlisted suite", () => {
  assertEquals(phpSeriesForSuite("trixie"), [
    "8.1",
    "8.2",
    "8.3",
    "8.4",
    "8.5",
  ]);
  assertEquals(phpSeriesForSuite(" Trixie "), phpSeriesForSuite("trixie"));
  // Not in the table: no block here, the roles report a missing pin.
  assertEquals(phpSeriesForSuite("bookworm"), supportedSeries("php"));
  assertEquals(phpSeriesForSuite(undefined), supportedSeries("php"));
});

test("every suite series is a registry series, and the default is offered on each suite", () => {
  const suites = registryJson.runtimes.php.suiteSeries as Record<
    string,
    string[]
  >;
  for (const [suite, series] of Object.entries(suites)) {
    for (const entry of series) {
      assertEquals(
        supportedSeries("php").includes(entry),
        true,
        `${suite} lists ${entry}, which has no registry group`,
      );
    }
    assertEquals(series.includes(defaultSeries("php")), true, suite);
  }
});

test("unsupportedPhpSeriesMessage names the series the OS offers", () => {
  assertEquals(unsupportedPhpSeriesMessage("8.4.3", "trixie"), undefined);
  assertEquals(unsupportedPhpSeriesMessage("8.1", "trixie"), undefined);
  assertEquals(
    unsupportedPhpSeriesMessage("7.4", "trixie"),
    "php 7.4 is not offered on this server's operating system. Offered series: 8.1, 8.2, 8.3, 8.4, 8.5.",
  );
});

test("phpBuiltinExtensions names what a series compiles in", () => {
  assertEquals(phpBuiltinExtensions("8.5"), ["opcache"]);
  assertEquals(phpBuiltinExtensions("8.4"), []);
});
