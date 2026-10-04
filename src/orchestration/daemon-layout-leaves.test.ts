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

test("metrics is a daemon-owned folder on daemon-only hosts and left to instance-launch co-located", async () => {
  const tasks = await readYaml<Task[]>(join(ROLE, "tasks/main.yml"));
  const task = tasks.find((t) => t.name?.includes("metrics folder"));
  assert(task, "expected a metrics task in daemon-layout");
  assertEquals(
    task.when,
    "not (turbopanel_after_instance_service | default(false) | bool)",
  );
  const args = task["ansible.builtin.file"] as Record<string, unknown>;
  assertEquals(args.path, "{{ turbopanel_daemon_state_dir }}/metrics");
  assertEquals(args.owner, "{{ turbopanel_user }}");
  assertEquals(args.follow, false);
  assert(args.recurse === undefined);
  // The flag is true exactly where instance-launch runs on the same host.
  for (
    const [file, expected] of [
      ["playbooks/instance-install.yml", true],
      ["playbooks/daemon-colocated-refresh.yml", true],
      ["playbooks/daemon-install.yml", false],
    ] as const
  ) {
    const text = await Deno.readTextFile(
      join(DAEMON_ROOT, "orchestration", file),
    );
    assertEquals(
      /turbopanel_after_instance_service: true/.test(text),
      expected,
      file,
    );
  }
  const launch = await Deno.readTextFile(
    join(
      DAEMON_ROOT,
      "orchestration/roles/instance-launch/tasks/platform-runtime-dirs.yml",
    ),
  );
  assert(
    launch.includes('mode: "2770"') &&
      launch.includes("turbopanel_metrics_dir"),
  );
});

test("the command journal and release folders are leaves with their modes", () => {
  const modes = new Map(DAEMON_STATE_LEAVES.map((l) => [l.name, l.mode]));
  assertEquals(modes.get("commands"), "0750");
  assertEquals(modes.get("release-records"), "0750");
  assertEquals(modes.get("release-build"), "0700");
});

test("the ansible probe scratch folder is a state leaf", () => {
  const modes = new Map(DAEMON_STATE_LEAVES.map((l) => [l.name, l.mode]));
  assertEquals(modes.get("ansible"), "0750");
});
