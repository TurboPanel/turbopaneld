import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { parse } from "yaml";
import { CACHE_RUNTIMES } from "../deploy/cache/limits.ts";
import { CACHE_RUNTIME_APPLY_PLAYBOOK, DAEMON_ROOT } from "./assets.ts";
import { tpOrchestratePlaybookAllowlist } from "../testing/tp-orchestrate-validator.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ROLE = join(DAEMON_ROOT, "orchestration/roles/valkey-runtime");

type Task = Record<string, unknown> & { name?: string };

async function tasks(): Promise<Task[]> {
  return parse(await Deno.readTextFile(join(ROLE, "tasks/main.yml"))) as Task[];
}

async function defaults(): Promise<Record<string, unknown>> {
  return parse(
    await Deno.readTextFile(join(ROLE, "defaults/main.yml")),
  ) as Record<string, unknown>;
}

test("the role pins the patch release the daemon maps the series to, and both digests", async () => {
  const d = await defaults();
  assertEquals(d.valkey_runtime_version, CACHE_RUNTIMES.valkey["8.1"]);
  assertEquals(d.valkey_runtime_sha256, {
    x86_64: "e61780835a35fee3a9718dad1424701796414ff247ed5cffdd7d7e2dd79c2efa",
    arm64: "638950c50a7dc65077e76b333916c6170e8eee74528d92c33c317a6e9d6986a5",
  });
});

test("the install checks the digest, takes only the server and its licence, and sets root-owned modes", async () => {
  const install = (await tasks()).find((t) =>
    t.name === "Install Valkey into the runtimes directory"
  );
  const shell = String(install?.["ansible.builtin.shell"]);
  assert(shell.includes("download.valkey.io/releases/${NAME}.tar.gz"));
  assert(shell.includes('NAME="valkey-${VER}-jammy-${ARCH}"'));
  assert(shell.includes('sha256sum "$TMP/valkey.tar.gz"'));
  assert(shell.includes("SHA-256 mismatch"));
  // Only these two members are extracted; nothing is run from the archive.
  assert(shell.includes('"${NAME}/bin/valkey-server" "${NAME}/share/LICENSE"'));
  assert(
    shell.includes(
      'install -m 0755 -o root -g root "$TMP/extract/bin/valkey-server" "$DEST/bin/valkey-server"',
    ),
  );
  // The licence sits beside the binary.
  assert(
    shell.includes(
      'install -m 0644 -o root -g root "$TMP/extract/share/LICENSE" "$DEST/share/LICENSE"',
    ),
  );
  assertEquals(shell.includes("valkey-cli"), false);
  assertEquals(shell.includes("noble"), false);
  assertEquals(
    (install?.args as Record<string, unknown>).creates,
    "{{ valkey_runtime_root }}/{{ valkey_runtime_version }}/bin/valkey-server",
  );
});

test("every Hosting Account can reach the binary: the tree is opened before vendoring", async () => {
  const list = await tasks();
  const names = list.map((t) => t.name ?? "");
  const apt = list
    .map((t) => t["ansible.builtin.apt"] as { name?: unknown } | undefined)
    .filter((a) => a !== undefined)
    .flatMap((a) => [a!.name].flat());
  assert(apt.includes("acl"));
  const root = names.findIndex((n) => n.startsWith("Ensure the Valkey tree"));
  const access = names.findIndex((n) => n.includes("reach the Valkey tree"));
  const install = names.findIndex((n) => n.startsWith("Install Valkey"));
  assert(root >= 0 && root < access && access < install);
  const grant = list[access]["ansible.builtin.include_role"] as {
    name: string;
  };
  assertEquals(grant.name, "runtime-access");
  assertEquals(
    (list[access].vars as { runtime_access_dirs: string[] })
      .runtime_access_dirs,
    ["{{ valkey_runtime_root }}"],
  );
});

test("the first cache sets memory overcommit in its own drop-in", async () => {
  const sysctl = (await tasks()).find((t) =>
    t["ansible.posix.sysctl"] !== undefined
  )?.["ansible.posix.sysctl"] as Record<string, unknown>;
  assertEquals(sysctl.name, "vm.overcommit_memory");
  assertEquals(sysctl.value, "1");
  assertEquals(sysctl.sysctl_file, "/etc/sysctl.d/99-turbopanel-cache.conf");
});

test("the lazy playbook exists, runs the role, and is on the helper's allowlist", async () => {
  const playbook = parse(
    await Deno.readTextFile(CACHE_RUNTIME_APPLY_PLAYBOOK),
  ) as Array<{ tasks: Array<Record<string, unknown>> }>;
  assertEquals(
    playbook[0].tasks[0]["ansible.builtin.include_role"],
    { name: "valkey-runtime" },
  );
  const allowlist = await tpOrchestratePlaybookAllowlist();
  assert(allowlist.includes("cache-runtime-apply.yml"));
  assertEquals([...allowlist], [...allowlist].sort());
});

test("the role code is licensed like the rest of the orchestration", async () => {
  const meta = parse(
    await Deno.readTextFile(join(ROLE, "meta/main.yml")),
  ) as { galaxy_info: { license: string } };
  assertEquals(meta.galaxy_info.license, "AGPL-3.0");
});
