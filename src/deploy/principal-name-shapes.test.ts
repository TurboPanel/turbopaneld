import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { parsePrincipalsReconcilePayload } from "../contracts/commands-contracts.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import {
  ensureSystemPrincipals,
  principalUnixGroupName,
  type RunFn,
} from "./ensure-principal.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

// The three name schemes the control plane can send (see "Name schemes" docs).
const PLAIN = "bob";
const PARTIAL = "bob_x7k2m9qpz1a";
const RANDOM = "u7k2m9x4qpz1";

function material(username: string) {
  return { principals: [{ principalId: "p1", username }] };
}

function accepted(username: string): string[] {
  return parsePrincipalsReconcilePayload(material(username)).principals.map((
    p,
  ) => p.username);
}

for (const name of [PLAIN, PARTIAL, RANDOM, "a".repeat(28), "_svc-1"]) {
  test(`contract accepts principal name ${name}`, () => {
    assertEquals(accepted(name), [name]);
  });
}

test("contract rejects a 29 character name", () => {
  assertThrows(() => accepted("a".repeat(29)), TypeError);
});

test("contract rejects names outside the POSIX allowlist", () => {
  for (
    const bad of [
      "1bob",
      "-bob",
      "Bob!",
      "bob.x",
      "bob x",
      "bob\n",
      "bob:x",
      "bob/../x",
      "böb",
    ]
  ) {
    assertThrows(() => accepted(bad), TypeError, undefined, bad);
  }
  assertThrows(() => accepted(""), TypeError);
});

test("group name for the longest accepted name fits 32 characters", () => {
  const group = principalUnixGroupName("a".repeat(28));
  assertEquals(group, `${"a".repeat(28)}-grp`);
  assert(group.length <= 32);
});

function recorder(): { run: RunFn; calls: string[][] } {
  const calls: string[][] = [];
  const run: RunFn = (command, args) => {
    calls.push([command, ...args]);
    const miss = { success: false, stdout: "", stderr: "" };
    if (command === "getent") return Promise.resolve(miss);
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  return { run, calls };
}

const layout = { principalHomeRoot: "/srv/users" } as LayoutPaths;

for (const name of [PLAIN, PARTIAL, RANDOM]) {
  test(`daemon uses ${name} verbatim, no re-derivation`, async () => {
    const { run, calls } = recorder();
    await ensureSystemPrincipals(
      layout,
      [{ principalId: "p1", username: name, uid: 20001, gid: 20001 }],
      run,
    );
    const add = calls.find((c) => c.includes("useradd"));
    assert(add, "useradd was not called");
    assert(add.includes(name), "useradd must carry the given name");
    assert(add.includes(`/srv/users/${name}/home`));
    const group = calls.find((c) => c.includes("groupadd"));
    assert(group?.includes(`${name}-grp`));
  });
}

test("daemon refuses a 29 character name before touching the host", async () => {
  const { run, calls } = recorder();
  await assertRejects(
    () =>
      ensureSystemPrincipals(layout, [{
        principalId: "p1",
        username: "a".repeat(29),
      }], run),
    Error,
    "Invalid principal username",
  );
  assertEquals(calls.length, 0);
});
