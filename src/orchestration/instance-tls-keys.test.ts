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

test("every root file and copy task in instance-certs refuses to follow a link", async () => {
  const tasks = await readTasks(CERTS_TASKS);
  for (const task of tasks) {
    for (const module of ["ansible.builtin.file", "ansible.builtin.copy"]) {
      const args = task[module] as Args | undefined;
      if (!args || args.state === "link") continue;
      assertEquals(args.follow, false, task.name);
    }
  }
  const le = await readTasks(LE_TASKS);
  const harden = named(
    le,
    "Harden Let's Encrypt keys for the control-plane Caddy user",
  )["ansible.builtin.file"] as Args;
  assertEquals(harden.follow, false);
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

test("the folder check looks without following links and stops instead of fixing", async () => {
  const tasks = await readTasks(CHECK_TASKS);
  assertEquals(tasks.length, 2);
  const stat = tasks[0]?.["ansible.builtin.stat"] as Args;
  assertEquals(stat.follow, false);
  const assertion = tasks[1]?.["ansible.builtin.assert"] as Args;
  assert(assertion, "expected an assert");
  assertStringIncludes(String(assertion.fail_msg), "Nothing was changed.");
  for (const task of tasks) {
    for (const module of ["file", "copy", "command", "shell"]) {
      assert(!(`ansible.builtin.${module}` in task), task.name);
    }
  }
});

test("the issuer unit refuses a link or a file in place of its folder before install -d", async () => {
  const text = await Deno.readTextFile(ACME_UNIT);
  const guard = text.indexOf(`ExecStartPre=+/bin/sh -c 'if [ -L "$$0" ]`);
  const install = text.indexOf("ExecStartPre=+/usr/bin/install -d");
  assert(guard >= 0, "expected the folder guard");
  assert(guard < install, "the guard runs before install -d");
});

// ---------------------------------------------------------------------------
// The check's expressions, evaluated with Jinja2 (no Ansible run, no host).

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

const EVAL_PY = String.raw`
import json, os, sys
import jinja2
env = jinja2.Environment()
env.filters["dirname"] = os.path.dirname
req = json.load(sys.stdin)
out = []
for item in req["items"]:
    ok = env.from_string("{{ (" + req["that"] + ") | string }}").render(item=item)
    msg = env.from_string(req["msg"]).render(item=item)
    out.append({"ok": ok == "True", "msg": " ".join(msg.split())})
json.dump(out, sys.stdout)
`;

type Case = { ok: boolean; msg: string };

async function evaluate(items: unknown[]): Promise<Case[]> {
  assert(JINJA_PYTHON, "no Python with jinja2");
  const tasks = await readTasks(CHECK_TASKS);
  const assertion = tasks[1]?.["ansible.builtin.assert"] as {
    that: string[];
    fail_msg: string;
  };
  const child = new Deno.Command(JINJA_PYTHON, {
    args: ["-c", EVAL_PY],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(
    new TextEncoder().encode(JSON.stringify({
      that: assertion.that[0],
      msg: assertion.fail_msg,
      items,
    })),
  );
  await writer.close();
  const out = await child.output();
  assert(out.success, new TextDecoder().decode(out.stderr));
  return JSON.parse(new TextDecoder().decode(out.stdout)) as Case[];
}

const want = { path: "/var/lib/turbopanel/tls", owner: "tpctrl" };

test({
  name:
    "the folder check passes a missing or real folder and stops on a link, a file or a stranger's folder",
  ignore: JINJA_PYTHON === undefined && Deno.env.get("CI") !== "true",
  fn: async () => {
    const [missing, own, root, link, file, stranger] = await evaluate([
      { item: want, stat: { exists: false } },
      {
        item: want,
        stat: { exists: true, isdir: true, islnk: false, pw_name: "tpctrl" },
      },
      {
        item: want,
        stat: { exists: true, isdir: true, islnk: false, pw_name: "root" },
      },
      {
        item: want,
        stat: {
          exists: true,
          isdir: false,
          islnk: true,
          lnk_source: "/tmp/elsewhere",
          pw_name: "tp",
        },
      },
      {
        item: want,
        stat: { exists: true, isdir: false, islnk: false, pw_name: "root" },
      },
      {
        item: want,
        stat: { exists: true, isdir: true, islnk: false, pw_name: "tp" },
      },
    ]);
    assertEquals(missing?.ok, true);
    assertEquals(own?.ok, true);
    assertEquals(root?.ok, true);
    assertEquals(link?.ok, false);
    assertStringIncludes(
      link?.msg ?? "",
      "/var/lib/turbopanel/tls is a symbolic link to /tmp/elsewhere.",
    );
    assertEquals(file?.ok, false);
    assertStringIncludes(file?.msg ?? "", "is not a folder.");
    assertEquals(stranger?.ok, false);
    assertStringIncludes(stranger?.msg ?? "", "a folder owned by tp.");
    assertStringIncludes(
      stranger?.msg ?? "",
      "expects a real folder owned by tpctrl (or root)",
    );
    assertStringIncludes(stranger?.msg ?? "", "ls -la /var/lib/turbopanel");
  },
});
