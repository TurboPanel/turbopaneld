import { assertEquals } from "@std/assert";
import {
  accessGroup,
  allAccessGroups,
  allManagedGroups,
  allRuntimeGroups,
  baselineExtensions,
  defaultSeries,
  entitlementSeries,
  isAllowedExtension,
  isRuntimeName,
  optionalExtensions,
  phpBinaryPaths,
  phpFpmUnit,
  RUNTIME_GID_BAND,
  RUNTIME_NAMES,
  runtimeGid,
  runtimeGroup,
  supportedSeries,
} from "./registry.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("RUNTIME_NAMES is the sorted runtime set", () => {
  assertEquals([...RUNTIME_NAMES], ["node", "php"]);
});

test("isRuntimeName accepts only registry names", () => {
  assertEquals(isRuntimeName("php"), true);
  assertEquals(isRuntimeName("node"), true);
  assertEquals(isRuntimeName("python"), false);
  assertEquals(isRuntimeName(""), false);
});

test("accessGroup and allAccessGroups cover SSH levels", () => {
  assertEquals(accessGroup("sftp"), "tpsftp");
  assertEquals(accessGroup("shell"), "tpshell");
  assertEquals(
    [...allAccessGroups()].sort((a, b) => a.localeCompare(b)),
    ["tpsftp", "tpshell"],
  );
});

test("RUNTIME_GID_BAND matches the entitlement band", () => {
  assertEquals(RUNTIME_GID_BAND.min, 9900);
  assertEquals(RUNTIME_GID_BAND.max, 9979);
});

test("entitlementSeries uses major.minor for php and major for node", () => {
  assertEquals(entitlementSeries("php", "8.4.3"), "8.4");
  assertEquals(entitlementSeries("php", " 8.3 "), "8.3");
  assertEquals(entitlementSeries("node", "24.17.0"), "24");
  assertEquals(entitlementSeries("node", "22"), "22");
});

test("supportedSeries and defaultSeries come from the registry", () => {
  assertEquals(supportedSeries("php"), ["8.3", "8.4"]);
  assertEquals(supportedSeries("node"), ["22", "24"]);
  assertEquals(defaultSeries("php"), "8.4");
  assertEquals(defaultSeries("node"), "24");
});

test("runtimeGroup and runtimeGid resolve known series and unknown as undefined", () => {
  assertEquals(runtimeGroup("php", "8.4.3"), "tpphp84");
  assertEquals(runtimeGid("php", "8.4.3"), 9902);
  assertEquals(runtimeGroup("php", "8.3"), "tpphp83");
  assertEquals(runtimeGid("php", "8.3"), 9901);
  assertEquals(runtimeGroup("node", "24.17.0"), "tpnode24");
  assertEquals(runtimeGid("node", "24.17.0"), 9923);
  assertEquals(runtimeGroup("node", "22"), "tpnode22");
  assertEquals(runtimeGid("node", "22"), 9921);
  assertEquals(runtimeGroup("php", "7.4"), undefined);
  assertEquals(runtimeGid("node", "18"), undefined);
});

test("allRuntimeGroups and allManagedGroups are the containment sets", () => {
  const runtime = [...allRuntimeGroups()].sort((a, b) => a.localeCompare(b));
  assertEquals(runtime, ["tpnode22", "tpnode24", "tpphp83", "tpphp84"]);
  const managed = [...allManagedGroups()].sort((a, b) => a.localeCompare(b));
  assertEquals(managed, [
    "tpnode22",
    "tpnode24",
    "tpphp83",
    "tpphp84",
    "tpsftp",
    "tpshell",
  ]);
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
