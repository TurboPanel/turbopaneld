import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { parse } from "yaml";
import { DAEMON_ROOT } from "./assets.ts";

/** Sonar typescript:S2187 only recognizes `test()`; see other suites here. */
const test = Deno.test.bind(Deno);

const ORCH = join(DAEMON_ROOT, "orchestration");

type Task = Record<string, unknown>;

/** Every YAML file under `dir`, recursively. */
async function yamlFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) out.push(...await yamlFiles(path));
    else if (entry.isFile && entry.name.endsWith(".yml")) out.push(path);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/** Each orchestration YAML file with every task it lists. */
async function orchestrationTasks(): Promise<
  Array<{ path: string; tasks: Task[] }>
> {
  // First-party roles and playbooks only (not vendored collections).
  const files = [
    ...await yamlFiles(join(ORCH, "roles")),
    ...await yamlFiles(join(ORCH, "playbooks")),
  ];
  return await Promise.all(files.map(async (path) => {
    const doc = parse(await Deno.readTextFile(path));
    // A playbook is a list of plays; their tasks sit under these keys.
    const plays = Array.isArray(doc) ? doc as Task[] : [];
    const nested = plays.flatMap((play) =>
      play && typeof play === "object"
        ? ["pre_tasks", "tasks", "post_tasks", "handlers"].flatMap((key) =>
          flatten(play[key])
        )
        : []
    );
    return { path, tasks: [...flatten(doc), ...nested] };
  }));
}

/** Every task in a parsed task list, including those inside blocks. */
function flatten(tasks: unknown): Task[] {
  if (!Array.isArray(tasks)) return [];
  const out: Task[] = [];
  for (const task of tasks as Task[]) {
    if (!task || typeof task !== "object") continue;
    out.push(task);
    for (const key of ["block", "rescue", "always"]) {
      out.push(...flatten(task[key]));
    }
  }
  return out;
}

/** The arguments of a task's module when they carry `validate`. */
function moduleArgs(task: Task): Record<string, unknown> | undefined {
  for (const value of Object.values(task)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if ("validate" in value) return value as Record<string, unknown>;
    }
  }
  return undefined;
}

function conditionText(task: Task): string {
  const when = task.when;
  return Array.isArray(when) ? when.join("\n") : String(when ?? "");
}

test("a validate failure that is ignored is warned about with the module's own message", async () => {
  // replace and lineinfile report a refused validate command as
  // "failed to validate: rc:… error:…"; a search for any other text never
  // matches and the operator is never told the file was left unchanged.
  let checked = 0;
  for (const entry of await orchestrationTasks()) {
    const tasks = entry.tasks;
    for (const task of tasks) {
      if (task.failed_when !== false || typeof task.register !== "string") {
        continue;
      }
      if (moduleArgs(task)?.validate === undefined) continue;
      const name = task.register;
      const warnings = tasks.filter((t) =>
        conditionText(t).includes(`${name}.msg`)
      );
      assert(
        warnings.length > 0,
        `${entry.path}: ${name} ignores a failed validate without a warning`,
      );
      for (const warning of warnings) {
        assert(
          conditionText(warning).includes(
            `${name}.msg is search('failed to validate')`,
          ),
          `${entry.path}: the warning for ${name} must search 'failed to validate'`,
        );
      }
      checked++;
    }
  }
  // At least the four in-place Caddyfile edits (server headers twice, UI
  // cache, grace period): the walk must not silently find nothing.
  assert(checked >= 4, `only ${checked} ignored validate failures found`);
});

test("every apt task waits out the daily security update run", async () => {
  // apt-daily-upgrade holds the dpkg lock for a few minutes once a day, and
  // its timers are Persistent, so they can fire at boot next to a converge.
  // The module's default 60 s wait then fails a php-fpm, docker or runtime
  // install. 300 s stays well inside the update guard's 600 s deadline.
  let checked = 0;
  for (const entry of await orchestrationTasks()) {
    for (const task of entry.tasks) {
      const args = task["ansible.builtin.apt"];
      if (args === undefined) continue;
      assertEquals(
        (args as Record<string, unknown>).lock_timeout,
        300,
        `${entry.path}: ${String(task.name)} sets lock_timeout: 300`,
      );
      checked++;
    }
  }
  assert(checked >= 21, `only ${checked} apt tasks found`);
});
