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

test("node-app-runtime creates the series groups before tree and membership", async () => {
  const tasks = parse(
    await Deno.readTextFile(
      join(DAEMON_ROOT, "orchestration/roles/node-app-runtime/tasks/main.yml"),
    ),
  ) as Task[];
  const names = tasks.map((t) => t.name ?? "");
  const group = names.findIndex((n) => n.includes("entitlement groups"));
  const acl = names.findIndex((n) => n.includes("traversal of the tenant"));
  const vendor = names.findIndex((n) => n.startsWith("Vendor each"));
  assert(group >= 0 && group < acl && acl < vendor);
});

test("deploy creates the runtime groups before joining principals to them", async () => {
  const src = await Deno.readTextFile(
    join(DAEMON_ROOT, "src/commands/deploy-environment.ts"),
  );
  const runtime = src.indexOf("await ensureNativeAppRuntime(");
  const principals = src.indexOf("await ensureDeployPrincipals(\n    layout,");
  assert(runtime > 0 && principals > 0);
  assertEquals(runtime < principals, true);
});
