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

const ROLE = join(DAEMON_ROOT, "orchestration/roles/php-fpm");
const read = (path: string) => Deno.readTextFile(join(ROLE, path));

test("the PHP package manager is pinned with the publisher's digest", async () => {
  const defaults = await read("defaults/main.yml");
  assertStringIncludes(defaults, 'php_fpm_composer_version: "2.11.2"');
  const sha = /php_fpm_composer_sha256: "([0-9a-f]+)"/.exec(defaults)?.[1];
  assertEquals(sha?.length, 64);
  assertStringIncludes(
    defaults,
    'php_fpm_composer_url: "https://getcomposer.org/download/{{ php_fpm_composer_version }}/composer.phar"',
  );
});

test("the role downloads once, checks the digest, opens the tree and prunes old versions", async () => {
  const tasks = await read("tasks/composer.yml");
  // Fast path: nothing is downloaded when the pinned file is there.
  assertStringIncludes(tasks, "_php_fpm_composer_pinned.stat.exists");
  assertStringIncludes(
    tasks,
    'checksum: "sha256:{{ php_fpm_composer_sha256 }}"',
  );
  assertStringIncludes(tasks, "etype: other");
  assertStringIncludes(tasks, 'mode: "u=rwx,go=rx"');
  assertStringIncludes(tasks, 'mode: "u=rw,go=r"');
  assertStringIncludes(tasks, 'dest: "{{ php_fpm_composer_root }}/current"');
  assertStringIncludes(tasks, "- current");
  assertStringIncludes(tasks, '- "{{ php_fpm_composer_version }}"');
  assertStringIncludes(
    tasks.replaceAll("\n", " "),
    "state: absent",
  );
  const main = await read("tasks/main.yml");
  assert(
    main.indexOf("include_tasks: composer.yml") >
      main.indexOf("include_tasks: series.yml"),
    "the package manager is vendored after the series loop",
  );
});

test("the wrapper runs the phar through the PHP shell dispatcher", async () => {
  const wrapper = await read("templates/composer-wrapper.sh.j2");
  assertStringIncludes(
    wrapper,
    'exec /usr/local/bin/php "{{ php_fpm_composer_root }}/{{ php_fpm_composer_version }}/composer.phar" "$@"',
  );
});
