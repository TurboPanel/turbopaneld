import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { DAEMON_ROOT } from "./assets.ts";

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
  // Resolve a series, then exec that series' binary. Exec'ing `/usr/bin/php`
  // would hand the caller back to host-global alternatives priority, which is
  // what this exists to replace.
  assertStringIncludes(source, 'binary="/usr/bin/php${selected}"');
  assertStringIncludes(source, 'exec "$binary" "$@"');
});

test("the dispatcher needs no privilege and every account may run it", async () => {
  const source = await template();
  // No setuid, no sudo, no capability: it only picks among installed series.
  assert(!/\bsudo\b/.test(source), "dispatcher must never invoke sudo");
  assert(!/\bsetuid\b/i.test(source), "dispatcher must never be setuid");

  const tasks = await Deno.readTextFile(PHP_FPM_TASKS);
  const install = /dest: \/usr\/local\/bin\/php\n(?:.*\n)*?\s*mode: "([^"]+)"/
    .exec(tasks);
  assert(install, "dispatcher install task must set an explicit mode");
  // Owner and group only, so the `other` ACL entry survives every run.
  assertEquals(install[1], "u=rwx,g=rx");
  // Every site owner's Linux user may run every installed series, so every
  // account gets read + execute through an `other` ACL entry.
  const acl =
    /path: \/usr\/local\/bin\/php\n\s*etype: other\n\s*permissions: rx/
      .exec(tasks);
  assert(acl, "the dispatcher must carry an other:rx ACL");
});

test("the dispatcher only ever selects an installed series", async () => {
  const source = await template();
  // An explicit request is matched against the installed list rather than
  // passed through, so a missing series is named instead of failing at execve.
  assertStringIncludes(source, "for series in $installed; do");
  assertStringIncludes(source, "is not installed on this server");
  // Nothing about the caller's groups decides what it may run any more.
  assert(!source.includes("id -nG"), "dispatcher must not read group lists");
  assert(!/tpphp/.test(source), "dispatcher must not name a PHP group");
});

test("installed series are version-sorted, not lexically sorted", async () => {
  const source = await template();
  // `sort -V`, or 8.10 would order before 8.4 and the highest-series default
  // would silently pick the older runtime.
  assertStringIncludes(source, "sort -V");
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
