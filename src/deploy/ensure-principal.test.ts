import { assertEquals, assertRejects } from "@std/assert";
import type { LayoutPaths } from "../paths/layout.ts";
import {
  DEFAULT_PRINCIPAL_SHELL,
  ensureSystemPrincipals,
  type PrincipalEnsureSpec,
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

function stubLayout(principalHomeRoot = "/srv/users"): LayoutPaths {
  return { principalHomeRoot } as LayoutPaths;
}

function captureRun(handlers: {
  getentPasswd?: RunResult;
  getentGroup?: RunResult;
}): { run: RunFn; calls: Array<{ command: string; args: string[] }> } {
  const calls: Array<{ command: string; args: string[] }> = [];
  const run: RunFn = (command, args) => {
    calls.push({ command, args });
    if (command === "getent" && args[0] === "group") {
      return Promise.resolve(
        handlers.getentGroup ?? { success: false, stdout: "", stderr: "" },
      );
    }
    if (command === "getent" && args[0] === "passwd") {
      return Promise.resolve(
        handlers.getentPasswd ?? { success: false, stdout: "", stderr: "" },
      );
    }
    // sudo install / useradd / groupadd / usermod succeed by default
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  return { run, calls };
}

const baseSpec: PrincipalEnsureSpec = {
  principalId: "01936b3e-aaaa-bbbb-cccc-123456789abc",
  username: "appuser",
  uid: 10001,
  gid: 10001,
};

test("ensureSystemPrincipals fresh create uses useradd -d -M -s", async () => {
  const { run, calls } = captureRun({});
  const home = `/srv/users/${baseSpec.principalId}`;
  await ensureSystemPrincipals(stubLayout(), [{
    ...baseSpec,
    home,
    shell: "/bin/bash",
  }], run);

  const useradd = calls.find((c) =>
    c.command === "sudo" && c.args.includes("useradd")
  );
  assertEquals(useradd?.args, [
    "-n",
    "useradd",
    "-u",
    "10001",
    "-g",
    "10001",
    "-d",
    home,
    "-M",
    "-s",
    "/bin/bash",
    "appuser",
  ]);

  const installHome = calls.find((c) =>
    c.command === "sudo" &&
    c.args.includes("install") &&
    c.args.includes(home) &&
    c.args.includes("0750")
  );
  assertEquals(installHome?.args.includes("-o"), true);
  assertEquals(installHome?.args.includes("10001"), true);
});

test("ensureSystemPrincipals reconciles differing home and shell via usermod", async () => {
  const { run, calls } = captureRun({
    getentGroup: { success: true, stdout: "appuser-grp:x:10001:", stderr: "" },
    getentPasswd: {
      success: true,
      stdout: "appuser:x:10001:10001::/old/home:/usr/sbin/nologin",
      stderr: "",
    },
  });
  const home = `/srv/users/${baseSpec.principalId}`;
  await ensureSystemPrincipals(stubLayout(), [{
    ...baseSpec,
    home,
    shell: "/bin/bash",
  }], run);

  assertEquals(
    calls.some((c) => c.command === "sudo" && c.args.includes("useradd")),
    false,
  );
  const usermodHome = calls.find((c) =>
    c.command === "sudo" &&
    c.args.includes("usermod") &&
    c.args.includes("-d")
  );
  assertEquals(usermodHome?.args, [
    "-n",
    "usermod",
    "-d",
    home,
    "appuser",
  ]);
  const usermodShell = calls.find((c) =>
    c.command === "sudo" &&
    c.args.includes("usermod") &&
    c.args.includes("-s")
  );
  assertEquals(usermodShell?.args, [
    "-n",
    "usermod",
    "-s",
    "/bin/bash",
    "appuser",
  ]);
  assertEquals(
    calls.some((c) =>
      c.command === "sudo" &&
      c.args.includes("usermod") &&
      c.args.includes("-m")
    ),
    false,
  );
});

test("ensureSystemPrincipals defaults shell to nologin", async () => {
  const { run, calls } = captureRun({});
  await ensureSystemPrincipals(stubLayout(), [baseSpec], run);
  const useradd = calls.find((c) =>
    c.command === "sudo" && c.args.includes("useradd")
  );
  assertEquals(useradd?.args.includes(DEFAULT_PRINCIPAL_SHELL), true);
  assertEquals(
    useradd?.args[useradd.args.indexOf("-s") + 1],
    DEFAULT_PRINCIPAL_SHELL,
  );
});

test("ensureSystemPrincipals rejects relative home", async () => {
  const { run } = captureRun({});
  await assertRejects(
    () =>
      ensureSystemPrincipals(stubLayout(), [{
        ...baseSpec,
        home: "relative/home",
      }], run),
    Error,
    "Invalid principal home",
  );
});

test("ensureSystemPrincipals rejects home with .. segment", async () => {
  const { run } = captureRun({});
  await assertRejects(
    () =>
      ensureSystemPrincipals(stubLayout(), [{
        ...baseSpec,
        home: "/srv/users/../etc",
      }], run),
    Error,
    "Invalid principal home",
  );
});

test("ensureSystemPrincipals rejects existing username with mismatched uid/gid without usermod", async () => {
  const { run, calls } = captureRun({
    getentGroup: { success: true, stdout: "appuser-grp:x:10001:", stderr: "" },
    getentPasswd: {
      success: true,
      // Collision: same username, different host UID/GID.
      stdout: "appuser:x:33:33::/var/www:/usr/sbin/nologin",
      stderr: "",
    },
  });
  const home = `/srv/users/${baseSpec.principalId}`;
  await assertRejects(
    () =>
      ensureSystemPrincipals(stubLayout(), [{
        ...baseSpec,
        home,
        shell: "/bin/bash",
      }], run),
    Error,
    "already exists with uid=33 gid=33",
  );
  assertEquals(
    calls.some((c) => c.command === "sudo" && c.args.includes("usermod")),
    false,
  );
  assertEquals(
    calls.some((c) =>
      c.command === "sudo" &&
      c.args.includes("install") &&
      c.args.includes(home)
    ),
    false,
  );
});
