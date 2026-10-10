import { assert, assertEquals } from "@std/assert";
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
  if (
    "ansible.builtin.file" in record || "ansible.posix.acl" in record ||
    "ansible.builtin.shell" in record || "ansible.builtin.command" in record
  ) {
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
  "roles/apache/tasks/main.yml: Make the vendored Apache tree root-owned and not group/world writable",
  "roles/buildkit/tasks/main.yml: Harden vendored Railpack frontend permissions",
  "roles/daemon-layout/tasks/main.yml: Ensure the orchestration tree and binaries are root-owned",
  "roles/openlitespeed/tasks/lsphp-series.yml: Make the lsphp tree root-owned and not group/world writable ({{ lsphp_series }})",
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

function commandText(task: Record<string, unknown>): string {
  const body =
    (task["ansible.builtin.shell"] ?? task["ansible.builtin.command"]) as
      | string
      | Record<string, unknown>
      | undefined;
  if (body === undefined) return "";
  if (typeof body === "string") return body;
  const argv = Array.isArray(body.argv) ? body.argv.join(" ") : "";
  return `${body.cmd ?? ""} ${argv}`;
}

test("no shell or command task chowns or chmods recursively over a path", async () => {
  const offenders: string[] = [];
  for (const path of await yamlFiles()) {
    const doc = parse(await Deno.readTextFile(path));
    for (const task of tasksIn(doc)) {
      if (task["ansible.builtin.file"] || task["ansible.posix.acl"]) continue;
      // The proxysql pre-own runs chown -R inside a throwaway container, where
      // -R does not follow links (it never touches the host's own files).
      if (/docker\s+run/.test(commandText(task))) continue;
      if (/\bch(own|mod)\s+(-[a-zA-Z]*R|--recursive)/.test(commandText(task))) {
        offenders.push(`${relative(ORCHESTRATION, path)}: ${task.name}`);
      }
    }
  }
  assert(offenders.length === 0, offenders.join("\n"));
});

const DAEMON_WRITABLE_ROLES = ["orchestrator", "proxysql"];

async function tasksOfRole(role: string) {
  const path = join(ORCHESTRATION, "roles", role, "tasks", "main.yml");
  return [...tasksIn(parse(await Deno.readTextFile(path)))];
}

test("orchestrator and proxysql tasks never chown/chmod through a name the daemon user can swap", async () => {
  const offenders: string[] = [];
  for (const role of DAEMON_WRITABLE_ROLES) {
    for (const task of await tasksOfRole(role)) {
      if (task["ansible.builtin.file"]) {
        const file = task["ansible.builtin.file"] as Record<string, unknown>;
        if (file.follow !== false) offenders.push(`${role}: ${task.name}`);
      } else if (/\bch(own|mod)\b/.test(commandText(task))) {
        // Shell tasks create files with `install`, which replaces the name.
        if (!/docker\s+run/.test(commandText(task))) {
          offenders.push(`${role}: ${task.name}`);
        }
      }
    }
  }
  assert(offenders.length === 0, offenders.join("\n"));
});

test("shell tasks that write daemon-writable cnf files drop links first and use install", async () => {
  const offenders: string[] = [];
  for (const role of DAEMON_WRITABLE_ROLES) {
    for (const task of await tasksOfRole(role)) {
      const cmd = commandText(task);
      if (!/\.cnf'/.test(cmd) || !task["ansible.builtin.shell"]) continue;
      if (!/\[ -L "\$f" \]/.test(cmd) || !/\binstall -m/.test(cmd)) {
        offenders.push(`${role}: ${task.name}`);
      }
    }
  }
  assert(offenders.length === 0, offenders.join("\n"));
});

test("root-run readiness scripts live in a root-only directory, not the daemon-writable config dir", async () => {
  for (const role of DAEMON_WRITABLE_ROLES) {
    const unit = await Deno.readTextFile(
      join(
        ORCHESTRATION,
        "roles",
        role,
        "templates",
        `turbopanel-${role}-stack.service.j2`,
      ),
    );
    assert(
      !/_config_dir \}\}\/wait-ready\.sh/.test(unit),
      `${role} unit runs a script from its config dir`,
    );
    assert(
      unit.includes(`${role}_wait_ready_script`),
      `${role} unit must use the libexec script`,
    );
    const tasks = await tasksOfRole(role);
    const dir = tasks.find((t) =>
      String(
        (t["ansible.builtin.file"] as Record<string, unknown> | undefined)
          ?.path,
      ) ===
        `{{ ${role}_libexec_dir }}`
    );
    const file = dir?.["ansible.builtin.file"] as Record<string, unknown>;
    assert(
      file && file.owner === "root" && file.group === "root" &&
        file.mode === "0750",
      `${role} libexec dir must be root:root 0750`,
    );
  }
});

test("orchestrator host-prep marker is daemon-readable in the config dir", async () => {
  const tasks = await tasksOfRole("orchestrator");
  const marker = tasks.find((t) =>
    String(t.name).includes("Mark Orchestrator host prep complete")
  );
  const file = marker?.["ansible.builtin.file"] as Record<string, unknown>;
  assert(file, "orchestrator role must touch host-prep.ok");
  assertEquals(file.path, "{{ orchestrator_config_dir }}/host-prep.ok");
  assertEquals(file.owner, "{{ turbopanel_user }}");
  assertEquals(file.group, "{{ turbopanel_group }}");
  assertEquals(file.mode, "0640");
});
