import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { parse } from "yaml";
import { join } from "@std/path";
import { DAEMON_ROOT } from "./assets.ts";
import { PHP_FPM_RUN_DIR, PROD_RUN_DIR_DEFAULT } from "../paths/layout.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ROLES = join(DAEMON_ROOT, "orchestration/roles");
const read = (path: string) => Deno.readTextFile(join(ROLES, path));

type Task = Record<string, unknown>;
type FileArgs = {
  path: string;
  state: string;
  owner: string;
  group: string;
  mode: string;
};

/** The `ansible.builtin.file` args of every task that makes a folder. */
async function dirTasks(path: string): Promise<FileArgs[]> {
  const tasks = parse(await read(path)) as Task[];
  return tasks
    .map((t) => t["ansible.builtin.file"] as FileArgs | undefined)
    .filter((f): f is FileArgs => f?.state === "directory");
}

test("the php-fpm run tree is outside the daemon-owned run folder", () => {
  assertEquals(PHP_FPM_RUN_DIR, "/run/turbopanel-phpfpm");
  // The daemon account owns /run/turbopanel (3770), so it could rename
  // anything inside; the tree must be a sibling, not a child.
  assert(!PHP_FPM_RUN_DIR.startsWith(`${PROD_RUN_DIR_DEFAULT}/`));
  assertEquals(PHP_FPM_RUN_DIR.split("/").length, 3, "directly under /run");
});

test("the role defaults and the prune role name the same root-owned run tree", async () => {
  const fpm = parse(await read("php-fpm/defaults/main.yml")) as Task;
  const prune = parse(await read("php-series-prune/defaults/main.yml")) as Task;
  assertEquals(fpm.php_fpm_run_dir, PHP_FPM_RUN_DIR);
  assertEquals(prune.php_fpm_run_dir, PHP_FPM_RUN_DIR);
});

test("every folder the role makes in the run tree is root-owned, group tp and not writable by tp", async () => {
  const made = [
    ...(await dirTasks("php-fpm/tasks/main.yml")),
    ...(await dirTasks("php-fpm/tasks/series.yml")),
  ].filter((f) => f.path.includes("php_fpm_run_dir"));
  assertEquals(made.length, 2, "the root and the per-series folder");
  for (const dir of made) {
    assertEquals(dir.owner, "root", dir.path);
    assertEquals(dir.group, "{{ turbopanel_group }}", dir.path);
    // Group tp may traverse and list (r-x); nobody but root may write.
    assertEquals(dir.mode, "0750", dir.path);
  }
});

test("the unit recreates the run tree as root:tp 0750, parent first, and writes only there", async () => {
  const unit = await read(
    "php-fpm/templates/turbopanel-php-fpm@.service.j2",
  );
  const pre = unit.split("\n").filter((l) => l.startsWith("ExecStartPre="));
  assertEquals(pre, [
    "ExecStartPre=/usr/bin/install -d -o root -g {{ turbopanel_group }} -m 0750 {{ php_fpm_run_dir }}",
    "ExecStartPre=/usr/bin/install -d -o root -g {{ turbopanel_group }} -m 0750 {{ php_fpm_run_dir }}/%i",
  ]);
  assertStringIncludes(unit, "PIDFile={{ php_fpm_run_dir }}/%i/php-fpm.pid");
  assertStringIncludes(unit, "--pid {{ php_fpm_run_dir }}/%i/php-fpm.pid");
  assert(!unit.includes("turbopanel_run_dir"), "nothing under the daemon's run");
});

test("the master config and the bootstrap pool use the root-owned tree", async () => {
  const conf = await read("php-fpm/templates/php-fpm.conf.j2");
  assertStringIncludes(
    conf,
    "pid = {{ php_fpm_run_dir }}/{{ php_fpm_series_item }}/php-fpm.pid",
  );
  const pool = await read("php-fpm/templates/default-pool.conf.j2");
  assertStringIncludes(
    pool,
    "listen = {{ php_fpm_run_dir }}/{{ php_fpm_series_item }}/default.sock",
  );
  for (const f of ["tasks/main.yml", "tasks/series.yml"]) {
    assert(
      !(await read(`php-fpm/${f}`)).includes("turbopanel_run_dir"),
      f,
    );
  }
});

test("the prune role removes the series folder from the root-owned tree", async () => {
  const tasks = await read("php-series-prune/tasks/series.yml");
  assertStringIncludes(tasks, "{{ php_fpm_run_dir }}/{{ php_prune_series }}");
  assert(!tasks.includes("turbopanel_run_dir"));
});

test("tp-host pins a pool's socket to the root-owned tree, not the daemon's run folder", async () => {
  const host = await Deno.readTextFile(
    join(DAEMON_ROOT, "orchestration/scripts/tp-host"),
  );
  assertStringIncludes(host, 'R_PHPFPM_RUN="$P/run/turbopanel-phpfpm"');
  assertStringIncludes(host, 'sockdir="${R_PHPFPM_RUN#"$P"}/$_pp_series"');
  assert(!host.includes('${R_RUN#"$P"}/php/'));
});
