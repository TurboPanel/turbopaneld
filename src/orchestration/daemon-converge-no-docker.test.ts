import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { DAEMON_ROOT } from "./assets.ts";

/** Sonar typescript:S2187 only recognizes `test()`; see other suites here. */
const test = Deno.test.bind(Deno);

const ORCH = join(DAEMON_ROOT, "orchestration");

async function readOrEmpty(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return "";
    throw err;
  }
}

/** `- role: name` entries (optionally followed by `tasks_from`) in a play. */
function playRoles(
  yaml: string,
): Array<{ name: string; tasksFrom: string | null }> {
  const out: Array<{ name: string; tasksFrom: string | null }> = [];
  const lines = yaml.split("\n");
  lines.forEach((line, i) => {
    const m = /^\s*-\s+role:\s*([\w.-]+)\s*$/.exec(line);
    if (!m) return;
    const next = /^\s*tasks_from:\s*(\S+)\s*$/.exec(lines[i + 1] ?? "");
    out.push({ name: m[1]!, tasksFrom: next ? next[1]! : null });
  });
  return out;
}

/** Role names under the `dependencies:` key of a role's meta/main.yml. */
function metaDependencies(meta: string): string[] {
  const idx = meta.search(/^dependencies:/m);
  if (idx < 0) return [];
  const block = meta.slice(idx).split("\n").slice(1);
  const names: string[] = [];
  for (const line of block) {
    if (/^\S/.test(line)) break;
    const m = /^\s*-\s+(?:role:\s*)?([\w.-]+)\s*$/.exec(line);
    if (m) names.push(m[1]!);
  }
  return names;
}

async function dependencyClosure(role: string): Promise<Set<string>> {
  const seen = new Set<string>();
  const queue = [role];
  while (queue.length > 0) {
    const current = queue.pop()!;
    // Sequential on purpose: the queue grows from each read.
    const meta = await readOrEmpty(
      join(ORCH, "roles", current, "meta/main.yml"),
    );
    for (const dep of metaDependencies(meta)) {
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }
  return seen;
}

test("daemon-converge never pulls the docker role in through a role dependency", async () => {
  const converge = await Deno.readTextFile(
    join(ORCH, "playbooks/daemon-converge.yml"),
  );
  const roles = playRoles(converge);
  assertEquals(roles.length > 5, true);

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
  for (const r of roles.filter((x) => x.name === "docker")) {
    assertEquals(r.tasksFrom, "converge-builder");
  }
});

test("playbooks that run the orchestrator role install docker first", async () => {
  for (const name of ["orchestrator-setup.yml", "instance-install.yml"]) {
    const roles = playRoles(
      await Deno.readTextFile(join(ORCH, "playbooks", name)),
    ).map((r) => r.name);
    const docker = roles.indexOf("docker");
    const orchestrator = roles.indexOf("orchestrator");
    assertEquals(docker >= 0 && docker < orchestrator, true, name);
  }
});
