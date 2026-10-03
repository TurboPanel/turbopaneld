import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { parse } from "yaml";
import { DAEMON_ROOT } from "./assets.ts";
import { DAEMON_CONFIG_LEAVES, DAEMON_STATE_LEAVES } from "../paths/layout.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/**
 * P1-1 layout: the folders `tp` writes directly under `/etc/turbopanel` and
 * `/var/lib/turbopanel` are one table in `src/paths/layout.ts`, created by the
 * daemon-layout role. Root tasks may act on a leaf itself and never inside it.
 */
const ROLE = join(DAEMON_ROOT, "orchestration/roles/daemon-layout");

type Task = Record<string, unknown> & { name?: string };
type Leaf = { name: string; mode: string };

async function readYaml<T>(path: string): Promise<T> {
  return parse(await Deno.readTextFile(path)) as T;
}

test("the role's leaf lists equal the layout tables", async () => {
  const defaults = await readYaml<Record<string, Leaf[]>>(
    join(ROLE, "defaults/main.yml"),
  );
  assertEquals(defaults.turbopanel_daemon_config_leaves, [
    ...DAEMON_CONFIG_LEAVES,
  ]);
  assertEquals(defaults.turbopanel_daemon_state_leaves, [
    ...DAEMON_STATE_LEAVES,
  ]);
});

test("leaf names are plain folder names (one nested level at most) with no duplicates", () => {
  for (const leaves of [DAEMON_CONFIG_LEAVES, DAEMON_STATE_LEAVES]) {
    const names = leaves.map((leaf) => leaf.name);
    assertEquals(new Set(names).size, names.length);
    for (const name of names) {
      assert(/^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)?$/.test(name), name);
    }
  }
});

test("each leaf is created on its own: the daemon account owns it, no recursion, no link following", async () => {
  const tasks = await readYaml<Task[]>(join(ROLE, "tasks/main.yml"));
  for (const loop of ["config", "state"]) {
    const task = tasks.find((t) =>
      t.loop === `{{ turbopanel_daemon_${loop}_leaves }}`
    );
    assert(task, `expected a task looping over the ${loop} leaves`);
    const args = task["ansible.builtin.file"] as Record<string, unknown>;
    assertEquals(args.state, "directory");
    assertEquals(args.owner, "{{ turbopanel_user }}");
    assertEquals(args.group, "{{ turbopanel_group }}");
    assertEquals(args.mode, "{{ item.mode }}");
    assertEquals(args.follow, false);
    assert(!("recurse" in args), "a leaf is never created recursively");
  }
});
