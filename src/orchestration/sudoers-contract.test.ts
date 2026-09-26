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

test("tp-update-guard is not granted via sudoers (root systemd only)", async () => {
  const template = await Deno.readTextFile(join(orch, SUDOERS_TEMPLATE));
  assertStringIncludes(
    template,
    "tp-update-guard runs only as root via systemd",
  );
  assertEquals(template.includes("tp-update-guard"), true);
  for (const line of template.split("\n")) {
    if (line.includes("tp-update-guard") && line.includes("Cmnd_Alias")) {
      throw new TypeError(
        `tp-update-guard must not appear in a Cmnd_Alias: ${line}`,
      );
    }
  }
});

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

/** Every `Cmnd_Alias` entry the root grant names, Jinja rendered to defaults. */
async function rootGrantEntries(): Promise<string[]> {
  const template = await Deno.readTextFile(join(orch, SUDOERS_TEMPLATE));
  const aliases = new Map<string, string[]>();
  for (const line of template.split("\n")) {
    const alias = /^Cmnd_Alias\s+(\w+)\s*=\s*(.+)$/.exec(line);
    if (!alias) continue;
    aliases.set(
      alias[1]!,
      alias[2]!.split(",").map((raw) =>
        raw.trim()
          .replaceAll(
            "{{ turbopanel_orchestration_dir }}",
            "/opt/turbopanel/share/orchestration",
          )
          .replaceAll("{{ turbopanel_install_root }}", "/opt/turbopanel")
          .replaceAll("{{ turbopanel_vendor_dir }}", "/opt/turbopanel/vendor")
      ),
    );
  }
  const grant = template.split("\n").find((line) =>
    /ALL=\(root\) NOPASSWD:/.test(line)
  );
  if (!grant) throw new TypeError("no root grant in sudoers.j2");
  return grant.split("NOPASSWD:")[1]!.split(",").flatMap((name) => {
    const entries = aliases.get(name.trim());
    if (!entries) throw new TypeError(`root grant names unknown alias ${name}`);
    return entries;
  });
}

/**
 * sudoers command matching, enough for this file: a bare path allows any
 * arguments; otherwise the arguments are a glob where `*` matches anything
 * (spaces and slashes included — sudoers argument wildcards do) and `[..]`
 * is a character class.
 */
function grantAllows(entry: string, command: string): boolean {
  const space = entry.indexOf(" ");
  const path = space < 0 ? entry : entry.slice(0, space);
  const wantArgs = space < 0 ? null : entry.slice(space + 1);
  const cSpace = command.indexOf(" ");
  const cPath = cSpace < 0 ? command : command.slice(0, cSpace);
  const cArgs = cSpace < 0 ? "" : command.slice(cSpace + 1);
  const glob = (pattern: string) =>
    new RegExp(
      "^" + pattern.replaceAll(/[.+^${}()|\\]/g, "\\$&").replaceAll("*", ".*") +
        "$",
    );
  if (!glob(path).test(cPath)) return false;
  return wantArgs === null || glob(wantArgs).test(cArgs);
}

test("the root grant is tp-host, tp-orchestrate and two pinned engine checks — nothing else", async () => {
  const entries = (await rootGrantEntries()).sort((a, b) => a.localeCompare(b));
  assertEquals(
    entries,
    [
      "/opt/turbopanel/lib/tp-host",
      "/opt/turbopanel/share/orchestration/scripts/tp-orchestrate",
      "/opt/turbopanel/vendor/apache/current/bin/httpd -t -f /etc/turbopanel/apache/httpd.conf",
      "/usr/sbin/php-fpm[0-9].[0-9] --fpm-config /etc/turbopanel/php/[0-9].[0-9]/php-fpm.conf --test",
    ].sort((a, b) => a.localeCompare(b)),
  );
  const template = await Deno.readTextFile(join(orch, SUDOERS_TEMPLATE));
  assertStringIncludes(template, "env_reset");
});

test("known root escapes are refused by the sudoers grant", async () => {
  const entries = await rootGrantEntries();
  const escapes = [
    "/usr/bin/find / -exec /bin/sh ;",
    "/usr/bin/tee /etc/sudoers.d/evil",
    "/usr/bin/cp /tmp/x /etc/cron.d/x",
    "/usr/bin/install -m 4755 /tmp/sh /usr/local/bin/sh",
    "/usr/bin/chown tp /etc/shadow",
    "/usr/bin/chmod 0777 /etc/shadow",
    "/usr/bin/mv /tmp/x /etc/passwd",
    "/usr/bin/rm -rf /",
    "/usr/bin/systemctl link /tmp/evil.service",
    "/usr/bin/systemctl start evil.service",
    "/usr/sbin/useradd -o -u 0 evil",
    "/usr/sbin/usermod -aG sudo tp",
    "/usr/sbin/chpasswd",
    "/usr/sbin/sysctl -w kernel.core_pattern=|/tmp/x",
    "/usr/sbin/ip netns exec x /bin/sh",
    "/usr/sbin/iptables --modprobe=/tmp/x -L",
    "/usr/bin/docker run -v /:/h alpine",
    "/usr/bin/journalctl",
    "/opt/turbopanel/vendor/apache/current/bin/httpd -t -f /tmp/evil.conf",
    "/usr/sbin/php-fpm8.4 --fpm-config /tmp/x/php-fpm.conf --test",
    "/usr/sbin/php-fpm8.4 --fpm-config /etc/turbopanel/php/8.4/../../../tmp/php-fpm.conf --test",
    "/bin/sh -c id",
  ];
  const allowed = escapes.filter((command) =>
    entries.some((entry) => grantAllows(entry, command))
  );
  assertEquals(allowed, [], "sudoers still grants these root escapes");
  // The daemon's real commands still match.
  for (
    const command of [
      "/opt/turbopanel/lib/tp-host install -m 0640 a b",
      "/opt/turbopanel/share/orchestration/scripts/tp-orchestrate playbook -i localhost, -c local x.yml",
      "/opt/turbopanel/vendor/apache/current/bin/httpd -t -f /etc/turbopanel/apache/httpd.conf",
      "/usr/sbin/php-fpm8.4 --fpm-config /etc/turbopanel/php/8.4/php-fpm.conf --test",
    ]
  ) {
    assertEquals(
      entries.some((entry) => grantAllows(entry, command)),
      true,
      command,
    );
  }
});

test("tp-host is installed root:root 0755 before the sudoers file that names it", async () => {
  const tasks = await readTasks(USER_TASKS);
  const install = tasks.findIndex((task) =>
    String(task["ansible.builtin.copy"]?.dest ?? "").endsWith("/lib/tp-host")
  );
  const sudoers = tasks.findIndex((task) =>
    String(task["ansible.builtin.template"]?.dest ?? "") === "/etc/sudoers.d/tp"
  );
  assertEquals(install >= 0, true, "no task installs tp-host");
  assertEquals(install < sudoers, true, "tp-host must be installed first");
  const copy = tasks[install]!["ansible.builtin.copy"]!;
  assertEquals(copy.owner, "root");
  assertEquals(copy.group, "root");
  assertEquals(copy.mode, "0755");
  assertEquals(copy.src, "{{ turbopanel_orchestration_dir }}/scripts/tp-host");
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
