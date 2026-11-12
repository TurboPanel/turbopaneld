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
 * The control plane's TLS keys on a managed host: the Platform CA key is
 * root's alone (only the root-run generator reads it), the server leaf key is
 * control-plane Caddy's alone (tpcaddy), and the root tasks that write them
 * first check the folders are the real ones and never follow a link.
 */
const ROLES = join(DAEMON_ROOT, "orchestration/roles");
const CERTS_TASKS = join(ROLES, "instance-certs/tasks/main.yml");
const CHECK_TASKS = join(ROLES, "instance-certs/tasks/tls-folders-check.yml");
const LE_TASKS = join(ROLES, "instance-certs/tasks/letsencrypt-files.yml");
const LAUNCH_TASKS = join(ROLES, "instance-launch/tasks/main.yml");
const ACME_UNIT = join(
  ROLES,
  "instance-launch/templates/turbopanel-instance-acme.service.j2",
);

type Args = Record<string, unknown>;
type Task = Record<string, unknown> & { name?: string };

async function readTasks(path: string): Promise<Task[]> {
  return parse(await Deno.readTextFile(path)) as Task[];
}

function named(tasks: Task[], name: string): Task {
  const task = tasks.find((t) => t.name === name);
  assert(task, `expected a task named ${name}`);
  return task;
}

function indexOf(tasks: Task[], name: string): number {
  const at = tasks.findIndex((t) => t.name === name);
  assert(at >= 0, `expected a task named ${name}`);
  return at;
}

const DEV = "(turbopanel_dev_user | default('') | length > 0)";

test("the Platform CA key is root:root 0600 on a managed host and the developer's own in development", async () => {
  const tasks = await readTasks(CERTS_TASKS);
  const args = named(tasks, "Keep the platform CA key readable by root only")[
    "ansible.builtin.file"
  ] as Args;
  assertEquals(args.path, "{{ turbopanel_instance_ca_dir }}/ca.key");
  assertEquals(args.state, "file");
  assertEquals(args.follow, false);
  assertEquals(
    args.owner,
    `{{ instance_certs_owner if ${DEV} else 'root' }}`,
  );
  assertEquals(args.group, `{{ turbopanel_group if ${DEV} else 'root' }}`);
  assertEquals(args.mode, `{{ '0640' if ${DEV} else '0600' }}`);
});

test("the server leaf key belongs to control-plane Caddy alone (0600) wherever the role sets it", async () => {
  const tasks = await readTasks(CERTS_TASKS);
  const copy = named(tasks, "Publish the platform-ca leaf key")[
    "ansible.builtin.copy"
  ] as Args;
  const harden = named(
    tasks,
    "Keep the server leaf key readable by control-plane Caddy only",
  )["ansible.builtin.file"] as Args;
  for (const args of [copy, harden]) {
    assertEquals(args.owner, "{{ caddy_user }}");
    assertEquals(args.group, "{{ caddy_primary_group }}");
    assertEquals(args.mode, "0600");
    assertEquals(args.follow, false);
  }
  assertEquals(harden.state, "file");
  // Nothing in the role still hands that key to group tp.
  const text = await Deno.readTextFile(CERTS_TASKS);
  const leafKeyBlocks = text.split("\n- name: ").filter((block) =>
    block.includes('/platform-ca.key"') && !block.includes("state: link")
  );
  assertEquals(leafKeyBlocks.length, 2);
  for (const block of leafKeyBlocks) {
    assert(!block.includes("turbopanel_group"), block);
  }
});

/** Every task in a list, including those nested in block/rescue/always. */
function allTasks(tasks: Task[]): Task[] {
  return tasks.flatMap((task) => [
    task,
    ...["block", "rescue", "always"].flatMap((key) =>
      Array.isArray(task[key]) ? allTasks(task[key] as Task[]) : []
    ),
  ]);
}

test("every root file and copy task in instance-certs refuses to follow a link", async () => {
  for (const path of [CERTS_TASKS, CHECK_TASKS, LE_TASKS]) {
    for (const task of allTasks(await readTasks(path))) {
      for (const module of ["ansible.builtin.file", "ansible.builtin.copy"]) {
        const args = task[module] as Args | undefined;
        if (!args || args.state === "link") continue;
        assertEquals(args.follow, false, `${path}: ${task.name}`);
      }
    }
  }
  const le = await readTasks(LE_TASKS);
  const migrate = named(
    le,
    "Migrate validated legacy control-plane certificates",
  )["ansible.builtin.command"] as { argv: string[] };
  assertStringIncludes(
    migrate.argv.join("\n"),
    'for path in "$LE_DEST" "$dest_crt" "$dest_key"; do',
  );
});

test("instance-certs checks its folders before any root task touches them", async () => {
  const tasks = await readTasks(CERTS_TASKS);
  const check = indexOf(
    tasks,
    "Check the control-plane TLS folders before root touches them",
  );
  const checkTask = tasks[check] as Task & { vars: Args };
  assertEquals(
    checkTask["ansible.builtin.include_tasks"],
    "tls-folders-check.yml",
  );
  assertEquals(checkTask.vars._tls_folder_checks, [
    {
      path: "{{ turbopanel_instance_ca_dir }}",
      owner: `{{ instance_certs_owner if ${DEV} else 'root' }}`,
      adopt_daemon_owned: true,
    },
    {
      path: "{{ turbopanel_instance_certs_dir }}",
      owner: "{{ instance_certs_owner }}",
    },
  ]);
  const firstWrite = tasks.findIndex((t) =>
    "ansible.builtin.file" in t || "ansible.builtin.copy" in t ||
    "ansible.builtin.command" in t
  );
  assert(check < firstWrite, "the check runs before the first root write");
  const linkCheck = indexOf(
    tasks,
    "Stop when a deprecated leaf name points somewhere else",
  );
  assert(
    linkCheck < indexOf(tasks, "Generate platform CA and server certificate"),
  );
});

test("instance-launch checks the TLS and issuer folders before the Let's Encrypt key tasks", async () => {
  const tasks = await readTasks(LAUNCH_TASKS);
  const check = indexOf(
    tasks,
    "Check the control-plane TLS folders before root touches them",
  );
  assert(
    check <
      indexOf(
        tasks,
        "Harden Let's Encrypt keys and record hostnames whose files exist",
      ),
  );
  const checkTask = tasks[check] as Task & { vars: Args };
  assertEquals(
    checkTask["ansible.builtin.include_tasks"],
    "{{ role_path }}/../instance-certs/tasks/tls-folders-check.yml",
  );
  assertEquals(checkTask.vars._tls_folder_checks, [
    {
      path: "{{ turbopanel_state_dir }}/tls",
      owner: `{{ turbopanel_dev_user if ${DEV} else 'root' }}`,
      adopt_daemon_owned: true,
    },
    {
      path: "{{ turbopanel_instance_certs_dir }}",
      owner: "{{ instance_user }}",
    },
    {
      path: "{{ turbopanel_state_dir }}/instance-acme",
      owner: "{{ caddy_user }}",
    },
  ]);
});

test("the folder check only re-owns a folder and never removes or moves one", async () => {
  const tasks = await readTasks(CHECK_TASKS);
  assertEquals(tasks.length, 3);
  const stat = tasks[0]?.["ansible.builtin.stat"] as Args;
  assertEquals(stat.follow, false);
  const adopt = tasks[1]?.["ansible.builtin.file"] as Args;
  assertEquals(adopt.state, "directory");
  assertEquals(adopt.follow, false);
  assertEquals(adopt.group, "{{ turbopanel_group }}");
  assertEquals(adopt.mode, "0750");
  assert(!("recurse" in adopt), "never recursive");
  const assertion = tasks[2]?.["ansible.builtin.assert"] as Args;
  assert(assertion, "expected an assert");
  const message = String(assertion.fail_msg);
  assertStringIncludes(message, "Nothing was changed.");
  assertStringIncludes(message, "Do not delete the tls folder");
  assert(!/\bremove\b/i.test(message), "the message never says remove");
  for (const task of tasks) {
    for (const module of ["copy", "command", "shell"]) {
      assert(!(`ansible.builtin.${module}` in task), task.name);
    }
  }
});

test("no stop message in these tasks tells the operator to remove something", async () => {
  const text = [
    await Deno.readTextFile(CERTS_TASKS),
    await Deno.readTextFile(LE_TASKS),
    await Deno.readTextFile(CHECK_TASKS),
  ].join("\n");
  assert(!text.includes("remove the stand-in"));
});

// ---------------------------------------------------------------------------
// The tasks' expressions, evaluated with Jinja2 (no Ansible run, no host).

async function hasJinja(python: string): Promise<boolean> {
  try {
    const { success } = await new Deno.Command(python, {
      args: ["-c", "import jinja2"],
      stdout: "null",
      stderr: "null",
    }).output();
    return success;
  } catch {
    return false;
  }
}

async function findJinjaPython(): Promise<string | undefined> {
  const candidates = [
    Deno.env.get("TURBOPANEL_JINJA_PYTHON"),
    "/opt/turbopanel/vendor/ansible/current/bin/python3",
    "python3",
  ].filter((c): c is string => typeof c === "string" && c.length > 0);
  for (const candidate of candidates) {
    if (await hasJinja(candidate)) return candidate;
  }
  return undefined;
}

const JINJA_PYTHON = await findJinjaPython();
const JINJA_IGNORE = JINJA_PYTHON === undefined &&
  Deno.env.get("CI") !== "true";

/**
 * Renders each condition (all must be true, like Ansible's `that` and
 * `when` lists) and the message, once per set of variables.
 */
const EVAL_PY = String.raw`
import json, os, sys
import jinja2
env = jinja2.Environment()
env.filters["dirname"] = os.path.dirname
env.filters["bool"] = lambda v: v if isinstance(v, bool) else str(v).strip().lower() in ("yes", "on", "1", "true", "y", "t")
req = json.load(sys.stdin)
out = []
for values in req["cases"]:
    ok = all(
        env.from_string("{{ (" + cond + ") | string }}").render(**values) == "True"
        for cond in req["conditions"]
    )
    msg = env.from_string(req["msg"]).render(**values)
    out.append({"ok": ok, "msg": " ".join(msg.split())})
json.dump(out, sys.stdout)
`;

type Case = { ok: boolean; msg: string };

async function evaluate(
  conditions: string[],
  msg: string,
  cases: Record<string, unknown>[],
): Promise<Case[]> {
  assert(JINJA_PYTHON, "no Python with jinja2");
  const child = new Deno.Command(JINJA_PYTHON, {
    args: ["-c", EVAL_PY],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(
    new TextEncoder().encode(JSON.stringify({ conditions, msg, cases })),
  );
  await writer.close();
  const out = await child.output();
  assert(out.success, new TextDecoder().decode(out.stderr));
  return JSON.parse(new TextDecoder().decode(out.stdout)) as Case[];
}

const want = {
  path: "/var/lib/turbopanel/tls",
  owner: "root",
  adopt_daemon_owned: true,
};
const managed = { turbopanel_dev_user: "", turbopanel_user: "tp" };
const dir = (owner: string) => ({
  exists: true,
  isdir: true,
  islnk: false,
  pw_name: owner,
});
const STAT_CASES: Record<string, Record<string, unknown>> = {
  missing: { ...managed, item: { item: want, stat: { exists: false } } },
  root: { ...managed, item: { item: want, stat: dir("root") } },
  own: {
    ...managed,
    item: { item: { ...want, owner: "tpctrl" }, stat: dir("tpctrl") },
  },
  daemonOwned: { ...managed, item: { item: want, stat: dir("tp") } },
  daemonOwnedNoAdopt: {
    ...managed,
    item: {
      item: { ...want, adopt_daemon_owned: false },
      stat: dir("tp"),
    },
  },
  daemonOwnedDev: {
    turbopanel_dev_user: "dev",
    turbopanel_user: "dev",
    item: { item: { ...want, owner: "dev" }, stat: dir("tp") },
  },
  link: {
    ...managed,
    item: {
      item: want,
      stat: {
        exists: true,
        isdir: false,
        islnk: true,
        lnk_source: "/tmp/elsewhere",
        pw_name: "tp",
      },
    },
  },
  file: {
    ...managed,
    item: {
      item: want,
      stat: { exists: true, isdir: false, islnk: false, pw_name: "tp" },
    },
  },
  stranger: { ...managed, item: { item: want, stat: dir("nobody") } },
};

async function checkTasks(): Promise<Task[]> {
  return await readTasks(CHECK_TASKS);
}

test({
  name:
    "the folder check passes a missing, root's, expected or older daemon-owned folder and stops on a link, a file or a stranger's folder",
  ignore: JINJA_IGNORE,
  fn: async () => {
    const assertion = (await checkTasks())[2]?.["ansible.builtin.assert"] as {
      that: string[];
      fail_msg: string;
    };
    const names = Object.keys(STAT_CASES);
    const results = await evaluate(
      assertion.that,
      assertion.fail_msg,
      names.map((name) => STAT_CASES[name] ?? {}),
    );
    const by = Object.fromEntries(names.map((n, i) => [n, results[i]]));
    assertEquals(by.missing?.ok, true);
    assertEquals(by.root?.ok, true);
    assertEquals(by.own?.ok, true);
    assertEquals(by.daemonOwned?.ok, true);
    assertEquals(by.daemonOwnedNoAdopt?.ok, false);
    assertEquals(by.daemonOwnedDev?.ok, false);
    assertEquals(by.link?.ok, false);
    assertStringIncludes(
      by.link?.msg ?? "",
      "/var/lib/turbopanel/tls is a symbolic link to /tmp/elsewhere,",
    );
    assertEquals(by.file?.ok, false);
    assertStringIncludes(by.file?.msg ?? "", "is not a folder,");
    assertEquals(by.stranger?.ok, false);
    const msg = by.stranger?.msg ?? "";
    assertStringIncludes(msg, "a folder owned by nobody,");
    assertStringIncludes(msg, "expects a real folder owned by root there");
    assertStringIncludes(msg, "ls -la /var/lib/turbopanel");
    assertStringIncludes(msg, "Do not delete the tls folder");
  },
});

test({
  name:
    "only a real daemon-owned TLS folder on a managed host is taken over, nothing else",
  ignore: JINJA_IGNORE,
  fn: async () => {
    const adopt = (await checkTasks())[1] as Task & { when: string[] };
    const names = Object.keys(STAT_CASES);
    const results = await evaluate(
      adopt.when,
      "",
      names.map((name) => STAT_CASES[name] ?? {}),
    );
    const taken = names.filter((_, i) => results[i]?.ok);
    assertEquals(taken, ["daemonOwned"]);
  },
});

test({
  name:
    "self-signed names pass as the generator's file or the role's link to platform-ca and stop otherwise",
  ignore: JINJA_IGNORE,
  fn: async () => {
    const task = named(
      await readTasks(CERTS_TASKS),
      "Stop when a deprecated leaf name points somewhere else",
    )["ansible.builtin.assert"] as { that: string[]; fail_msg: string };
    const certs = "/var/lib/turbopanel/tls/certs";
    const at = (item: string, stat: Record<string, unknown>) => ({
      turbopanel_instance_certs_dir: certs,
      item: { item, stat },
    });
    const [missing, file, ownLink, crtLink, away, folder] = await evaluate(
      task.that,
      task.fail_msg,
      [
        at("key", { exists: false }),
        at("key", { exists: true, isreg: true, islnk: false }),
        at("key", {
          exists: true,
          isreg: false,
          islnk: true,
          lnk_target: `${certs}/platform-ca.key`,
        }),
        at("key", {
          exists: true,
          isreg: false,
          islnk: true,
          lnk_target: `${certs}/platform-ca.crt`,
        }),
        at("key", {
          exists: true,
          isreg: false,
          islnk: true,
          lnk_target: "/etc/shadow",
        }),
        at("crt", { exists: true, isreg: false, islnk: false }),
      ],
    );
    assertEquals(missing?.ok, true);
    assertEquals(file?.ok, true);
    assertEquals(ownLink?.ok, true);
    assertEquals(crtLink?.ok, false);
    assertEquals(away?.ok, false);
    assertStringIncludes(away?.msg ?? "", "(a link to /etc/shadow)");
    assertStringIncludes(away?.msg ?? "", "Do not delete the tls folder");
    assertEquals(folder?.ok, false);
    assertStringIncludes(folder?.msg ?? "", "(not a regular file)");
  },
});

// ---------------------------------------------------------------------------
// The issuer unit's guard, run with /bin/sh against throwaway paths.

async function issuerGuard(): Promise<string> {
  const text = await Deno.readTextFile(ACME_UNIT);
  const line = text.split("\n").find((l) =>
    l.startsWith("ExecStartPre=+/bin/sh -c '")
  );
  assert(line, "expected the folder guard");
  const install = text.indexOf("ExecStartPre=+/usr/bin/install -d");
  assert(text.indexOf(line) < install, "the guard runs before install -d");
  const body = line.slice("ExecStartPre=+/bin/sh -c '".length);
  const script = body.slice(0, body.lastIndexOf("'"));
  // systemd turns $$ into $; Ansible fills in the account name.
  return script.replaceAll("$$", "$").replaceAll("{{ caddy_user }}", "tpcaddy");
}

test("the issuer unit's guard refuses a link or a file and passes a folder or nothing", async () => {
  const script = await issuerGuard();
  const root = await Deno.makeTempDir({ prefix: "tp-acme-guard-" });
  try {
    const folder = join(root, "folder");
    const file = join(root, "file");
    const link = join(root, "link");
    const dangling = join(root, "dangling");
    await Deno.mkdir(folder);
    await Deno.writeTextFile(file, "");
    await Deno.symlink(folder, link);
    await Deno.symlink(join(root, "nowhere"), dangling);
    const run = async (path: string) => {
      const out = await new Deno.Command("/bin/sh", {
        args: ["-c", script, path],
        stdout: "null",
        stderr: "piped",
      }).output();
      return { ok: out.success, err: new TextDecoder().decode(out.stderr) };
    };
    assertEquals((await run(folder)).ok, true);
    assertEquals((await run(join(root, "missing"))).ok, true);
    for (const path of [file, link, dangling]) {
      const result = await run(path);
      assertEquals(result.ok, false, path);
      assertStringIncludes(result.err, `${path} is not a real folder`);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
