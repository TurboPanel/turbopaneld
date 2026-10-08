/**
 * The site owner's Linux user and its group: the group carries the user's own
 * name (the standard Debian per-user group). An existing group of that name is
 * adopted only when it is in the band and is the account's own primary group;
 * an old `<name>-grp` is renamed in place.
 */
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import type { LayoutPaths } from "../paths/layout.ts";
import {
  ensureSystemPrincipals,
  legacyPrincipalUnixGroupName,
  type PrincipalEnsureSpec,
  principalUnixGroupName,
  type RunFn,
  type RunResult,
} from "./ensure-principal.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const layout = { principalHomeRoot: "/srv/users" } as LayoutPaths;
const spec: PrincipalEnsureSpec = {
  principalId: "01936b3e-aaaa-bbbb-cccc-123456789abc",
  username: "appuser",
  home: "/srv/users/appuser",
};
const PASSWD =
  "appuser:x:15001:15001::/srv/users/appuser/home:/usr/sbin/nologin";

const ok = (stdout = ""): RunResult => ({ success: true, stdout, stderr: "" });
const missing: RunResult = { success: false, stdout: "", stderr: "" };

/** A host: `getent` answers from the two maps, every `sudo` call succeeds. */
function host(
  groups: Record<string, string>,
  passwd: string | null,
  sudo: (args: string[]) => RunResult = () => ok(),
): { run: RunFn; sudoCalls: string[][] } {
  const sudoCalls: string[][] = [];
  const run: RunFn = (command, args) => {
    if (command === "getent" && args[0] === "group") {
      const line = groups[args[1]];
      return Promise.resolve(line === undefined ? missing : ok(line));
    }
    if (command === "getent" && args[0] === "passwd") {
      return Promise.resolve(passwd === null ? missing : ok(passwd));
    }
    if (command === "id") return Promise.resolve(ok(""));
    if (command === "sudo") {
      sudoCalls.push(args);
      if (args.includes("shadow")) {
        return Promise.resolve(ok("appuser:!:20000:0:99999:7:::"));
      }
      return Promise.resolve(sudo(args));
    }
    return Promise.resolve(ok());
  };
  return { run, sudoCalls };
}

const verb = (calls: string[][], name: string) =>
  calls.find((args) => args[1] === name);

test("the group carries the user's own name; the old name keeps its suffix", () => {
  assertEquals(principalUnixGroupName("appuser"), "appuser");
  assertEquals(legacyPrincipalUnixGroupName("appuser"), "appuser-grp");
});

test("an account whose primary group is still <name>-grp gets it renamed in place", async () => {
  const { run, sudoCalls } = host(
    { "appuser-grp": "appuser-grp:x:15001:tpnginx" },
    PASSWD,
  );
  await ensureSystemPrincipals(layout, [spec], run);
  assertEquals(verb(sudoCalls, "groupmod"), [
    "-n",
    "groupmod",
    "-n",
    "appuser",
    "appuser-grp",
  ]);
  assertEquals(verb(sudoCalls, "groupadd"), undefined);
  assertEquals(verb(sudoCalls, "useradd"), undefined);
  // The tree is handed to the renamed group.
  const install = sudoCalls.find((args) =>
    args[1] === "install" && args.at(-1) === "/srv/users/appuser"
  );
  assertEquals(install?.slice(-5), [
    "-o",
    "root",
    "-g",
    "appuser",
    "/srv/users/appuser",
  ]);
});

test("a failed rename stops the run with the host's reason", async () => {
  const { run } = host(
    { "appuser-grp": "appuser-grp:x:15001:" },
    PASSWD,
    (args) =>
      args[1] === "groupmod"
        ? { success: false, stdout: "", stderr: "groupmod: refused" }
        : ok(),
  );
  await assertRejects(
    () => ensureSystemPrincipals(layout, [spec], run),
    Error,
    "groupmod: refused",
  );
});

test("an old <name>-grp outside the band is not renamed", async () => {
  const { run, sudoCalls } = host(
    { "appuser-grp": "appuser-grp:x:1001:" },
    "appuser:x:15001:1001::/srv/users/appuser/home:/usr/sbin/nologin",
  );
  const err = await assertRejects(
    () => ensureSystemPrincipals(layout, [spec], run),
    Error,
  );
  assertStringIncludes(err.message, "below the current PRINCIPAL_ID_MIN");
  assertEquals(verb(sudoCalls, "groupmod"), undefined);
});

test("an existing account without a group of its own is refused, never given a new one", async () => {
  const { run, sudoCalls } = host(
    { "appuser-grp": "appuser-grp:x:15009:" },
    PASSWD,
  );
  const err = await assertRejects(
    () => ensureSystemPrincipals(layout, [spec], run),
    Error,
  );
  assertStringIncludes(err.message, "refusing to adopt the existing account");
  assertEquals(verb(sudoCalls, "groupadd"), undefined);
  assertEquals(verb(sudoCalls, "groupmod"), undefined);
});

test("a group of the user's name that is not the account's primary group is refused", async () => {
  const { run, sudoCalls } = host(
    {
      appuser: "appuser:x:15002:",
      "appuser-grp": "appuser-grp:x:15001:",
    },
    PASSWD,
  );
  const err = await assertRejects(
    () => ensureSystemPrincipals(layout, [spec], run),
    Error,
  );
  assertStringIncludes(
    err.message,
    "The name appuser is already used by a group on this host",
  );
  assertEquals(verb(sudoCalls, "groupmod"), undefined);
});

test("a group of the user's name above the band is refused", async () => {
  const { run } = host({ appuser: "appuser:x:61000:" }, null);
  const err = await assertRejects(
    () => ensureSystemPrincipals(layout, [spec], run),
    Error,
  );
  assertStringIncludes(err.message, "is above 60000");
});

test("a leftover group of the user's name in the band is adopted for a new account", async () => {
  const { run, sudoCalls } = host({ appuser: "appuser:x:15003:" }, null);
  await ensureSystemPrincipals(layout, [spec], run);
  assertEquals(verb(sudoCalls, "groupadd"), undefined);
  assertEquals(verb(sudoCalls, "useradd")?.includes("appuser"), true);
});

test("a group of the user's name that already has members is not taken over for a new account", async () => {
  const { run, sudoCalls } = host({ appuser: "appuser:x:15003:tpnginx" }, null);
  const err = await assertRejects(
    () => ensureSystemPrincipals(layout, [spec], run),
    Error,
  );
  assertStringIncludes(err.message, "already has members");
  assertEquals(verb(sudoCalls, "useradd"), undefined);
});

test("a user name ending in -grp is refused: it is an older owner's group", async () => {
  const { run, sudoCalls } = host({}, null);
  await assertRejects(
    () =>
      ensureSystemPrincipals(layout, [{
        ...spec,
        username: "bob-grp",
        home: "/srv/users/bob-grp",
      }], run),
    Error,
    "The name bob-grp is reserved for the host's own accounts, so it cannot be a site owner's Linux user. Pick another name.",
  );
  assertEquals(sudoCalls, []);
});
