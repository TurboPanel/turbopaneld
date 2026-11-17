import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { parse } from "yaml";
import { DAEMON_ROOT } from "./assets.ts";
import { DAEMON_WRITABLE_VENDOR_DIRS } from "../permissions/daemon-permissions.ts";

/** Sonar typescript:S2187 only recognizes `test()`; see other suites here. */
const test = Deno.test.bind(Deno);

/**
 * Vendored runtimes are root-owned with group tp (src/permissions/AGENTS.md).
 * The Caddy folders used to stay root:root 0755 from `install -d`, and uv
 * leaves its lock files 0666; these pin the tasks that repair both.
 */

const ROLES = join(DAEMON_ROOT, "orchestration/roles");

type Task = Record<string, unknown>;

/** A task file's tasks, with the tasks inside `block:` lifted out. */
async function tasks(role: string, file = "main.yml"): Promise<Task[]> {
  const flat = (list: Task[]): Task[] =>
    list.flatMap((t) => [t, ...flat((t.block as Task[] | undefined) ?? [])]);
  return flat(
    parse(await Deno.readTextFile(join(ROLES, role, "tasks", file))) as Task[],
  );
}

/** Where a role's main.yml imports another task file (-1 when it does not). */
function importIndex(list: Task[], file: string): number {
  return list.findIndex((t) =>
    t["ansible.builtin.import_tasks"] === file
  );
}

function args(task: Task, module: string): Record<string, unknown> {
  return task[module] as Record<string, unknown>;
}

function loopItems(task: Task): string[] {
  return (task.loop as unknown[]).map(String);
}

const CADDY_DIRS = [
  "{{ turbopanel_vendor_dir }}/caddy",
  "{{ turbopanel_vendor_dir }}/caddy/{{ caddy_version }}",
];

/** A mode string grants nothing to "other" when it names only u and g. */
function noOtherBits(mode: string): boolean {
  if (/^0?[0-7]{3}$/.test(mode)) return mode.endsWith("0");
  return mode.split(",").every((part) => /^[ug]+[=+-]/.test(part));
}

test("the Caddy runtime folders are root:tp and only traversable by others", async () => {
  const caddy = await tasks("caddy");
  const install = caddy.findIndex((t) =>
    String(t.name).startsWith("Install Caddy into runtimes directory")
  );
  assert(install >= 0, "the install task is still there");

  // Fixed after install -d made them, by the file a daemon update runs too.
  assert(
    importIndex(caddy, "repair-modes.yml") > install,
    "the install imports the repair after install -d",
  );
  const repair = await tasks("caddy", "repair-modes.yml");
  const dirs = repair.findIndex((t) =>
    args(t, "ansible.builtin.file")?.state === "directory"
  );
  assert(dirs >= 0, "the folders are fixed");
  const dirArgs = args(repair[dirs], "ansible.builtin.file");
  assertEquals(loopItems(repair[dirs]), CADDY_DIRS);
  assertEquals(dirArgs.owner, "root");
  assertEquals(dirArgs.group, "{{ turbopanel_group }}");
  assert(noOtherBits(String(dirArgs.mode)), "no listing for other accounts");

  // The hosting Caddy's account is not in group tp: it needs traverse.
  const acl = repair.find((t) => t["ansible.posix.acl"] !== undefined);
  assert(acl, "an ACL lets every account traverse the folders");
  const aclArgs = args(acl, "ansible.posix.acl");
  assertEquals(aclArgs.etype, "other");
  assertEquals(aclArgs.permissions, "x");
  assertEquals(loopItems(acl), CADDY_DIRS);

  const binary = caddy.find((t) =>
    String(t.name) === "Harden Caddy binary permissions"
  );
  assert(binary, "the binary is still hardened");
  assertEquals(args(binary, "ansible.builtin.file").mode, "0750");
});

test("uv lock files are owner-writable only, with the owner of their tree", async () => {
  assert(
    importIndex(await tasks("turbopanel-user"), "vendor-locks.yml") >= 0,
    "the install imports the lock repair",
  );
  const user = await tasks("turbopanel-user", "vendor-locks.yml");

  const find = user.find((t) => {
    const a = args(t, "ansible.builtin.find");
    return a?.patterns === ".lock";
  });
  assert(find, "the interpreter and Ansible locks are found");
  const findArgs = args(find, "ansible.builtin.find");
  assertEquals(findArgs.hidden, true);
  assertEquals(findArgs.depth, 2);
  assertEquals(findArgs.paths, [
    "{{ turbopanel_vendor_dir }}/python",
    "{{ turbopanel_vendor_dir }}/ansible",
  ]);

  const runtimeLocks = user.find((t) =>
    String(t.loop ?? "").includes(String(find.register))
  );
  assert(runtimeLocks, "the found locks are fixed");
  const runtimeArgs = args(runtimeLocks, "ansible.builtin.file");
  assertEquals(runtimeArgs.owner, "{{ turbopanel_install_owner }}");
  assertEquals(runtimeArgs.mode, "0640");

  // The cache is the one daemon-writable folder among them, so its lock
  // belongs to the daemon account, not root.
  assert(DAEMON_WRITABLE_VENDOR_DIRS.some((d) => d.endsWith("/uv/cache")));
  const cacheLock = user.find((t) =>
    args(t, "ansible.builtin.file")?.path ===
      "{{ turbopanel_vendor_dir }}/uv/cache/.lock"
  );
  assert(cacheLock, "the cache lock is fixed");
  const cacheArgs = args(cacheLock, "ansible.builtin.file");
  assertEquals(cacheArgs.owner, "{{ turbopanel_user }}");
  assertEquals(cacheArgs.mode, "0640");
  assertEquals(cacheArgs.follow, false);
});
