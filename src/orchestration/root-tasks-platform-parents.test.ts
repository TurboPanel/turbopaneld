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

test("no root file task recurses below a platform parent", async () => {
  const offenders: string[] = [];
  for (const path of await yamlFiles()) {
    const doc = parse(await Deno.readTextFile(path));
    for (const task of tasksIn(doc)) {
      const file = task["ansible.builtin.file"] as
        | Record<string, unknown>
        | undefined;
      if (!file || file.recurse !== true) continue;
      const loop = Array.isArray(task.loop) ? task.loop.map(String) : [];
      const targets = [String(file.path), ...loop];
      if (targets.some((target) => PLATFORM_PARENT.test(target))) {
        offenders.push(`${relative(ORCHESTRATION, path)}: ${task.name}`);
      }
    }
  }
  assert(offenders.length === 0, offenders.join("\n"));
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
