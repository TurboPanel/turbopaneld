import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { parse } from "yaml";
import { DAEMON_ROOT } from "./assets.ts";

const test = Deno.test.bind(Deno);

type Task = Record<string, unknown> & { name?: string };

test("node-app-runtime installs libatomic1 for the Node binary", async () => {
  const tasks = parse(
    await Deno.readTextFile(
      join(DAEMON_ROOT, "orchestration/roles/node-app-runtime/tasks/main.yml"),
    ),
  ) as Task[];
  const apt = tasks
    .map((t) => t["ansible.builtin.apt"] as { name?: unknown } | undefined)
    .filter((a) => a !== undefined)
    .flatMap((a) => [a!.name].flat());
  assert(apt.includes("libatomic1"), "libatomic1 missing from apt packages");
  assert(apt.includes("acl"));
});

test("node-app-runtime opens the tree to everyone before vendoring", async () => {
  const tasks = parse(
    await Deno.readTextFile(
      join(DAEMON_ROOT, "orchestration/roles/node-app-runtime/tasks/main.yml"),
    ),
  ) as Task[];
  const names = tasks.map((t) => t.name ?? "");
  const root = names.findIndex((n) => n.startsWith("Ensure the tenant"));
  const access = names.findIndex((n) => n.includes("reach the tenant"));
  const vendor = names.findIndex((n) => n.startsWith("Vendor each"));
  assert(root >= 0 && root < access && access < vendor);
  assertEquals(names.some((n) => n.includes("entitlement")), false);
});

test("deploy vendors the tenant runtimes before joining principals", async () => {
  const src = await Deno.readTextFile(
    join(DAEMON_ROOT, "src/commands/deploy-environment.ts"),
  );
  const runtime = src.indexOf("await ensureNativeAppRuntime(");
  const principals = src.indexOf("await ensureDeployPrincipals(\n    layout,");
  assert(runtime > 0 && principals > 0);
  assertEquals(runtime < principals, true);
});

test("deno-app-runtime opens the tree to everyone before vendoring, and verifies the archive checksum", async () => {
  const role = join(DAEMON_ROOT, "orchestration/roles/deno-app-runtime");
  const tasks = parse(
    await Deno.readTextFile(join(role, "tasks/main.yml")),
  ) as Task[];
  const names = tasks.map((t) => t.name ?? "");
  const root = names.findIndex((n) => n.startsWith("Ensure the tenant"));
  const access = names.findIndex((n) => n.includes("reach the tenant"));
  const vendor = names.findIndex((n) => n.startsWith("Vendor each"));
  assert(root >= 0 && root < access && access < vendor);
  assertEquals(names.some((n) => n.includes("entitlement")), false);
  const apt = tasks
    .map((t) => t["ansible.builtin.apt"] as { name?: unknown } | undefined)
    .filter((a) => a !== undefined)
    .flatMap((a) => [a!.name].flat());
  assert(apt.includes("unzip") && apt.includes("acl"));

  const script = await Deno.readTextFile(join(role, "files/install-series.sh"));
  // Official distribution over https only, and the published SHA-256 checked
  // before the archive is unpacked.
  assert(script.includes("--proto '=https'"));
  assert(script.includes(".sha256sum"));
  assert(script.indexOf("sha256sum -c -") < script.indexOf("unzip"));
  assertEquals(script.includes("npm"), false);
  const defaults = await Deno.readTextFile(join(role, "defaults/main.yml"));
  assert(defaults.includes("https://dl.deno.land"));
});

test("deno-app-runtime-apply is the one playbook that vendors Deno, and the root helper allows it", async () => {
  const playbook = await Deno.readTextFile(
    join(DAEMON_ROOT, "orchestration/playbooks/deno-app-runtime-apply.yml"),
  );
  assert(playbook.includes("name: deno-app-runtime"));
  const orchestrate = await Deno.readTextFile(
    join(DAEMON_ROOT, "orchestration/scripts/tp-orchestrate"),
  );
  assert(orchestrate.includes(" deno-app-runtime-apply.yml "));
  assert(orchestrate.includes(" deno_app_versions "));
});
