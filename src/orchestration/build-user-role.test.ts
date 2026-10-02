import { assert, assertEquals, assertStringIncludes } from "@std/assert";
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
 * The build-user role (`orchestration/roles/build-user`): the account, tree and
 * slice `tp-host build-run` runs sandboxed tenant builds in. tp-host checks the
 * same shape on every run and refuses to build otherwise, so these pin what it
 * expects: tpbuild outside docker and tp, `/var/lib/turbopanel-build` root
 * 0711, `work/` root:tp 1770, `cache/` root 0700, and `tpbuild.slice`.
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

test("build-user defaults pin tpbuild at 9994 and tp-host's layout", async () => {
  const defaults = await readYaml<Record<string, unknown>>(
    join(ROLE, "defaults/main.yml"),
  );
  assertEquals(defaults.build_user, "tpbuild");
  assertEquals(defaults.build_group, "tpbuild");
  assertEquals(defaults.build_uid, 9994);
  assertEquals(defaults.build_gid, 9994);
  assertEquals(defaults.build_root, "/var/lib/turbopanel-build");
  assertEquals(defaults.build_slice, "tpbuild.slice");
});

test("the build account is a nologin system user with no home and no free group list", async () => {
  const users = tasksUsing(await roleTasks(), "user");
  const account = users.find((task) => !("groups" in moduleArgs(task, "user")));
  assert(account, "expected a task that creates the build account");
  const args = moduleArgs(account, "user");
  assertEquals(args.name, "{{ build_user }}");
  assertEquals(args.uid, "{{ build_uid }}");
  assertEquals(args.group, "{{ build_group }}");
  assertEquals(args.home, "/nonexistent");
  assertEquals(args.create_home, false);
  assertEquals(args.shell, "/usr/sbin/nologin");
  assertEquals(args.system, true);

  // Any group list must append Node runtime groups only: a bare `groups:`
  // would either strip node-app-runtime's appends or add something else.
  for (const task of users.filter((t) => t !== account)) {
    const grant = moduleArgs(task, "user");
    assertEquals(grant.append, true, `${task.name} must append`);
    const vars = JSON.stringify(task.vars ?? {});
    assertStringIncludes(vars, "runtimes.node.series");
  }
});

test("the converge refuses a build account in docker, tp or sudo", async () => {
  const asserts = tasksUsing(await roleTasks(), "assert");
  const refusal = asserts.find((task) =>
    JSON.stringify(task.loop ?? []).includes("docker")
  );
  assert(refusal, "expected an assert over the build account's groups");
  const loop = refusal.loop as string[];
  for (const group of ["docker", "{{ turbopanel_group }}", "sudo"]) {
    assert(loop.includes(group), `assert must cover ${group}`);
  }
});

test("the build tree matches what tp-host build-run checks", async () => {
  const dirs = tasksUsing(await roleTasks(), "file").map((task) =>
    moduleArgs(task, "file")
  );
  const expected = [
    { path: "{{ build_root }}", group: "root", mode: "0711" },
    {
      path: "{{ build_root }}/work",
      group: "{{ turbopanel_group }}",
      mode: "1770",
    },
    { path: "{{ build_root }}/cache", group: "root", mode: "0700" },
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

test("the role installs tpbuild.slice root-owned with no limits of its own", async () => {
  const [slice] = tasksUsing(await roleTasks(), "template");
  const args = moduleArgs(slice, "template");
  assertEquals(args.src, "tpbuild.slice.j2");
  assertEquals(args.dest, "/etc/systemd/system/{{ build_slice }}");
  assertEquals(args.owner, "root");
  assertEquals(args.mode, "0644");
  assertEquals(slice.notify, "Reload systemd for the build slice");

  const unit = await Deno.readTextFile(
    join(ROLE, "templates/tpbuild.slice.j2"),
  );
  assertStringIncludes(unit, "[Slice]");
  for (const key of ["User=", "Delegate=", "ExecStart="]) {
    assertEquals(unit.includes(key), false, `slice must not set ${key}`);
  }
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

test("node-app-runtime adds the build account to each series it vendors", async () => {
  const defaults = await readYaml<Record<string, unknown>>(
    join(ORCHESTRATION, "roles/node-app-runtime/defaults/main.yml"),
  );
  assertEquals(defaults.node_app_build_user, "tpbuild");

  const tasks = await readYaml<Task[]>(
    join(ORCHESTRATION, "roles/node-app-runtime/tasks/vendor-series.yml"),
  );
  const grant = tasksUsing(tasks, "user").find((task) =>
    moduleArgs(task, "user").name === "{{ node_app_build_user }}"
  );
  assert(grant, "expected the build account's series append");
  const args = moduleArgs(grant, "user");
  assertEquals(args.groups, "{{ node_app_series_group }}");
  assertEquals(args.append, true);
  // The play can run before build-user has converged; it must not create the
  // account (without its uid) or fail on a host that lacks it.
  assertStringIncludes(String(grant.when), "getent_passwd");
});
