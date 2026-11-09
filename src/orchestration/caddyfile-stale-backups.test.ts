import { assert, assertEquals } from "@std/assert";
import { globToRegExp, join } from "@std/path";
import { parse } from "yaml";
import { DAEMON_ROOT } from "./assets.ts";

/** Sonar typescript:S2187 only recognizes `test()`; see other suites here. */
const test = Deno.test.bind(Deno);

const TASKS = join(DAEMON_ROOT, "orchestration/roles/instance-launch/tasks");
const EDITS = [
  "caddyfile-grace.yml",
  "caddyfile-ui-cache.yml",
  "caddyfile-server-headers.yml",
];

type Task = Record<string, unknown>;

async function cleanupTasks(): Promise<Task[]> {
  return parse(
    await Deno.readTextFile(join(TASKS, "caddyfile-stale-backups.yml")),
  ) as Task[];
}

/** The `when:` conditions of a task as one list. */
function conditions(task: Task): string[] {
  const when = task.when;
  if (when === undefined) return [];
  return Array.isArray(when) ? when.map(String) : [String(when)];
}

test("the backup cleanup runs after every in-place Caddyfile edit", async () => {
  const main = await Deno.readTextFile(join(TASKS, "main.yml"));
  const cleanup = main.indexOf("caddyfile-stale-backups.yml");
  assert(cleanup > 0, "main.yml imports caddyfile-stale-backups.yml");
  for (const edit of EDITS) {
    const at = main.indexOf(edit);
    assert(at > 0 && at < cleanup, `${edit} runs before the cleanup`);
    // The edits keep their backups; the cleanup only drops empty ones.
    const text = await Deno.readTextFile(join(TASKS, edit));
    assert(text.includes("backup: true"), `${edit} keeps a backup`);
  }
});

test("the backup pattern matches the name the edit modules give a backup", async () => {
  const find = (await cleanupTasks()).find((task) =>
    task["ansible.builtin.find"] !== undefined
  );
  assert(find, "a find task lists the backups");
  const args = find["ansible.builtin.find"] as Record<string, unknown>;
  assertEquals(args.get_checksum, true);
  assertEquals(args.file_type, "file");
  // Render the pattern for the default Caddyfile name.
  const pattern = String(args.patterns).replace(
    "{{ turbopanel_caddyfile | basename }}",
    "Caddyfile",
  );
  const re = globToRegExp(pattern);
  // <file>.<pid>.<date>@<time>~, as the modules' backup helper names it.
  assert(re.test("Caddyfile.41237.2026-11-09@13:04:55~"));
  assert(!re.test("Caddyfile"), "never the live file");
  assert(!re.test("Caddyfile.j2"));
  assert(!re.test("Caddyfile.tmp"));
});

test("only backups identical to the live Caddyfile are removed", async () => {
  const tasks = await cleanupTasks();
  const stat = tasks.find((task) => task["ansible.builtin.stat"] !== undefined);
  assert(stat, "the live file is checksummed");
  const statArgs = stat["ansible.builtin.stat"] as Record<string, unknown>;
  const findArgs = tasks.find((task) =>
    task["ansible.builtin.find"] !== undefined
  )?.["ansible.builtin.find"] as Record<string, unknown>;
  // Both sides must use one algorithm or nothing ever matches.
  assertEquals(statArgs.checksum_algorithm, findArgs.checksum_algorithm);

  const remove = tasks.filter((task) => {
    const args = task["ansible.builtin.file"] as
      | Record<string, unknown>
      | undefined;
    return args?.state === "absent";
  });
  assertEquals(remove.length, 1, "one removal task");
  assert(
    conditions(remove[0]).includes(
      "item.checksum == _caddyfile_live.stat.checksum",
    ),
    "the removal is limited to backups that match the live file",
  );
  // Like the edits, it leaves a development Caddyfile alone.
  for (const task of tasks.slice(0, 2)) {
    assert(
      conditions(task).some((c) => c.includes("turbopanel_dev_user")),
      `${String(task.name)} skips development hosts`,
    );
  }
});
