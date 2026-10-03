import { assert } from "@std/assert";
import { join, relative } from "@std/path";
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
 * P1-1: root Ansible must never walk or re-own what the daemon account can
 * rewrite. `/etc/turbopanel` and `/var/lib/turbopanel` hold folders `tp`
 * writes, so a root `file` task with `recurse` or an ACL below them follows
 * whatever `tp` swapped in. Per-entry work belongs to `tp-host`, a task that
 * runs as the owner, or nothing at all.
 */
const ORCHESTRATION = join(DAEMON_ROOT, "orchestration");
const PLATFORM_PARENT =
  /turbopanel_(config|state|daemon_state|log)_dir|\/etc\/turbopanel|\/var\/lib\/turbopanel|\/var\/log\/turbopanel/;

type Node = unknown;

function* tasksIn(node: Node): Generator<Record<string, unknown>> {
  if (Array.isArray(node)) {
    for (const item of node) yield* tasksIn(item);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if ("ansible.builtin.file" in record || "ansible.posix.acl" in record) {
    yield record;
  }
  for (const value of Object.values(record)) yield* tasksIn(value);
}

async function collect(dir: string, files: string[]): Promise<void> {
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) await collect(path, files);
    else if (entry.name.endsWith(".yml")) files.push(path);
  }
}

async function yamlFiles(): Promise<string[]> {
  const all: string[] = [];
  await collect(ORCHESTRATION, all);
  return all.filter((path) => {
    const rel = relative(ORCHESTRATION, path);
    return !rel.startsWith("roles/") || rel.includes("/tasks/");
  });
}

/**
 * Root `file` tasks that may recurse, each over a tree only root can write
 * (`path: task name`). Anything else that recurses is a walk over a tree a
 * non-root account may be able to rewrite: a swapped-in link turns the walk
 * into an arbitrary chown/chmod. Add an entry only for a root-sealed tree.
 */
const ROOT_SEALED_RECURSE = new Set([
  "roles/buildkit/tasks/main.yml: Harden vendored Railpack frontend permissions",
  "roles/daemon-layout/tasks/main.yml: Ensure the orchestration tree and binaries are root-owned",
  "roles/openlitespeed/tasks/lsphp-series.yml: Scope the lsphp tree to its PHP entitlement group ({{ lsphp_series }})",
]);

function recurses(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false &&
    !/^(false|no|off|0)$/i.test(String(value));
}

async function recursingTasks(): Promise<string[]> {
  const found: string[] = [];
  for (const path of await yamlFiles()) {
    const doc = parse(await Deno.readTextFile(path));
    for (const task of tasksIn(doc)) {
      const file = task["ansible.builtin.file"] as
        | Record<string, unknown>
        | undefined;
      if (file && recurses(file.recurse)) {
        found.push(`${relative(ORCHESTRATION, path)}: ${task.name}`);
      }
    }
  }
  return found;
}

test("no root file task recurses unless its tree is root-sealed", async () => {
  const offenders = (await recursingTasks()).filter(
    (key) => !ROOT_SEALED_RECURSE.has(key),
  );
  assert(offenders.length === 0, offenders.join("\n"));
});

test("the recurse allowlist has no stale entries", async () => {
  const seen = new Set(await recursingTasks());
  const stale = [...ROOT_SEALED_RECURSE].filter((key) => !seen.has(key));
  assert(stale.length === 0, stale.join("\n"));
});

test("an ACL task below a platform parent never follows a link or recurses", async () => {
  const offenders: string[] = [];
  for (const path of await yamlFiles()) {
    const doc = parse(await Deno.readTextFile(path));
    for (const task of tasksIn(doc)) {
      const acl = task["ansible.posix.acl"] as
        | Record<string, unknown>
        | undefined;
      if (!acl || !PLATFORM_PARENT.test(String(acl.path))) continue;
      if (acl.recursive === true || acl.follow !== false) {
        // The config directory's own traversal ACL is on the sealed root.
        if (String(acl.path).trim() === "{{ item }}") continue;
        offenders.push(`${relative(ORCHESTRATION, path)}: ${task.name}`);
      }
    }
  }
  assert(offenders.length === 0, offenders.join("\n"));
});
