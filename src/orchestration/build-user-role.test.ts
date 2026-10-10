import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { parse } from "yaml";
import { DAEMON_ROOT } from "./assets.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/**
 * The build-user role (`orchestration/roles/build-user`): the tree
 * `tp-host build-run` runs sandboxed builds from. Builds run as a throwaway
 * user systemd creates for each one (DynamicUser=yes) in the site owner's own
 * slice, so the role creates no account; it retires the shared `tpbuild`
 * account, its cache and `tpbuild.slice`. tp-host checks the tree on every run
 * and refuses to build otherwise, so these pin what it expects:
 * `/var/lib/turbopanel-build` root:tp 0710, `work/` root:tp 1770 and
 * `caches/` root:root 0700.
 */
const ORCHESTRATION = join(DAEMON_ROOT, "orchestration");
const ROLE = join(ORCHESTRATION, "roles/build-user");

type Task = Record<string, unknown> & { name?: string; when?: unknown };

async function readYaml<T>(path: string): Promise<T> {
  return parse(await Deno.readTextFile(path)) as T;
}

async function roleTasks(): Promise<Task[]> {
  return await readYaml<Task[]>(join(ROLE, "tasks/main.yml"));
}

function moduleArgs(task: Task, module: string): Record<string, unknown> {
  const args = task[`ansible.builtin.${module}`];
  assert(args, `${task.name}: expected ansible.builtin.${module}`);
  return args as Record<string, unknown>;
}

function tasksUsing(tasks: Task[], module: string): Task[] {
  return tasks.filter((task) => `ansible.builtin.${module}` in task);
}

test("build-user defaults pin tp-host's layout and the retired account", async () => {
  const defaults = await readYaml<Record<string, unknown>>(
    join(ROLE, "defaults/main.yml"),
  );
  assertEquals(defaults.build_root, "/var/lib/turbopanel-build");
  assertEquals(defaults.build_retired_user, "tpbuild");
  assertEquals(defaults.build_retired_uid, 9994);
  assertEquals(defaults.build_retired_slice, "tpbuild.slice");
  for (
    const gone of ["build_user", "build_group", "build_uid", "build_slice"]
  ) {
    assertEquals(gone in defaults, false, `${gone} is retired`);
  }
});

test("the role creates no account and removes the shared build account", async () => {
  const tasks = await roleTasks();
  const users = tasksUsing(tasks, "user").map((task) =>
    moduleArgs(task, "user")
  );
  const groups = tasksUsing(tasks, "group").map((task) =>
    moduleArgs(task, "group")
  );
  assertEquals(users, [{ name: "{{ build_retired_user }}", state: "absent" }]);
  assertEquals(groups, [{ name: "{{ build_retired_user }}", state: "absent" }]);
});

test("the build tree matches what tp-host build-run checks", async () => {
  const dirs = tasksUsing(await roleTasks(), "file").map((task) =>
    moduleArgs(task, "file")
  );
  const expected = [
    {
      path: "{{ build_root }}",
      group: "{{ turbopanel_group }}",
      mode: "0710",
    },
    {
      path: "{{ build_root }}/work",
      group: "{{ turbopanel_group }}",
      mode: "1770",
    },
    { path: "{{ build_root }}/caches", group: "root", mode: "0700" },
  ];
  for (const want of expected) {
    const dir = dirs.find((args) => args.path === want.path);
    assert(dir, `expected a task for ${want.path}`);
    assertEquals(dir.state, "directory");
    assertEquals(dir.owner, "root", want.path);
    assertEquals(dir.group, want.group, want.path);
    assertEquals(dir.mode, want.mode, want.path);
    assertEquals(dir.recurse, undefined, `${want.path} must not recurse`);
  }
});

test("the role removes the retired shared cache and tpbuild.slice", async () => {
  const tasks = await roleTasks();
  const removed = tasksUsing(tasks, "file")
    .map((task) => ({ task, args: moduleArgs(task, "file") }))
    .filter(({ args }) => args.state === "absent");
  assertEquals(removed.map(({ args }) => args.path), [
    "{{ build_root }}/cache",
    "/etc/systemd/system/{{ build_retired_slice }}",
  ]);
  assertEquals(
    removed[1].task.notify,
    "Reload systemd for the build slice",
  );
  assertEquals(tasksUsing(tasks, "template"), []);
  const templates = await Array.fromAsync(
    Deno.readDir(join(ROLE, "templates")),
  ).catch(() => []);
  assertEquals(templates, []);
});

test("every daemon playbook runs build-user unconditionally", async () => {
  for (
    const playbook of [
      "daemon-converge.yml",
      "daemon-install.yml",
      "daemon-colocated-refresh.yml",
    ]
  ) {
    const [play] = await readYaml<{ roles: Task[] }[]>(
      join(ORCHESTRATION, "playbooks", playbook),
    );
    const entry = play.roles.find((role) => role.role === "build-user");
    assert(entry, `${playbook} must run the build-user role`);
    assertEquals(entry.when, undefined, `${playbook}: build-user is gated`);
  }
});

test("node-app-runtime adds no account to any group", async () => {
  const defaults = await readYaml<Record<string, unknown>>(
    join(ORCHESTRATION, "roles/node-app-runtime/defaults/main.yml"),
  );
  assertEquals("node_app_build_user" in defaults, false);
  const tasks = await readYaml<Task[]>(
    join(ORCHESTRATION, "roles/node-app-runtime/tasks/vendor-series.yml"),
  );
  // Every site owner's Linux user, the daemon and a build may run every
  // installed series: the tree is readable by everyone, so nobody joins a
  // group for it.
  assertEquals(tasksUsing(tasks, "user"), []);
});
