import { assert, assertEquals, assertStringIncludes } from "@std/assert";
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
/** tp-host, its conf and the sudoers file: imported by USER_TASKS and by the co-located refresh. */
const ROOT_HELPER_TASKS = "roles/turbopanel-user/tasks/root-helpers.yml";
const COLOCATED_REFRESH = "playbooks/daemon-colocated-refresh.yml";
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

test("tp-firewall-guard is not granted via sudoers (root systemd only)", async () => {
  const template = await Deno.readTextFile(join(orch, SUDOERS_TEMPLATE));
  assertStringIncludes(
    template,
    "tp-firewall-guard runs only as root via its systemd timer",
  );
  for (const line of template.split("\n")) {
    if (line.includes("tp-firewall-guard") && line.includes("Cmnd_Alias")) {
      throw new TypeError(
        `tp-firewall-guard must not appear in a Cmnd_Alias: ${line}`,
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
  for (
    const task of [
      ...(await readTasks(USER_TASKS)),
      ...(await readTasks(ROOT_HELPER_TASKS)),
    ]
  ) {
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

/** `{{ … }}` in a sudoers.j2 entry, rendered to the production defaults. */
function renderEntry(raw: string): string {
  return raw.trim()
    .replaceAll(
      "{{ turbopanel_orchestration_dir }}",
      "/opt/turbopanel/share/orchestration",
    )
    .replaceAll("{{ turbopanel_install_root }}", "/opt/turbopanel")
    .replaceAll("{{ turbopanel_vendor_dir }}", "/opt/turbopanel/vendor");
}

/** Every `Cmnd_Alias` in sudoers.j2, Jinja rendered to defaults. */
function cmndAliases(template: string): Map<string, string[]> {
  const aliases = new Map<string, string[]>();
  for (const line of template.split("\n")) {
    const alias = /^Cmnd_Alias\s+(\w+)\s*=\s*(.+)$/.exec(line);
    if (!alias) continue;
    aliases.set(alias[1]!, alias[2]!.split(",").map(renderEntry));
  }
  return aliases;
}

/** Every `Cmnd_Alias` entry the root grant names, Jinja rendered to defaults. */
async function rootGrantEntries(): Promise<string[]> {
  const template = await Deno.readTextFile(join(orch, SUDOERS_TEMPLATE));
  const aliases = cmndAliases(template);
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
 * Every command `tp` may run as `runas`, across every grant line whose run-as
 * list names it: aliases expanded, literal commands kept, Jinja rendered.
 */
async function runasGrantEntries(runas: string): Promise<string[]> {
  const template = await Deno.readTextFile(join(orch, SUDOERS_TEMPLATE));
  const aliases = cmndAliases(template);
  const entries: string[] = [];
  for (const line of template.split("\n")) {
    const grant =
      /^\{\{ turbopanel_user \}\} ALL=\(([^)]*)\)\s*NOPASSWD:\s*(.+)$/.exec(
        line,
      );
    if (!grant) continue;
    const users = grant[1]!.split(",").map((user) => user.trim());
    if (!users.includes(runas)) continue;
    for (const name of grant[2]!.split(",")) {
      entries.push(...(aliases.get(name.trim()) ?? [renderEntry(name)]));
    }
  }
  return entries;
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

test("the root grant is tp-host, tp-orchestrate and the pinned php-fpm check — nothing else", async () => {
  const entries = (await rootGrantEntries()).sort((a, b) => a.localeCompare(b));
  assertEquals(
    entries,
    [
      "/opt/turbopanel/lib/tp-host",
      "/opt/turbopanel/share/orchestration/scripts/tp-orchestrate",
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
    "/opt/turbopanel/vendor/apache/current/bin/httpd -t -f /etc/turbopanel/apache/httpd.conf",
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

const VENDOR = "/opt/turbopanel/vendor";
/** The one config test each unprivileged engine account may run, pinned. */
const ENGINE_VALIDATE: Record<string, string> = {
  tpnginx:
    `${VENDOR}/nginx/current/sbin/nginx -t -c /etc/turbopanel/nginx/nginx.conf`,
  tpols:
    `${VENDOR}/openlitespeed/current/bin/openlitespeed -t -c /etc/turbopanel/openlitespeed/httpd_config.conf`,
  tpcaddysite:
    `${VENDOR}/caddy/current/caddy validate --adapter caddyfile --config /etc/turbopanel/caddy/Caddyfile`,
};

test("each engine account grants exactly its own pinned config test (P2-8)", async () => {
  for (const [runas, command] of Object.entries(ENGINE_VALIDATE)) {
    assertEquals(await runasGrantEntries(runas), [command], runas);
  }
});

test("engine accounts refuse env, other engines' binaries and free arguments (P2-8)", async () => {
  const escapes: Record<string, string[]> = {
    tpnginx: [
      "/usr/bin/env id",
      "/usr/bin/env /bin/sh -c id",
      `${VENDOR}/nginx/current/sbin/nginx -c /tmp/evil.conf`,
      `${VENDOR}/nginx/current/sbin/nginx -t -c /etc/turbopanel/nginx/nginx.conf -g load_module /tmp/x.so;`,
      `${VENDOR}/nginx/1.28.3/sbin/nginx -t -c /tmp/evil.conf`,
      `${VENDOR}/caddy/current/caddy run --config /tmp/x`,
      "/bin/sh -c id",
    ],
    tpols: [
      "/usr/bin/env id",
      `${VENDOR}/openlitespeed/current/bin/openlitespeed -n`,
      `${VENDOR}/openlitespeed/current/bin/openlitespeed -t -c /tmp/evil.conf`,
      `${VENDOR}/nginx/current/sbin/nginx -t -c /etc/turbopanel/nginx/nginx.conf`,
    ],
    tpcaddysite: [
      "/usr/bin/env id",
      `/usr/bin/env XDG_DATA_HOME=/tmp ${VENDOR}/caddy/current/caddy validate --adapter caddyfile --config /etc/turbopanel/caddy/Caddyfile`,
      `${VENDOR}/caddy/current/caddy run --config /tmp/x`,
      `${VENDOR}/caddy/current/caddy validate --adapter caddyfile --config /tmp/x`,
      `${VENDOR}/caddy/2.11.4/caddy validate --config /tmp/x`,
    ],
    tpapache: ["/usr/bin/env id", "/bin/sh -c id"],
  };
  for (const [runas, commands] of Object.entries(escapes)) {
    const entries = await runasGrantEntries(runas);
    const allowed = commands.filter((command) =>
      entries.some((entry) => grantAllows(entry, command))
    );
    assertEquals(allowed, [], `sudoers still lets tp run these as ${runas}`);
  }
  for (const [runas, command] of Object.entries(ENGINE_VALIDATE)) {
    const entries = await runasGrantEntries(runas);
    assertEquals(
      entries.some((entry) => grantAllows(entry, command)),
      true,
      `${runas}: ${command}`,
    );
  }
});

test("Apache's config test runs as tpapache with every argument pinned and no env", async () => {
  const httpd = "/opt/turbopanel/vendor/apache/current/bin/httpd";
  const config = "/etc/turbopanel/apache/httpd.conf";
  const entries = await runasGrantEntries("tpapache");
  assertEquals(entries, [`${httpd} -t -f ${config}`]);
  const allowed = (command: string) =>
    entries.some((entry) => grantAllows(entry, command));
  assertEquals(allowed(`${httpd} -t -f ${config}`), true);
  for (
    const command of [
      `${httpd} -t -f /tmp/evil.conf`,
      `${httpd} -f ${config} -k start`,
      `${httpd} -t -f ${config} -C LoadModule`,
      `${httpd} -t -f ${config} -d /tmp`,
      `/usr/bin/env ${httpd} -t -f ${config}`,
      "/bin/sh -c id",
    ]
  ) {
    assertEquals(allowed(command), false, command);
  }
  // No grant line carries `env`, so no engine account can reach it.
  const template = await Deno.readTextFile(join(orch, SUDOERS_TEMPLATE));
  const withEnv = template.split("\n").find((line) =>
    line.includes("NOPASSWD:") && line.includes("/usr/bin/env")
  );
  assertEquals(withEnv, undefined);
});

test("tp-host is installed root:tp 0750 (never writable by tp) before the sudoers file that names it", async () => {
  const tasks = await readTasks(ROOT_HELPER_TASKS);
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
  assertEquals(copy.group, "{{ turbopanel_group }}");
  assertEquals(copy.mode, "0750");
  assertEquals(copy.src, "{{ turbopanel_orchestration_dir }}/scripts/tp-host");
});

test("the full install still installs the root helpers (turbopanel-user imports root-helpers.yml)", async () => {
  const tasks = await readTasks(USER_TASKS);
  const imports = tasks.filter((task) =>
    task["ansible.builtin.import_tasks"] === "root-helpers.yml"
  );
  assertEquals(
    imports.length,
    1,
    "turbopanel-user must import root-helpers.yml once",
  );
  // The helper and sudoers tasks live only in root-helpers.yml (one source).
  for (const task of tasks) {
    assertEquals(
      String(task["ansible.builtin.copy"]?.dest ?? "").endsWith("/lib/tp-host"),
      false,
      "tp-host must be installed from root-helpers.yml only",
    );
    assertEquals(
      String(task["ansible.builtin.template"]?.dest ?? "").startsWith(
        "/etc/sudoers",
      ),
      false,
      "sudoers must be written from root-helpers.yml only",
    );
  }
});

test("every daemon-replacing play refreshes tp-host and sudoers from the new release", async () => {
  // Remote nodes (tp-orchestrate update → run.sh → daemon-install.yml) and
  // fresh control planes (instance-install.yml) run the whole role.
  for (const play of [DAEMON_INSTALL, "playbooks/instance-install.yml"]) {
    const doc = parseYaml(await Deno.readTextFile(join(orch, play)));
    const roles = (Array.isArray(doc) ? doc[0]?.roles : []) as unknown[];
    const names = roles.map((r) =>
      typeof r === "string" ? r : String((r as Record<string, unknown>).role)
    );
    assertEquals(
      names.includes("turbopanel-user"),
      true,
      `${play} lacks turbopanel-user`,
    );
  }
  // The co-located refresh (run.sh --daemon-only on a panel host) replaces the
  // daemon binary and orchestration tree too, so it must re-install the
  // helpers — and before any role that restarts the daemon.
  const doc = parseYaml(await Deno.readTextFile(join(orch, COLOCATED_REFRESH)));
  const play = (Array.isArray(doc) ? doc[0] : {}) as Record<string, unknown>;
  const preTasks = (play.pre_tasks ?? []) as Task[];
  const helper = preTasks.find((task) => {
    const role = task["ansible.builtin.import_role"] as
      | Record<string, unknown>
      | undefined;
    return role?.name === "turbopanel-user" &&
      role?.tasks_from === "root-helpers";
  });
  assertEquals(
    helper !== undefined,
    true,
    "co-located refresh must import root-helpers",
  );
  // Only the helpers — never the whole role (its FHS/ownership tasks belong
  // to instance-install.yml on a panel host).
  const roles = ((play.roles ?? []) as unknown[]).map((r) =>
    typeof r === "string" ? r : String((r as Record<string, unknown>).role)
  );
  assertEquals(roles.includes("turbopanel-user"), false);
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

test("daemon-install.yml leaves the root-owned engine config trees alone", async () => {
  const doc = parseYaml(await Deno.readTextFile(join(orch, DAEMON_INSTALL)));
  const play = (doc as Array<Record<string, unknown>>)[0]!;
  const engines = (play.vars as Record<string, unknown>)
    .turbopanel_engine_config_dirs as string[];
  for (const engine of ["apache", "nginx", "openlitespeed", "php"]) {
    assert(engines.includes(engine), `${engine} must be excluded`);
  }
  for (const task of play.post_tasks as Task[]) {
    const file = task["ansible.builtin.file"];
    if (!file || file.owner !== "{{ turbopanel_user }}") continue;
    const loop = Array.isArray(task.loop) ? task.loop.map(String) : [];
    const paths = [String(file.path), ...loop];
    const configRecurse = file.recurse === true &&
      paths.some((path) => path.includes("turbopanel_config_dir"));
    assertEquals(configRecurse, false, `${task.name}: recursive config chown`);
  }
  const contents = (play.post_tasks as Task[]).find((task) =>
    task.name === "Ensure tp owns the config tree's contents"
  );
  const argv = (contents?.["ansible.builtin.command"] as
    | { argv?: string[] }
    | undefined)?.argv ?? [];
  for (const engine of engines) {
    const at = argv.indexOf(`{{ turbopanel_config_dir }}/${engine}`);
    assert(at > 0, `${engine} must be pruned from the config re-own`);
    assertEquals(argv[at - 1], "-path", engine);
    assert(at < argv.indexOf("-prune"), `${engine} pruned`);
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

test("daemon-install.yml never recursively re-owns the daemon state tree", async () => {
  // managed/<id>/{config,tls} are engine bind mounts owned by the engine
  // user/group; a recursive tp:tp on update made MySQL skip its config.
  const doc = parseYaml(await Deno.readTextFile(join(orch, DAEMON_INSTALL)));
  const play = (doc as Array<Record<string, unknown>>)[0]!;
  const tasks = ["pre_tasks", "tasks", "post_tasks"].flatMap((key) =>
    Array.isArray(play[key]) ? play[key] as Task[] : []
  );
  for (const task of tasks) {
    const file = task["ansible.builtin.file"];
    if (!file || file.recurse !== true) continue;
    const loop = Array.isArray(task.loop) ? task.loop.map(String) : [];
    for (const path of [String(file.path), ...loop]) {
      assertEquals(
        path.includes("turbopanel_daemon_state_dir") ||
          path.includes("/var/lib/turbopanel"),
        false,
        `${task.name}: ${path}`,
      );
    }
  }
});

test("daemon-install.yml leaves per-site PHP config and the lsphp registry to tp-host", async () => {
  // php/sites/<id>/ is root:<owner>-grp so the owner's PHP can read it and not
  // change it; a recursive tp:tp on update left every PHP site without config.
  const doc = parseYaml(await Deno.readTextFile(join(orch, DAEMON_INSTALL)));
  const play = (doc as Array<Record<string, unknown>>)[0]!;
  const tasks = ["pre_tasks", "tasks", "post_tasks"].flatMap((key) =>
    Array.isArray(play[key]) ? play[key] as Task[] : []
  );
  for (const task of tasks) {
    const file = task["ansible.builtin.file"];
    if (!file || file.recurse !== true) continue;
    assertEquals(
      String(file.path).includes("turbopanel_config_dir"),
      false,
      `${task.name}: recursive chown of the config tree`,
    );
  }
  const contents = tasks.find((t) =>
    t.name === "Ensure tp owns the config tree's contents"
  );
  const argv = (contents?.["ansible.builtin.command"] as
    | { argv?: string[] }
    | undefined)?.argv ?? [];
  for (const pruned of ["php/sites", "php-sites"]) {
    const at = argv.indexOf(`{{ turbopanel_config_dir }}/${pruned}`);
    assertEquals(argv[at - 1], "-path", pruned);
  }
  assertEquals(argv.indexOf("-prune") > argv.indexOf("-path"), true);
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
