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
  assert(
    !unit.includes("turbopanel_run_dir"),
    "nothing under the daemon's run",
  );
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

type Play = {
  name?: string;
  block?: Play[];
  rescue?: Play[];
  "ansible.builtin.replace"?: { regexp: string; replace: string };
  "ansible.builtin.find"?: { contains?: string };
  when?: string;
} & Record<string, unknown>;

async function converge(): Promise<{ main: Play; names: string[] }> {
  const plays = parse(
    await read("php-fpm/tasks/converge-run-tree.yml"),
  ) as Play[];
  const main = plays.find((p) => p.name === "Move the php-fpm run tree");
  assert(main?.block && main.rescue, "a block with a rescue");
  return { main, names: main.block.map((p) => p.name ?? "") };
}

test("the boot converge moves the run tree, as root, before any deploy", async () => {
  const playbook = await Deno.readTextFile(
    join(DAEMON_ROOT, "orchestration/playbooks/daemon-converge.yml"),
  );
  assertStringIncludes(playbook, "name: php-fpm");
  assertStringIncludes(playbook, "tasks_from: converge-run-tree.yml");
  // Deploys cannot overlap it: commands wait for every converge run.
  const gate = await Deno.readTextFile(
    join(DAEMON_ROOT, "src/commands/command-router.ts"),
  );
  assertStringIncludes(gate, "await bootConvergeSettled();");
});

test("the converge rewrites the old socket prefix, trailing slash kept, to the new tree", async () => {
  const { main } = await converge();
  const tasks = parse(
    await read("php-fpm/tasks/converge-run-tree.yml"),
  ) as Play[];
  const find = tasks.find((p) => p["ansible.builtin.find"]?.contains);
  assertEquals(
    find?.["ansible.builtin.find"]?.contains,
    "{{ turbopanel_run_dir }}/php/",
  );
  const replace = main.block?.find((p) => p["ansible.builtin.replace"])
    ?.["ansible.builtin.replace"];
  assertEquals(replace?.regexp, "{{ turbopanel_run_dir }}/php/");
  assertEquals(replace?.replace, "{{ php_fpm_run_dir }}/");
  // What a pool or vhost says before and after.
  const old =
    "listen = /run/turbopanel/php/8.4/tp-e1-shop.sock\nfastcgi_pass unix:/run/turbopanel/php/8.4/tp-e1-shop.sock;\n";
  const moved = old.replaceAll("/run/turbopanel/php/", `${PHP_FPM_RUN_DIR}/`);
  assertEquals(
    moved,
    `listen = ${PHP_FPM_RUN_DIR}/8.4/tp-e1-shop.sock\nfastcgi_pass unix:${PHP_FPM_RUN_DIR}/8.4/tp-e1-shop.sock;\n`,
  );
});

test("every engine config is tested before any master or engine is restarted", async () => {
  const { names } = await converge();
  const at = (needle: string) => names.findIndex((n) => n.includes(needle));
  const tests = ["php-fpm config", "site Caddy", "nginx config", "Apache"]
    .map((n) =>
      at(`Test ${n.startsWith("php") ? "each series' " + n : "the " + n}`)
    );
  for (const i of tests) assert(i >= 0, `test task ${i}`);
  const firstRestart = at("Restart the php-fpm masters");
  assert(firstRestart > Math.max(...tests), "restart after every test");
  assert(at("Reload the engines") > firstRestart);
  assert(at("Re-render each series' php-fpm main config") < Math.min(...tests));
  assert(at("Point the pools and vhosts") < Math.min(...tests));
  assert(at("Back up every file") < at("Install the php-fpm unit template"));
});

test("a failed move restores the backups, restarts only what ran, and fails", async () => {
  const { main } = await converge();
  const rescue = (main.rescue ?? []).map((p) => p.name ?? "");
  assertEquals(rescue, [
    "Put the backed-up files back",
    "Reload systemd after putting the unit template back",
    "Restart the masters that were running, on the old files",
    "Remove the backup file",
    "Fail the move",
  ]);
  // A master stopped on purpose is never started, here or in the happy path.
  for (
    const play of [
      ...(main.block ?? []),
      ...(main.rescue ?? []),
    ].filter((p) => (p.name ?? "").startsWith("Restart the"))
  ) {
    assertStringIncludes(String(play.when), "== 'active'");
  }
});
