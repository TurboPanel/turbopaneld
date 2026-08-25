import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { DAEMON_ROOT } from "./paths.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const TEMPLATE_PATH = join(
  DAEMON_ROOT,
  "orchestration/roles/php-fpm/templates/php-dispatcher.sh.j2",
);
const PHP_FPM_TASKS = join(
  DAEMON_ROOT,
  "orchestration/roles/php-fpm/tasks/main.yml",
);

async function template(): Promise<string> {
  return await Deno.readTextFile(TEMPLATE_PATH);
}

test("the dispatcher execs the per-series binary, never a bare `php`", async () => {
  const source = await template();
  // The whole point: resolve a series, then exec the binary whose 0750 mode the
  // kernel checks. Exec'ing `/usr/bin/php` would hand the caller back to
  // host-global alternatives priority, which is what this exists to replace.
  assertStringIncludes(source, 'binary="/usr/bin/php${selected}"');
  assertStringIncludes(source, 'exec "$binary" "$@"');
});

test("the dispatcher grants nothing and needs no privilege", async () => {
  const source = await template();
  // No setuid, no sudo, no capability. A tenant who ignores the wrapper and
  // runs /usr/bin/php8.3 directly gets the identical answer from the kernel.
  assert(!/\bsudo\b/.test(source), "dispatcher must never invoke sudo");
  assert(!/\bsetuid\b/i.test(source), "dispatcher must never be setuid");

  const tasks = await Deno.readTextFile(PHP_FPM_TASKS);
  const install = /dest: \/usr\/local\/bin\/php\n(?:.*\n)*?\s*mode: "(\d+)"/
    .exec(tasks);
  assert(install, "dispatcher install task must set an explicit mode");
  assertEquals(install[1], "0750");
  // World-exec is how an unentitled caller would reach the friendly error;
  // entitled accounts get there through the per-series ACL instead.
  assertStringIncludes(tasks, "ansible.posix.acl:");
  assertStringIncludes(tasks, "path: /usr/local/bin/php");
});

test("the dispatcher only ever selects a series the caller already holds", async () => {
  const source = await template();
  // An explicit request is matched against the entitled list rather than passed
  // through. Passing it through would reach `execve` and come back as a bare
  // EACCES with nothing explaining why.
  assertStringIncludes(source, "for series in $entitled; do");
  assertStringIncludes(source, "is not available to this account");
  assertStringIncludes(source, "is not permitted to run PHP on this server");
});

test("entitled series are version-sorted, not lexically sorted", async () => {
  const source = await template();
  // `sort -V`, or 8.10 would order before 8.4 and the highest-series default
  // would silently pick the older runtime. Same failure the registry avoids by
  // hand-assigning gids instead of computing them from the version string.
  assertStringIncludes(source, "sort -V");
});

test("the group-to-series table is rendered, not parsed from the group name", async () => {
  const source = await template();
  // `tpphp810` cannot be read back unambiguously as 8.10 rather than 81.0, so
  // the mapping comes from the registry rather than from a regex over the name.
  assertStringIncludes(source, "runtime_registry.runtimes.php.series[series]");
  assert(
    !/tpphp\\?\(/.test(source),
    "dispatcher must not parse a series out of the group name",
  );
});

test("the php-fpm role loads the registry before rendering the dispatcher", async () => {
  const tasks = await Deno.readTextFile(PHP_FPM_TASKS);
  const loadAt = tasks.indexOf("name: runtime_registry");
  const renderAt = tasks.indexOf("src: php-dispatcher.sh.j2");
  assert(loadAt >= 0, "php-fpm must load the runtime registry");
  assert(renderAt >= 0, "php-fpm must render the dispatcher");
  // Depending on the copy `runtime-entitlement` leaves behind would make the
  // dispatcher's contents depend on task ordering inside an included role.
  assert(
    loadAt < renderAt,
    "the registry must load before the template renders",
  );
});

test("per-account pins are root-writable only", async () => {
  const tasks = await Deno.readTextFile(PHP_FPM_TASKS);
  const pins = /php\/pins"\n(?:.*\n)*?\s*mode: "(\d+)"/.exec(tasks);
  assert(pins, "the pin directory must set an explicit mode");
  // `/etc/turbopanel` is already 0750, so a world bit here never reached a
  // tenant. Not writable, or one tenant could change another's default series.
  assertEquals(pins[1], "0750");
  assertStringIncludes(tasks, "owner: root");
});
