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
 * P1-1: `/etc/turbopanel`, `/var/lib/turbopanel` and `/var/log/turbopanel` are
 * root-owned on managed hosts. The daemon account owns only the leaves below
 * them, so nothing root does at the top of those trees can be redirected by a
 * link the daemon planted.
 */
const ORCH = join(DAEMON_ROOT, "orchestration");

type Task = Record<string, unknown> & { name?: string };
type Args = Record<string, unknown>;

async function yaml<T>(rel: string): Promise<T> {
  return parse(await Deno.readTextFile(join(ORCH, rel))) as T;
}

const SEAL_KEYS = [
  "turbopanel_seal_config_root",
  "turbopanel_seal_state_root",
  "turbopanel_config_root_owner",
  "turbopanel_state_root_owner",
];

test("only daemon-seal defines who owns a root, and daemon-logs agrees", async () => {
  const seal = await yaml<Args>("roles/daemon-seal/defaults/main.yml");
  for (const key of SEAL_KEYS) assert(typeof seal[key] === "string", key);
  // Dev (a dev user set) keeps its own ownership; managed hosts are root.
  assert(String(seal.turbopanel_seal_config_root).includes("length == 0"));
  assert(String(seal.turbopanel_config_root_owner).startsWith("{{ 'root' if"));
  for (
    const role of ["daemon-layout", "daemon-config", "turbopanel-user"]
  ) {
    const defaults = await yaml<Args>(`roles/${role}/defaults/main.yml`);
    for (const key of SEAL_KEYS) assert(!(key in defaults), `${role}: ${key}`);
  }
  const logs = await yaml<Args>("roles/daemon-logs/defaults/main.yml");
  assert(String(logs.daemon_log_dir_owner).startsWith("{{ 'root' if"));
});

test("the seal and the planted-link sweep run together, last before the daemon starts", async () => {
  // daemon-launch (the last role of every playbook) pulls daemon-seal in.
  const meta = await yaml<{ dependencies: Array<{ role: string }> }>(
    "roles/daemon-launch/meta/main.yml",
  );
  assert(meta.dependencies.some((dep) => dep.role === "daemon-seal"));

  // No role or play before it re-owns a root: they must leave the owner alone.
  const early: Array<[string, string]> = [
    ["roles/turbopanel-user/tasks/main.yml", "Ensure FHS state directories"],
    ["roles/daemon-config/tasks/main.yml", "Ensure daemon state directory"],
    ["roles/daemon-config/tasks/main.yml", "Ensure config directory"],
  ];
  for (const [path, name] of early) {
    const file = findTask(await yaml<unknown>(path), name)![
      "ansible.builtin.file"
    ] as Args;
    assertEquals(file.follow, false, name);
    assert(
      !/root_owner/.test(String(file.owner)) && file.owner !== "root",
      `${name} must not flip a root early`,
    );
  }
  const fhs = findTask(
    await yaml<unknown>("roles/turbopanel-user/tasks/main.yml"),
    "Ensure FHS state directories",
  )!["ansible.builtin.file"] as Args;
  assertEquals(fhs.owner, "{{ item.owner | default(omit) }}");

  const tasks = await yaml<Task[]>("roles/daemon-seal/tasks/main.yml");
  const names = tasks.map((task) => String(task.name));
  const check = names.indexOf("Check the config and state roots are not links");
  const roots = names.indexOf("Ensure the config and state roots");
  const sweep = names.indexOf(
    "Remove links planted at the top of the config and state roots",
  );
  assert(check === 0 && check < roots && roots < sweep);

  const file = tasks[roots]["ansible.builtin.file"] as Args;
  assertEquals(file.owner, "{{ item.owner }}");
  assertEquals(file.follow, false);
  const loop = tasks[roots].loop as Array<Record<string, string>>;
  assertEquals(loop.map((item) => item.owner), [
    "{{ turbopanel_config_root_owner }}",
    "{{ turbopanel_state_root_owner }}",
  ]);
});

test("the sweep only removes links the daemon planted, never an administrator's", async () => {
  const tasks = await yaml<Task[]>("roles/daemon-seal/tasks/sweep.yml");
  const task = tasks.find((t) => "ansible.builtin.command" in t)!;
  const argv = (task["ansible.builtin.command"] as { argv: string[] }).argv;
  assertEquals(argv.slice(0, 1), ["find"]);
  for (const part of ["-maxdepth", "-type", "l", "-delete"]) {
    assert(argv.includes(part), part);
  }
  // `! -user root`, before -delete: an admin's link (root-owned) stays.
  const not = argv.indexOf("!");
  assertEquals(argv.slice(not, not + 3), ["!", "-user", "root"]);
  assert(not < argv.indexOf("-delete"));
  assert(!argv.includes("-L") && !argv.includes("-follow"));

  // daemon-layout runs the same sweep before it creates the leaves.
  const layout = await yaml<Task[]>("roles/daemon-layout/tasks/main.yml");
  const include = layout[0]["ansible.builtin.include_role"] as Args;
  assertEquals(include, { name: "daemon-seal", tasks_from: "sweep" });
});

test("a root that is a symbolic link aborts the converge with a message", async () => {
  const tasks = await yaml<Task[]>(
    "roles/daemon-seal/tasks/roots-not-links.yml",
  );
  const stat = tasks.find((t) => "ansible.builtin.stat" in t)!;
  assertEquals((stat["ansible.builtin.stat"] as Args).follow, false);
  const gate = tasks.find((t) => "ansible.builtin.assert" in t)!;
  const assertion = gate["ansible.builtin.assert"] as Args;
  assert(JSON.stringify(assertion.that).includes("islnk"));
  assert(String(assertion.fail_msg).includes("symbolic link"));
});

test("daemon-install seals both roots through the variables, like the other playbooks", async () => {
  const play = (await yaml<Array<Args>>("playbooks/daemon-install.yml"))[0];
  const vars = play.vars as Args;
  assertEquals(vars.turbopanel_seal_config_root, true);
  assertEquals(vars.turbopanel_seal_state_root, true);
  assert(!("turbopanel_config_root_owner" in vars));
  assert(!("turbopanel_state_root_owner" in vars));
});

test("co-located control-plane playbooks keep the state root shared until the hand-off is reworked", async () => {
  for (
    const path of [
      "playbooks/instance-install.yml",
      "playbooks/daemon-colocated-refresh.yml",
    ]
  ) {
    const play = (await yaml<Array<Args>>(path))[0];
    assertEquals(
      (play.vars as Args).turbopanel_seal_state_root,
      false,
      path,
    );
  }
});

function findTask(node: unknown, name: string): Task | undefined {
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findTask(item, name);
      if (hit) return hit;
    }
    return undefined;
  }
  if (node === null || typeof node !== "object") return undefined;
  const record = node as Task;
  if (record.name === name && "ansible.builtin.file" in record) return record;
  for (const value of Object.values(record)) {
    const hit = findTask(value, name);
    if (hit) return hit;
  }
  return undefined;
}
