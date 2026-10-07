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

test("turbopanel-user never wipes the other:x traverse the runtimes rely on", async () => {
  const tasks = parse(
    await Deno.readTextFile(
      join(DAEMON_ROOT, "orchestration/roles/turbopanel-user/tasks/main.yml"),
    ),
  ) as Task[];
  const fileOn = (path: string) =>
    tasks
      .map((t) =>
        t["ansible.builtin.file"] as
          | { path?: string; mode?: string }
          | undefined
      )
      .filter((f) => f?.path === path);
  // An octal mode would reset the "other" bits on every install and upgrade,
  // so site owners' Linux users would lose traverse until a runtime role ran.
  for (
    const path of [
      "{{ turbopanel_install_root }}",
      "{{ turbopanel_vendor_dir }}",
    ]
  ) {
    const found = fileOn(path);
    assert(found.length === 1, `one file task for ${path}`);
    assertEquals(found[0]?.mode, "u=rwx,g=rx");
  }
  const acl = tasks
    .map((t) =>
      t["ansible.posix.acl"] as
        | { etype?: string; permissions?: string }
        | undefined
    )
    .find((a) => a?.etype === "other");
  assertEquals(acl?.permissions, "x");
});
