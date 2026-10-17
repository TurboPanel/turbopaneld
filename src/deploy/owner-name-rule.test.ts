import { assertEquals, assertRejects } from "@std/assert";
import type { LayoutPaths } from "../paths/layout.ts";
import { ensureSystemPrincipals, type RunFn } from "./ensure-principal.ts";

const test = Deno.test.bind(Deno);

const layout = { principalHomeRoot: "/srv/users" } as LayoutPaths;

function recorder(): { run: RunFn; calls: string[][] } {
  const calls: string[][] = [];
  const run: RunFn = (command, args) => {
    calls.push([command, ...args]);
    const ok = command !== "getent";
    return Promise.resolve({ success: ok, stdout: "", stderr: "" });
  };
  return { run, calls };
}

// The shared owner rule (lowercase, up to 28, no trailing or doubled dash, not
// starting with a digit) holds where the account is made, before any host call.
for (
  const name of [
    "Dana",
    "dANA",
    "a".repeat(29),
    "dana-",
    "da--na",
    "1dana",
    "da.na",
    "da na",
    "-dana",
  ]
) {
  test(`the account step refuses the owner name ${JSON.stringify(name)}`, async () => {
    const { run, calls } = recorder();
    await assertRejects(
      () =>
        ensureSystemPrincipals(
          layout,
          [{ principalId: "p1", username: name }],
          run,
        ),
      Error,
      "principal username",
    );
    // Nothing is created for a refused name.
    assertEquals(
      calls.some((c) => c.includes("groupadd") || c.includes("useradd")),
      false,
    );
  });
}

for (const name of ["dana", "_dana", "d-a_n9", "a".repeat(28)]) {
  test(`the account step accepts the owner name ${JSON.stringify(name)}`, async () => {
    const { run, calls } = recorder();
    await ensureSystemPrincipals(layout, [{
      principalId: "p1",
      username: name,
      uid: 20001,
      gid: 20001,
    }], run);
    assertEquals(calls.some((c) => c.includes("useradd")), true);
  });
}

test("the host's own account names stay reserved", async () => {
  const { run, calls } = recorder();
  await assertRejects(
    () =>
      ensureSystemPrincipals(
        layout,
        [{ principalId: "p1", username: "ftp" }],
        run,
      ),
    Error,
    "reserved",
  );
  assertEquals(calls.length, 0);
});
