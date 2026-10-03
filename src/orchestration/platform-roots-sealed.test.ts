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

test("the roles that own a root agree on who owns it", async () => {
  const sets = await Promise.all([
    "roles/daemon-layout",
    "roles/daemon-config",
    "roles/turbopanel-user",
  ].map((role) => yaml<Args>(`${role}/defaults/main.yml`)));
  const [first, ...rest] = sets;
  for (const key of SEAL_KEYS) assert(typeof first[key] === "string", key);
  for (const other of rest) {
    for (const key of SEAL_KEYS) assertEquals(other[key], first[key], key);
  }
  // Dev (a dev user set) keeps its own ownership; managed hosts are root.
  assert(String(first.turbopanel_seal_config_root).includes("length == 0"));
  assert(String(first.turbopanel_config_root_owner).startsWith("{{ 'root' if"));
  const logs = await yaml<Args>("roles/daemon-logs/defaults/main.yml");
  assert(String(logs.daemon_log_dir_owner).startsWith("{{ 'root' if"));
});

test("daemon-layout seals the roots, sweeps planted links, then creates the leaves", async () => {
  const tasks = await yaml<Task[]>("roles/daemon-layout/tasks/main.yml");
  const names = tasks.map((task) => String(task.name));
  const roots = names.indexOf("Ensure the config and state roots");
  const sweep = names.indexOf(
    "Remove links planted at the top of the config and state roots",
  );
  const fhs = names.indexOf("Ensure production FHS directories exist");
  const config = names.indexOf("Ensure the daemon-writable config folders");
  const state = names.indexOf("Ensure the daemon-writable state folders");
  assert(roots === 0, "the roots come first");
  assert(roots < sweep && sweep < fhs && fhs < config && config < state);

  const file = tasks[roots]["ansible.builtin.file"] as Args;
  assertEquals(file.owner, "{{ item.owner }}");
  assertEquals(file.follow, false);
  const loop = tasks[roots].loop as Array<Record<string, string>>;
  assertEquals(loop.map((item) => item.owner), [
    "{{ turbopanel_config_root_owner }}",
    "{{ turbopanel_state_root_owner }}",
  ]);

  const argv = (tasks[sweep]["ansible.builtin.command"] as { argv: string[] })
    .argv;
  assertEquals(argv.slice(0, 1), ["find"]);
  for (const part of ["-maxdepth", "-type", "l", "-delete"]) {
    assert(argv.includes(part), part);
  }
  assert(!argv.includes("-L") && !argv.includes("-follow"));
});

test("the flip does not leave tp as owner of a root anywhere on the managed path", async () => {
  const rootOwnerTasks: Array<[string, string]> = [
    ["roles/daemon-config/tasks/main.yml", "Ensure daemon state directory"],
    ["roles/daemon-config/tasks/main.yml", "Ensure config directory"],
    ["playbooks/daemon-install.yml", "Keep the state directory root-owned"],
    ["playbooks/daemon-install.yml", "Keep the config tree root-owned"],
  ];
  for (const [path, name] of rootOwnerTasks) {
    const doc = await yaml<unknown>(path);
    const found = findTask(doc, name);
    assert(found, `${path}: ${name}`);
    const file = found["ansible.builtin.file"] as Args;
    assert(
      /root_owner/.test(String(file.owner)),
      `${name}: owner ${file.owner}`,
    );
    assertEquals(file.follow, false, name);
  }
  const play = (await yaml<Array<Args>>("playbooks/daemon-install.yml"))[0];
  const vars = play.vars as Args;
  assertEquals(vars.turbopanel_config_root_owner, "root");
  assertEquals(vars.turbopanel_state_root_owner, "root");
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
