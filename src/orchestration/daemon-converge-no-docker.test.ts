import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { parse } from "yaml";
import { DAEMON_ROOT } from "./assets.ts";

/** Sonar typescript:S2187 only recognizes `test()`; see other suites here. */
const test = Deno.test.bind(Deno);

const ORCH = join(DAEMON_ROOT, "orchestration");
const PLAYBOOKS = join(ORCH, "playbooks");

type Entry = Record<string, unknown>;
type Play = Entry & { roles?: Array<string | Entry> };

async function readOrEmpty(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return "";
    throw err;
  }
}

async function readPlays(name: string): Promise<Play[]> {
  const doc = parse(await Deno.readTextFile(join(PLAYBOOKS, name)));
  return Array.isArray(doc) ? (doc as Play[]) : [];
}

async function playbookNames(): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(PLAYBOOKS)) {
    if (entry.isFile && entry.name.endsWith(".yml")) names.push(entry.name);
  }
  return names.sort();
}

function roleName(entry: string | Entry): string {
  if (typeof entry === "string") return entry;
  return String(entry.role ?? entry.name ?? "");
}

const ROLE_ACTIONS = [
  "ansible.builtin.import_role",
  "ansible.builtin.include_role",
  "import_role",
  "include_role",
];

/** Every role a play enters: its `roles:` list plus role imports in tasks. */
function rolesEntered(
  play: Play,
): Array<{ name: string; tasksFrom: string | null }> {
  const out: Array<{ name: string; tasksFrom: string | null }> = (
    play.roles ?? []
  ).map((r) => ({ name: roleName(r), tasksFrom: null }));
  const walk = (tasks: unknown): void => {
    if (!Array.isArray(tasks)) return;
    for (const task of tasks as Entry[]) {
      for (const key of ["block", "rescue", "always"]) walk(task[key]);
      for (const action of ROLE_ACTIONS) {
        const args = task[action] as Entry | undefined;
        if (!args) continue;
        out.push({
          name: String(args.name),
          tasksFrom: args.tasks_from ? String(args.tasks_from) : null,
        });
      }
    }
  };
  for (const key of ["pre_tasks", "tasks", "post_tasks"]) walk(play[key]);
  return out;
}

/** Role names under the `dependencies:` key of a role's meta/main.yml. */
async function metaDependencies(role: string): Promise<string[]> {
  const meta = parse(
    await readOrEmpty(join(ORCH, "roles", role, "meta/main.yml")),
  ) as { dependencies?: Array<string | Entry> } | null;
  return (meta?.dependencies ?? []).map(roleName);
}

async function dependencyClosure(role: string): Promise<Set<string>> {
  const seen = new Set<string>();
  const queue = [role];
  while (queue.length > 0) {
    const current = queue.pop()!;
    // Sequential on purpose: the queue grows from each read.
    for (const dep of await metaDependencies(current)) {
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }
  return seen;
}

/** Task names in a role's task file, including tasks nested in blocks. */
async function taskNames(role: string, file: string): Promise<string[]> {
  const names: string[] = [];
  const walk = (tasks: unknown): void => {
    if (!Array.isArray(tasks)) return;
    for (const task of tasks as Entry[]) {
      if (typeof task.name === "string") names.push(task.name);
      for (const key of ["block", "rescue", "always"]) walk(task[key]);
    }
  };
  walk(parse(
    await Deno.readTextFile(join(ORCH, "roles", role, "tasks", file)),
  ));
  return names;
}

test("no playbook passes tasks_from in a play's roles: list", async () => {
  // Ansible ignores `tasks_from` on a `roles:` entry and runs the role's
  // main.yml, so the entry file is silently skipped and the whole role runs.
  // Picking one task file only works through import_role / include_role.
  const offenders: string[] = [];
  for (const name of await playbookNames()) {
    for (const play of await readPlays(name)) {
      for (const entry of play.roles ?? []) {
        if (typeof entry === "object" && "tasks_from" in entry) {
          offenders.push(`${name}: ${roleName(entry)}`);
        }
      }
    }
  }
  assertEquals(offenders, []);
});

test("daemon-converge never runs the whole docker role", async () => {
  const [play] = await readPlays("daemon-converge.yml");
  const roles = rolesEntered(play!);
  assert(roles.length > 5);

  // Ansible runs a role's meta dependencies even when only `tasks_from` is
  // used, so a dependency on `docker` would install Docker (through the
  // Galaxy role, which is not fetched at boot) on every managed host.
  const closures = await Promise.all(
    roles.map(async (r) => ({
      name: r.name,
      deps: await dependencyClosure(r.name),
    })),
  );
  const offenders = closures
    .filter((c) => c.deps.has("docker"))
    .map((c) => c.name);
  assertEquals(offenders, []);

  // The docker role itself is only entered for the builder-deny re-apply.
  const docker = roles.filter((r) => r.name === "docker");
  assertEquals(docker.map((r) => r.tasksFrom), ["converge-builder"]);
});

async function ansiblePlaybookAvailable(): Promise<boolean> {
  try {
    const { success } = await new Deno.Command("ansible-playbook", {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).output();
    return success;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

/** `ansible-playbook --list-tasks`, run the way check-orchestration.sh runs syntax-check. */
async function listTasks(playbook: string): Promise<string[]> {
  const env: Record<string, string> = {
    ANSIBLE_CONFIG: "ansible.cfg",
    ANSIBLE_STDOUT_CALLBACK: "default",
  };
  // CI installs ansible-core only; check-orchestration.sh caches the
  // ansible.posix collection here before the tests run.
  const cached = join(
    Deno.env.get("TMPDIR") ?? "/tmp",
    "turbopanel-orchestration-collections",
  );
  const stat = await Deno.stat(join(cached, "ansible_collections"))
    .catch(() => null);
  if (stat?.isDirectory) env.ANSIBLE_COLLECTIONS_PATH = cached;
  const out = await new Deno.Command("ansible-playbook", {
    args: ["--list-tasks", `playbooks/${playbook}`],
    cwd: ORCH,
    env,
  }).output();
  const text = new TextDecoder().decode(out.stdout);
  assert(
    out.success,
    `--list-tasks ${playbook} failed:\n${text}\n${
      new TextDecoder().decode(out.stderr)
    }`,
  );
  return text.split("\n").map((l) => l.trim().replace(/\s+TAGS: .*$/, ""))
    .filter((l) => l.length > 0);
}

test({
  name:
    "daemon-converge's real task list skips the Docker install and the ungated hosting Caddy grants",
  ignore: !(await ansiblePlaybookAvailable()),
  fn: async () => {
    const tasks = await listTasks("daemon-converge.yml");

    // Only converge-builder's tasks run from the docker role; nothing from
    // its main.yml (key fetch, docker-ce install, daemon.json pools).
    const builder = new Set(await taskNames("docker", "converge-builder.yml"));
    const dockerTasks = tasks.filter((t) => t.startsWith("docker : "));
    assert(dockerTasks.length > 0, "converge-builder tasks are missing");
    assertEquals(
      dockerTasks.filter((t) => !builder.has(t.slice("docker : ".length))),
      [],
    );
    assertEquals(
      tasks.filter((t) => t.includes("Install Docker Engine")),
      [],
    );

    // hosting-caddy's main.yml runs only through the backfill, behind its
    // incomplete-edge check (after the probes and the vendored Caddy), never
    // ahead of it where the Caddy binary may not exist.
    const grant =
      "hosting-caddy : Grant the hosting Caddy execute on the vendored Caddy binary";
    const grants = tasks.flatMap((t, i) => (t === grant ? [i] : []));
    assertEquals(grants.length, 1, grant);
    const [firstProbe] = await taskNames(
      "hosting-caddy",
      "backfill-edge-account.yml",
    );
    const probe = tasks.indexOf(`hosting-caddy : ${firstProbe}`);
    assert(probe >= 0, "backfill-edge-account tasks are missing");
    assert(grants[0]! > probe, "hosting-caddy main.yml runs before backfill");

    // The play keeps its order: converge-builder, then the gate, then the
    // orchestrator and hosting Caddy backfills.
    const firstOf = (prefix: string) =>
      tasks.findIndex((t) => t.startsWith(prefix));
    const order = [
      firstOf("build-user : "),
      firstOf("docker : "),
      firstOf("docker-gate : "),
      firstOf("orchestrator : "),
      probe,
    ];
    assert(order.every((i) => i >= 0), String(order));
    assertEquals([...order].sort((a, b) => a - b), order);
  },
});

test("playbooks that run the orchestrator role install docker first", async () => {
  for (const name of ["orchestrator-setup.yml", "instance-install.yml"]) {
    const [play] = await readPlays(name);
    const roles = rolesEntered(play!).map((r) => r.name);
    const docker = roles.indexOf("docker");
    const orchestrator = roles.indexOf("orchestrator");
    assertEquals(docker >= 0 && docker < orchestrator, true, name);
  }
});
