import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { parse } from "yaml";
import {
  PROD_CONFIG_DIR_DEFAULT,
  PROD_RUNTIME_DIR_DEFAULT,
} from "../paths/layout.ts";
import { DAEMON_ROOT } from "./assets.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ORCHESTRATION = join(DAEMON_ROOT, "orchestration");

function read(relPath: string): Promise<string> {
  return Deno.readTextFile(join(ORCHESTRATION, relPath));
}

/** A `#define NAME "value"` or `#define NAME 123` from the launcher source. */
function define(source: string, name: string): string {
  const match = new RegExp(String.raw`^#define ${name} "?([^"\n]*)"?$`, "m")
    .exec(source);
  if (!match) throw new TypeError(`tp-php-launch.c: no #define ${name}`);
  return match[1];
}

/** The launcher's compiled-in series table: `{"8.4", "tpphp84"}` rows. */
function seriesTable(source: string): Array<[string, string]> {
  return [...source.matchAll(/^\s*\{"(\d+\.\d+)", "(tpphp\d+)"\},$/gm)].map((
    [, php, group],
  ): [string, string] => [php, group]);
}

test("tp-php-launch starts exactly the lsphp series the role vendors, under their registry groups", async () => {
  const source = await read("scripts/tp-php-launch.c");
  const ols = parse(await read("roles/openlitespeed/defaults/main.yml")) as {
    openlitespeed_lsphp_series_map: Record<string, unknown>;
  };
  const registry = JSON.parse(await read("runtime-registry.json")) as {
    runtimes: { php: { series: Record<string, { group: string }> } };
  };
  const table = seriesTable(source);
  assertEquals(
    table.map(([php]) => php).sort(),
    Object.keys(ols.openlitespeed_lsphp_series_map).sort(),
  );
  for (const [php, group] of table) {
    assertEquals(registry.runtimes.php.series[php]?.group, group, php);
  }
});

test("tp-php-launch and tp-host agree on the registry, id bands and layout", async () => {
  const source = await read("scripts/tp-php-launch.c");
  const tpHost = await read("scripts/tp-host");
  const role = parse(await read("roles/php-launch/defaults/main.yml")) as {
    php_launch_registry_dir: string;
    php_launch_caller: string;
  };
  assertEquals(define(source, "REGISTRY_DIR"), "/etc/turbopanel-php-sites");
  assertStringIncludes(tpHost, `R_PHP_SITES="$P/etc/turbopanel-php-sites"`);
  assertEquals(role.php_launch_registry_dir, define(source, "REGISTRY_DIR"));
  // Never inside the tp-owned config tree, where tp could rename a parent.
  assertEquals(
    define(source, "REGISTRY_DIR").startsWith("/etc/turbopanel/"),
    false,
  );
  assertEquals(define(source, "CALLER"), role.php_launch_caller);
  // The compiled-in install paths are the production layout's.
  assertEquals(define(source, "CONFIG_ROOT"), PROD_CONFIG_DIR_DEFAULT);
  assertEquals(
    define(source, "LSPHP_ROOT"),
    `${PROD_RUNTIME_DIR_DEFAULT}/lsphp`,
  );
  assertStringIncludes(
    tpHost,
    `R_PRINCIPALS="$P${define(source, "PRINCIPALS")}"`,
  );
  assertStringIncludes(
    tpHost,
    `PRINCIPAL_ID_MIN=${define(source, "PRINCIPAL_ID_MIN")}`,
  );
  assertStringIncludes(
    tpHost,
    `PRINCIPAL_ID_MAX=${define(source, "PRINCIPAL_ID_MAX")}`,
  );
  assertStringIncludes(
    tpHost,
    `SERVICE_ID_MIN=${define(source, "SERVICE_ID_MIN")}`,
  );
  assertStringIncludes(
    tpHost,
    `SERVICE_ID_MAX=${define(source, "SERVICE_ID_MAX")}`,
  );
  // The keys php-site-register writes are the keys the launcher requires.
  const keys = /KEYS\[K_COUNT\] = \{([^}]*)\}/.exec(source)?.[1] ?? "";
  const launcherKeys = [...keys.matchAll(/"([a-z]+)"/g)].map(([, k]) => k);
  const verb =
    /tp_verb_php_site_register\(\) \{([\s\S]*?)\n\}/.exec(tpHost)?.[1] ?? "";
  const written = [...verb.matchAll(/^\s+"([a-z]+)=/gm)].map(([, k]) => k);
  assertEquals(written, launcherKeys);
});

test("the php-launch role pins one SHA-256 per architecture and installs 4750 root:tpphplaunch", async () => {
  const defaults = parse(await read("roles/php-launch/defaults/main.yml")) as {
    php_launch_sha256: Record<string, string>;
    php_launch_arch_map: Record<string, string>;
    php_launch_group: string;
  };
  assertEquals(Object.keys(defaults.php_launch_sha256).sort(), [
    "amd64",
    "arm64",
  ]);
  assertEquals(
    Object.values(defaults.php_launch_arch_map).sort(),
    ["amd64", "arm64"],
  );
  for (const digest of Object.values(defaults.php_launch_sha256)) {
    assertMatch(digest, /^[0-9a-f]{64}$/);
  }
  assertEquals(defaults.php_launch_group, "tpphplaunch");
  const tasks = await read("roles/php-launch/tasks/main.yml");
  assertStringIncludes(tasks, 'mode: "4750"');
  assertStringIncludes(tasks, 'group: "{{ php_launch_group }}"');
  assertStringIncludes(
    tasks,
    "_php_launch_installed.stat.checksum == php_launch_sha256[_php_launch_arch]",
  );
  // The release bundle builds and pin-checks it.
  const bundle = await Deno.readTextFile(
    join(DAEMON_ROOT, "scripts", "bundle-orchestration.sh"),
  );
  assertStringIncludes(bundle, "scripts/build-tp-php-launch.sh");
});
