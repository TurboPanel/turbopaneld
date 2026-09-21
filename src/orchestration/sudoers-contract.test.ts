import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { parse as parseYaml } from "yaml";
import { DAEMON_WRITABLE_VENDOR_DIRS } from "../permissions/daemon-permissions.ts";
import { PROD_RUNTIME_DIR_DEFAULT } from "../paths/layout.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const root = join(dirname(fromFileUrl(import.meta.url)), "../..");
const orch = join(root, "orchestration");

type Task = Record<string, unknown> & {
  name?: string;
  loop?: unknown;
  "ansible.builtin.file"?: Record<string, unknown>;
  "ansible.builtin.copy"?: Record<string, unknown>;
  "ansible.builtin.template"?: Record<string, unknown>;
};

async function readTasks(relPath: string): Promise<Task[]> {
  const doc = parseYaml(await Deno.readTextFile(join(orch, relPath)));
  if (!Array.isArray(doc)) throw new TypeError(`${relPath} is not a task list`);
  return doc as Task[];
}

async function readDefaults(role: string): Promise<Record<string, unknown>> {
  const doc = parseYaml(
    await Deno.readTextFile(join(orch, "roles", role, "defaults", "main.yml")),
  );
  if (typeof doc !== "object" || doc === null) {
    throw new TypeError(`${role} defaults are not a mapping`);
  }
  return doc as Record<string, unknown>;
}

const USER_TASKS = "roles/turbopanel-user/tasks/main.yml";
const LAYOUT_TASKS = "roles/daemon-layout/tasks/main.yml";
const SUDOERS_TEMPLATE = "roles/turbopanel-user/templates/sudoers.j2";
const DAEMON_INSTALL = "playbooks/daemon-install.yml";

test("production sudoers never grants NOPASSWD:ALL as root", async () => {
  const template = await Deno.readTextFile(join(orch, SUDOERS_TEMPLATE));
  for (const line of template.split("\n")) {
    if (line.trimStart().startsWith("#") || !line.includes("NOPASSWD")) {
      continue;
    }
    // Only the self re-exec (`(tp) NOPASSWD: ALL`) may carry ALL.
    if (/NOPASSWD:\s*ALL\b/.test(line)) {
      assertStringIncludes(
        line,
        "ALL=({{ turbopanel_user }}) NOPASSWD: ALL",
        `unexpected NOPASSWD: ALL grant: ${line}`,
      );
      assertEquals(
        /\(\s*(ALL|root)\s*\)\s*NOPASSWD:\s*ALL/.test(line),
        false,
        line,
      );
    }
    assertEquals(/\(ALL(:ALL)?\)/.test(line), false, `runas ALL: ${line}`);
  }
  // No task writes a sudoers file by inline content any more.
  for (const task of await readTasks(USER_TASKS)) {
    const copy = task["ansible.builtin.copy"];
    if (copy && String(copy.dest ?? "").startsWith("/etc/sudoers")) {
      throw new TypeError(`inline sudoers content in task ${task.name}`);
    }
    const tmpl = task["ansible.builtin.template"];
    if (tmpl && String(tmpl.dest ?? "").startsWith("/etc/sudoers")) {
      assertEquals(tmpl.src, "sudoers.j2");
      assertEquals(tmpl.validate, "visudo -cf %s");
      assertEquals(tmpl.mode, "0440");
    }
  }
});

test("every sudoers command is an absolute path or the orchestrate helper", async () => {
  const template = await Deno.readTextFile(join(orch, SUDOERS_TEMPLATE));
  for (const line of template.split("\n")) {
    const alias = /^Cmnd_Alias\s+\w+\s*=\s*(.+)$/.exec(line);
    if (!alias) continue;
    for (const raw of alias[1]!.split(",")) {
      // Jinja path variables render to absolute paths; treat them as such.
      const entry = raw.trim().replaceAll(/\{\{ turbopanel_\w+ \}\}/g, "/tp");
      const command = entry.split(/\s+/)[0] ?? "";
      assertEquals(
        command.startsWith("/"),
        true,
        `relative sudoers command: ${raw.trim()}`,
      );
      assertEquals(
        [
          "/bin/sh",
          "/bin/bash",
          "/usr/bin/sh",
          "/usr/bin/bash",
          "/usr/bin/sudo",
          "/usr/bin/su",
        ].includes(command),
        false,
        `shell in sudoers: ${command}`,
      );
    }
  }
  assertStringIncludes(template, "/scripts/tp-orchestrate");
  assertStringIncludes(template, "env_reset");
});

test("the install root and vendor tree are root-owned on managed hosts", async () => {
  const defaults = await readDefaults("turbopanel-user");
  const owner = String(defaults.turbopanel_install_owner ?? "");
  assertStringIncludes(owner, "else 'root'");
  const tasks = await readTasks(USER_TASKS);
  const byPath = new Map<string, Record<string, unknown>>();
  for (const task of tasks) {
    const file = task["ansible.builtin.file"];
    if (!file) continue;
    const loop = Array.isArray(task.loop) ? task.loop : [file.path];
    for (const item of loop) {
      byPath.set(String(item), file);
    }
  }
  for (
    const path of [
      "{{ turbopanel_install_root }}",
      "{{ turbopanel_vendor_dir }}",
      "{{ turbopanel_vendor_dir }}/uv",
      "{{ turbopanel_vendor_dir }}/python",
      "{{ turbopanel_vendor_dir }}/ansible",
    ]
  ) {
    const file = byPath.get(path);
    if (!file) throw new TypeError(`no task manages ${path}`);
    assertEquals(file.owner, "{{ turbopanel_install_owner }}", path);
    assertEquals(file.recurse ?? false, false, `${path} must not recurse`);
  }
  // The only recursive daemon-owned write under vendor is the cache list.
  for (const task of tasks) {
    const file = task["ansible.builtin.file"];
    if (!file || file.recurse !== true) continue;
    assertEquals(
      task.loop,
      "{{ turbopanel_daemon_vendor_cache_dirs }}",
      `unexpected recursive chown in task ${task.name}`,
    );
  }
});

test("the daemon-writable vendor cache matches DAEMON_WRITABLE_VENDOR_DIRS", async () => {
  const defaults = await readDefaults("turbopanel-user");
  const dirs = defaults.turbopanel_daemon_vendor_cache_dirs;
  if (!Array.isArray(dirs)) throw new TypeError("cache dirs missing");
  const rendered = dirs.map((d) =>
    String(d).replace("{{ turbopanel_vendor_dir }}", PROD_RUNTIME_DIR_DEFAULT)
  ).sort((a, b) => a.localeCompare(b));
  assertEquals(
    rendered,
    [...DAEMON_WRITABLE_VENDOR_DIRS].sort((a, b) => a.localeCompare(b)),
  );
  // Never a runtime the daemon is launched from, nor what root executes.
  for (const dir of rendered) {
    for (const forbidden of ["deno", "node", "python", "ansible", "bin"]) {
      assertEquals(
        dir.startsWith(`${PROD_RUNTIME_DIR_DEFAULT}/${forbidden}`),
        false,
        dir,
      );
    }
  }
});

test("daemon-install.yml no longer hands the vendor or orchestration trees to tp", async () => {
  const doc = parseYaml(await Deno.readTextFile(join(orch, DAEMON_INSTALL)));
  const play = (doc as Array<Record<string, unknown>>)[0]!;
  const post = play.post_tasks as Task[];
  for (const task of post) {
    const file = task["ansible.builtin.file"];
    if (!file || file.owner !== "{{ turbopanel_user }}") continue;
    const loop = Array.isArray(task.loop) ? task.loop.map(String) : [];
    for (const path of loop) {
      assertEquals(path.includes("vendor_dir"), false, `${task.name}: ${path}`);
      assertEquals(
        path.includes("orchestration_dir"),
        false,
        `${task.name}: ${path}`,
      );
    }
  }
});

test("daemon-layout keeps the orchestration tree, binaries and helper root-owned", async () => {
  const tasks = await readTasks(LAYOUT_TASKS);
  const layout = tasks.find((t) =>
    t.name === "Ensure production FHS directories exist"
  );
  if (!layout) throw new TypeError("layout task missing");
  const entries = layout.loop as Array<Record<string, unknown>>;
  const orchestration = entries.find((e) =>
    e.path === "{{ turbopanel_orchestration_dir }}"
  );
  assertEquals(orchestration?.owner, "root");
  for (
    const path of [
      "{{ turbopanel_install_root }}/bin",
      "{{ turbopanel_install_root }}/share",
      "{{ turbopanel_install_root }}/lib",
    ]
  ) {
    assertEquals(entries.find((e) => e.path === path)?.owner, "root", path);
  }
  const rootOwned = tasks.find((t) =>
    t.name === "Ensure the orchestration tree and binaries are root-owned"
  );
  if (!rootOwned) throw new TypeError("root-ownership task missing");
  assertEquals(rootOwned["ansible.builtin.file"]?.owner, "root");
  assertEquals(rootOwned["ansible.builtin.file"]?.recurse, true);
  const helpers = tasks.find((t) =>
    t.name ===
      "Ensure orchestration helpers are executable by the daemon group only"
  );
  if (!helpers) throw new TypeError("helper permissions task missing");
  assertEquals(helpers["ansible.builtin.file"]?.owner, "root");
  assertEquals(helpers["ansible.builtin.file"]?.mode, "0750");
  assertEquals((helpers.loop as string[]).includes("tp-orchestrate"), true);
});

test("the shipped tp-orchestrate helper is executable and POSIX sh", async () => {
  const path = join(orch, "scripts", "tp-orchestrate");
  const info = await Deno.stat(path);
  assertEquals(((info.mode ?? 0) & 0o111) !== 0, true, "must be executable");
  const source = await Deno.readTextFile(path);
  assertEquals(source.startsWith("#!/bin/sh\n"), true);
  const check = await new Deno.Command("sh", { args: ["-n", path] }).output();
  assertEquals(check.success, true);
});
