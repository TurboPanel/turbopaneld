import { assert, assertEquals, assertRejects } from "@std/assert";
import type { LayoutPaths } from "../paths/layout.ts";
import { ensureSystemPrincipals, type RunFn } from "./ensure-principal.ts";
import {
  isReservedPrincipalUsername,
  RESERVED_PRINCIPAL_USERNAMES,
} from "./reserved-principal-names.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function recorder(): { run: RunFn; calls: string[][] } {
  const calls: string[][] = [];
  const run: RunFn = (command, args) => {
    calls.push([command, ...args]);
    if (command === "getent") {
      return Promise.resolve({ success: false, stdout: "", stderr: "" });
    }
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  return { run, calls };
}

const layout = { principalHomeRoot: "/srv/users" } as LayoutPaths;

const reservedError = (name: string) =>
  `The name ${name.trim()} is reserved for the host's own accounts, so it cannot be a site owner's Linux user. Pick another name.`;

const REFUSED_NAMES = [
  "ftp",
  "git",
  "FTP",
  " git ",
  "tpfoo",
  "systemd-x",
  "foo-grp",
  "root",
  "docker",
  "sudo",
] as const;

for (const name of REFUSED_NAMES) {
  test(`refuses reserved site owner's Linux user name ${JSON.stringify(name)}`, () => {
    assertEquals(isReservedPrincipalUsername(name), true);
  });

  test(`ensureSystemPrincipals never calls a runner for ${JSON.stringify(name)}`, async () => {
    const { run, calls } = recorder();
    await assertRejects(
      () =>
        ensureSystemPrincipals(layout, [{
          principalId: "p1",
          username: name,
        }], run),
      Error,
      reservedError(name),
    );
    assertEquals(calls.length, 0);
    assertEquals(
      calls.some((c) => c.includes("useradd") || c.includes("groupadd")),
      false,
    );
  });
}

test("a normal name is not reserved and still creates the account", async () => {
  assertEquals(isReservedPrincipalUsername("appuser"), false);
  const { run, calls } = recorder();
  await ensureSystemPrincipals(
    layout,
    [{ principalId: "p1", username: "appuser", uid: 20001, gid: 20001 }],
    run,
  );
  assert(calls.some((c) => c.includes("groupadd")));
  assert(calls.some((c) => c.includes("useradd")));
});

test("a reserved name later in the batch never creates an earlier account", async () => {
  const { run, calls } = recorder();
  await assertRejects(
    () =>
      ensureSystemPrincipals(layout, [
        { principalId: "p1", username: "appuser" },
        { principalId: "p2", username: "ftp" },
      ], run),
    Error,
    reservedError("ftp"),
  );
  assertEquals(calls.length, 0);
});

function reservedNamesFromTpHost(source: string): string[] {
  const match = source.match(/TP_RESERVED_NAMES="([^"]*)"/);
  if (match === null) {
    throw new TypeError("TP_RESERVED_NAMES was not found in the root helper");
  }
  return match[1].trim().split(/\s+/).filter((word) => word.length > 0);
}

test("every TP_RESERVED_NAMES word is in RESERVED_PRINCIPAL_USERNAMES", async () => {
  const source = await Deno.readTextFile(
    new URL("../../orchestration/scripts/tp-host", import.meta.url),
  );
  const words = reservedNamesFromTpHost(source);
  assert(words.length > 0, "TP_RESERVED_NAMES had no words");
  const missing = words.filter((word) =>
    !RESERVED_PRINCIPAL_USERNAMES.has(word)
  );
  assertEquals(missing, []);
});
