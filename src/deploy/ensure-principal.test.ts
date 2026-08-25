import { assert, assertEquals, assertRejects } from "@std/assert";
import type { LayoutPaths } from "../paths/layout.ts";
import {
  DEFAULT_PRINCIPAL_SHELL,
  ensureDirectoryOwnedByPrincipal,
  ensurePrincipalManagedGroups,
  ensureSystemPrincipals,
  parseGroupGid,
  parsePasswdHomeShell,
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

function stubLayout(principalHomeRoot = "/srv/users"): LayoutPaths {
  return { principalHomeRoot } as LayoutPaths;
}

function captureRun(handlers: {
  getentPasswd?: RunResult;
  getentGroup?: RunResult;
  /** Supplementary groups `id -nG` reports for the account. */
  groups?: string[];
}): { run: RunFn; calls: Array<{ command: string; args: string[] }> } {
  const calls: Array<{ command: string; args: string[] }> = [];
  const run: RunFn = (command, args) => {
    calls.push({ command, args });
    if (command === "id") {
      return Promise.resolve({
        success: true,
        stdout: (handlers.groups ?? []).join(" "),
        stderr: "",
      });
    }
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
};

const defaultHome = "/srv/users/appuser";

test("ensureSystemPrincipals fresh create without ids uses group name and omits -u", async () => {
  const { run, calls } = captureRun({});
  await ensureSystemPrincipals(stubLayout(), [{
    ...baseSpec,
    home: defaultHome,
    shell: "/bin/bash",
  }], run);

  const groupProbe = calls.find((c) =>
    c.command === "getent" && c.args[0] === "group"
  );
  assertEquals(groupProbe?.args, ["group", "appuser-grp"]);

  const useradd = calls.find((c) =>
    c.command === "sudo" && c.args.includes("useradd")
  );
  assertEquals(useradd?.args, [
    "-n",
    "useradd",
    "-g",
    "appuser-grp",
    "-d",
    defaultHome,
    "-M",
    "-s",
    "/bin/bash",
    "appuser",
  ]);
  assertEquals(useradd?.args.includes("-u"), false);

  const installHome = calls.find((c) =>
    c.command === "sudo" &&
    c.args.includes("install") &&
    c.args.includes(defaultHome) &&
    c.args.includes("0750")
  );
  assertEquals(installHome?.args.includes("-o"), true);
  assertEquals(installHome?.args.includes("appuser"), true);
  assertEquals(installHome?.args.includes("appuser-grp"), true);
});

test("ensureSystemPrincipals fresh create with explicit uid/gid passes -u and groupadd -g", async () => {
  const { run, calls } = captureRun({});
  await ensureSystemPrincipals(stubLayout(), [{
    ...baseSpec,
    uid: 10001,
    gid: 10001,
    home: defaultHome,
    shell: "/bin/bash",
  }], run);

  const groupadd = calls.find((c) =>
    c.command === "sudo" && c.args.includes("groupadd")
  );
  assertEquals(groupadd?.args, [
    "-n",
    "groupadd",
    "-g",
    "10001",
    "appuser-grp",
  ]);

  const useradd = calls.find((c) =>
    c.command === "sudo" && c.args.includes("useradd")
  );
  assertEquals(useradd?.args, [
    "-n",
    "useradd",
    "-u",
    "10001",
    "-g",
    "appuser-grp",
    "-d",
    defaultHome,
    "-M",
    "-s",
    "/bin/bash",
    "appuser",
  ]);
});

test("ensureSystemPrincipals adopts matching home and reconciles shell only", async () => {
  const { run, calls } = captureRun({
    getentGroup: { success: true, stdout: "appuser-grp:x:10001:", stderr: "" },
    getentPasswd: {
      success: true,
      stdout: "appuser:x:10001:10001::/srv/users/appuser:/usr/sbin/nologin",
      stderr: "",
    },
  });
  await ensureSystemPrincipals(stubLayout(), [{
    ...baseSpec,
    home: defaultHome,
    shell: "/bin/bash",
  }], run);

  assertEquals(
    calls.some((c) => c.command === "sudo" && c.args.includes("useradd")),
    false,
  );
  assertEquals(
    calls.some((c) =>
      c.command === "sudo" &&
      c.args.includes("usermod") &&
      c.args.includes("-d")
    ),
    false,
  );
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

test("ensureSystemPrincipals refuses foreign home without usermod or install", async () => {
  const { run, calls } = captureRun({
    getentGroup: { success: true, stdout: "appuser-grp:x:33:", stderr: "" },
    getentPasswd: {
      success: true,
      stdout: "appuser:x:33:33::/var/www:/usr/sbin/nologin",
      stderr: "",
    },
  });
  await assertRejects(
    () =>
      ensureSystemPrincipals(stubLayout(), [{
        ...baseSpec,
        home: defaultHome,
        shell: "/bin/bash",
      }], run),
    Error,
    "refusing to adopt existing account `appuser` — home `/var/www` does not match `/srv/users/appuser`",
  );
  assertEquals(
    calls.some((c) => c.command === "sudo" && c.args.includes("usermod")),
    false,
  );
  assertEquals(
    calls.some((c) =>
      c.command === "sudo" &&
      c.args.includes("install") &&
      c.args.includes(defaultHome)
    ),
    false,
  );
});

test("ensureSystemPrincipals rejects existing username with mismatched uid override", async () => {
  const { run, calls } = captureRun({
    getentGroup: { success: true, stdout: "appuser-grp:x:10001:", stderr: "" },
    getentPasswd: {
      success: true,
      stdout: "appuser:x:33:33::/srv/users/appuser:/usr/sbin/nologin",
      stderr: "",
    },
  });
  await assertRejects(
    () =>
      ensureSystemPrincipals(stubLayout(), [{
        ...baseSpec,
        uid: 10001,
        home: defaultHome,
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
      c.args.includes(defaultHome)
    ),
    false,
  );
});

test("ensureSystemPrincipals adopts existing group when gid override matches", async () => {
  const { run, calls } = captureRun({
    getentGroup: { success: true, stdout: "appuser-grp:x:10001:", stderr: "" },
  });
  await ensureSystemPrincipals(stubLayout(), [{
    ...baseSpec,
    gid: 10001,
    home: defaultHome,
    shell: "/bin/bash",
  }], run);

  assertEquals(
    calls.some((c) => c.command === "sudo" && c.args.includes("groupadd")),
    false,
  );
  const useradd = calls.find((c) =>
    c.command === "sudo" && c.args.includes("useradd")
  );
  assertEquals(useradd?.args, [
    "-n",
    "useradd",
    "-g",
    "appuser-grp",
    "-d",
    defaultHome,
    "-M",
    "-s",
    "/bin/bash",
    "appuser",
  ]);
});

test("ensureSystemPrincipals rejects existing group with mismatched gid override before useradd", async () => {
  const { run, calls } = captureRun({
    getentGroup: { success: true, stdout: "appuser-grp:x:33:", stderr: "" },
  });
  await assertRejects(
    () =>
      ensureSystemPrincipals(stubLayout(), [{
        ...baseSpec,
        gid: 10001,
        home: defaultHome,
        shell: "/bin/bash",
      }], run),
    Error,
    "Principal group appuser-grp already exists with gid=33; expected gid=10001",
  );
  assertEquals(
    calls.some((c) => c.command === "sudo" && c.args.includes("useradd")),
    false,
  );
  assertEquals(
    calls.some((c) =>
      c.command === "sudo" &&
      c.args.includes("install") &&
      c.args.includes(defaultHome)
    ),
    false,
  );
  assertEquals(
    calls.some((c) => c.command === "getent" && c.args[0] === "passwd"),
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

test("principalUnixGroupName and username length fit Linux 32-char group limit", async () => {
  // Longest accepted username (28) → group name exactly 32.
  const longest = `u${"a".repeat(27)}`;
  assertEquals(longest.length, 28);
  assertEquals(principalUnixGroupName(longest), `${longest}-grp`);
  assertEquals(principalUnixGroupName(longest).length, 32);

  const { run, calls } = captureRun({});
  await ensureSystemPrincipals(stubLayout(), [{
    principalId: "01936b3e-aaaa-bbbb-cccc-123456789abc",
    username: longest,
    home: `/srv/users/${longest}`,
  }], run);
  assertEquals(
    calls.some((c) =>
      c.command === "getent" && c.args[0] === "group" &&
      c.args[1] === `${longest}-grp`
    ),
    true,
  );

  // First rejected overlong value (29).
  const overlong = `u${"a".repeat(28)}`;
  assertEquals(overlong.length, 29);
  await assertRejects(
    () =>
      ensureSystemPrincipals(stubLayout(), [{
        principalId: "01936b3e-aaaa-bbbb-cccc-123456789abc",
        username: overlong,
        home: `/srv/users/${overlong}`,
      }], run),
    Error,
    "Invalid principal username",
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

test("ensureDirectoryOwnedByPrincipal chowns when mkdir succeeds", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-principal-dir-" });
  const path = `${root}/owned`;
  const calls: Array<{ command: string; args: string[] }> = [];
  try {
    await ensureDirectoryOwnedByPrincipal(
      path,
      "appuser",
      "appuser-grp",
      (command, args) => {
        calls.push({ command, args: [...args] });
        return Promise.resolve({ success: true, stdout: "", stderr: "" });
      },
    );
    const st = await Deno.stat(path);
    assertEquals(st.isDirectory, true);
    assertEquals(
      calls.some((c) =>
        c.command === "sudo" && c.args.includes("chown") &&
        c.args.includes("appuser:appuser-grp")
      ),
      true,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("ensureDirectoryOwnedByPrincipal throws when chown fails", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-principal-chown-" });
  const path = `${root}/owned`;
  try {
    await assertRejects(
      () =>
        ensureDirectoryOwnedByPrincipal(
          path,
          "appuser",
          "appuser-grp",
          (command, args) => {
            if (command === "sudo" && args.includes("chown")) {
              return Promise.resolve({
                success: false,
                stdout: "",
                stderr: "chown denied",
              });
            }
            return Promise.resolve({ success: true, stdout: "", stderr: "" });
          },
        ),
      Error,
      "chown denied",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("parsePasswdHomeShell and parseGroupGid reject malformed lines", () => {
  assertEquals(parsePasswdHomeShell("too:few"), null);
  assertEquals(
    parsePasswdHomeShell("u:x:notint:1000::/home/u:/bin/sh"),
    null,
  );
  assertEquals(
    parsePasswdHomeShell("u:x:1000:1000:::/bin/sh"),
    null,
  );
  assertEquals(
    parsePasswdHomeShell("u:x:1000:1000::/home/u:"),
    null,
  );
  assertEquals(parseGroupGid("nogid"), null);
  assertEquals(parseGroupGid("g:x:notint:"), null);
  assertEquals(parseGroupGid("g:x:42:"), 42);
});

test("ensureSystemPrincipals fails when group entry cannot be parsed with gid override", async () => {
  const { run } = captureRun({
    getentGroup: { success: true, stdout: "appuser-grp:x:broken:", stderr: "" },
  });
  await assertRejects(
    () =>
      ensureSystemPrincipals(stubLayout(), [{
        ...baseSpec,
        gid: 2000,
        home: defaultHome,
      }], run),
    Error,
    "Failed to parse group entry",
  );
});

test("ensureSystemPrincipals fails when groupadd fails", async () => {
  const run: RunFn = (command, args) => {
    if (command === "getent") {
      return Promise.resolve({ success: false, stdout: "", stderr: "" });
    }
    if (command === "sudo" && args.includes("groupadd")) {
      return Promise.resolve({
        success: false,
        stdout: "",
        stderr: "groupadd denied",
      });
    }
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  await assertRejects(
    () =>
      ensureSystemPrincipals(stubLayout(), [{
        ...baseSpec,
        home: defaultHome,
      }], run),
    Error,
    "groupadd denied",
  );
});

test("ensureSystemPrincipals fails when useradd fails", async () => {
  const run: RunFn = (command, args) => {
    if (command === "getent" && args[0] === "group") {
      return Promise.resolve({ success: false, stdout: "", stderr: "" });
    }
    if (command === "getent" && args[0] === "passwd") {
      return Promise.resolve({ success: false, stdout: "", stderr: "" });
    }
    if (command === "sudo" && args.includes("useradd")) {
      return Promise.resolve({
        success: false,
        stdout: "",
        stderr: "useradd denied",
      });
    }
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  await assertRejects(
    () =>
      ensureSystemPrincipals(stubLayout(), [{
        ...baseSpec,
        home: defaultHome,
      }], run),
    Error,
    "useradd denied",
  );
});

test("ensureSystemPrincipals fails when existing passwd line is unparsable", async () => {
  const { run } = captureRun({
    getentGroup: {
      success: true,
      stdout: "appuser-grp:x:1000:",
      stderr: "",
    },
    getentPasswd: {
      success: true,
      stdout: "appuser:x:bad:bad::/srv/users/appuser:/bin/bash",
      stderr: "",
    },
  });
  await assertRejects(
    () =>
      ensureSystemPrincipals(stubLayout(), [{
        ...baseSpec,
        home: defaultHome,
      }], run),
    Error,
    "Failed to parse passwd entry",
  );
});

test("ensureSystemPrincipals fails when usermod -s fails", async () => {
  const run: RunFn = (command, args) => {
    if (command === "getent" && args[0] === "group") {
      return Promise.resolve({
        success: true,
        stdout: "appuser-grp:x:1000:",
        stderr: "",
      });
    }
    if (command === "getent" && args[0] === "passwd") {
      return Promise.resolve({
        success: true,
        stdout: `appuser:x:1000:1000::${defaultHome}:/bin/false`,
        stderr: "",
      });
    }
    if (command === "sudo" && args.includes("usermod")) {
      return Promise.resolve({
        success: false,
        stdout: "",
        stderr: "usermod denied",
      });
    }
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  await assertRejects(
    () =>
      ensureSystemPrincipals(stubLayout(), [{
        ...baseSpec,
        home: defaultHome,
        shell: "/bin/bash",
      }], run),
    Error,
    "usermod denied",
  );
});

test("ensureDirectoryOwnedByPrincipal falls back to sudo install -d when mkdir fails", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-principal-mkdir-" });
  const blockedParent = `${root}/blocked`;
  await Deno.mkdir(blockedParent, { mode: 0o500 });
  const path = `${blockedParent}/child`;
  const calls: Array<{ command: string; args: string[] }> = [];
  try {
    await Deno.chmod(blockedParent, 0o000);
    await ensureDirectoryOwnedByPrincipal(
      path,
      "appuser",
      "appuser-grp",
      (command, args) => {
        calls.push({ command, args: [...args] });
        return Promise.resolve({ success: true, stdout: "", stderr: "" });
      },
    );
    assertEquals(
      calls.some((c) =>
        c.command === "sudo" && c.args.includes("install") &&
        c.args.includes("-d")
      ),
      true,
    );
  } finally {
    try {
      await Deno.chmod(blockedParent, 0o755);
    } catch {
      // best-effort
    }
    await Deno.remove(root, { recursive: true });
  }
});

test("ensureDirectoryOwnedByPrincipal throws when sudo install -d fails", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-principal-install-fail-" });
  const blockedParent = `${root}/blocked`;
  await Deno.mkdir(blockedParent, { mode: 0o500 });
  const path = `${blockedParent}/child`;
  try {
    await Deno.chmod(blockedParent, 0o000);
    await assertRejects(
      () =>
        ensureDirectoryOwnedByPrincipal(
          path,
          "appuser",
          "appuser-grp",
          (command, args) => {
            if (
              command === "sudo" && args.includes("install") &&
              args.includes("-d")
            ) {
              return Promise.resolve({
                success: false,
                stdout: "",
                stderr: "install -d denied",
              });
            }
            return Promise.resolve({ success: true, stdout: "", stderr: "" });
          },
        ),
      Error,
      "install -d denied",
    );
  } finally {
    try {
      await Deno.chmod(blockedParent, 0o755);
    } catch {
      // best-effort
    }
    await Deno.remove(root, { recursive: true });
  }
});

/** Runner that answers `id -nG` with a fixed group set and records mutations. */
function runtimeGroupRun(current: string[]): {
  run: RunFn;
  calls: Array<{ command: string; args: string[] }>;
} {
  const calls: Array<{ command: string; args: string[] }> = [];
  const run: RunFn = (command, args) => {
    calls.push({ command, args });
    if (command === "id") {
      return Promise.resolve({
        success: true,
        stdout: current.join(" "),
        stderr: "",
      });
    }
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  return { run, calls };
}

function groupMutations(
  calls: Array<{ command: string; args: string[] }>,
): string[][] {
  return calls
    .filter((c) => c.args.includes("usermod") || c.args.includes("gpasswd"))
    .map((c) => c.args);
}

test("ensurePrincipalManagedGroups adds only the missing groups", async () => {
  const { run, calls } = runtimeGroupRun(["appuser-grp", "tpphp84"]);
  await ensurePrincipalManagedGroups(
    "appuser",
    new Set(["tpphp84", "tpnode24"]),
    run,
  );
  assertEquals(groupMutations(calls), [
    ["-n", "usermod", "-aG", "tpnode24", "appuser"],
  ]);
});

test("ensurePrincipalManagedGroups revokes a group that is no longer granted", async () => {
  // The whole reason this function exists: `usermod -aG` can only add, so a
  // principal that once deployed a Node app could execute Node forever.
  const { run, calls } = runtimeGroupRun(["appuser-grp", "tpnode24"]);
  await ensurePrincipalManagedGroups("appuser", new Set(["tpphp84"]), run);
  assertEquals(groupMutations(calls), [
    ["-n", "usermod", "-aG", "tpphp84", "appuser"],
    ["-n", "gpasswd", "-d", "appuser", "tpnode24"],
  ]);
});

test("ensurePrincipalManagedGroups never touches a group outside the registry", async () => {
  // Containment is what makes revocation safe. `<username>-grp` is the
  // principal's primary group, `tp` is the panel's own, `tpnginx` is an engine
  // account joined for release reads, and `ops` is something an operator added
  // by hand. None of them are entitlements, so none may be stripped.
  const { run, calls } = runtimeGroupRun([
    "appuser-grp",
    "tp",
    "tpnginx",
    "ops",
    "tpnode24",
  ]);
  await ensurePrincipalManagedGroups("appuser", new Set(), run);
  assertEquals(groupMutations(calls), [
    ["-n", "gpasswd", "-d", "appuser", "tpnode24"],
  ]);
});

test("ensurePrincipalManagedGroups rejects a group the registry does not define", async () => {
  const { run } = runtimeGroupRun([]);
  await assertRejects(
    () => ensurePrincipalManagedGroups("appuser", new Set(["tpevil"]), run),
    Error,
    "unknown managed group",
  );
});

test("ensurePrincipalManagedGroups tolerates a host missing the group", async () => {
  // A host provisioned some other way may legitimately not have the group yet;
  // the unit's own health probe is what catches an unreachable runtime. A
  // failed *revoke* stays loud, since a lingering entitlement is a real risk.
  const calls: Array<{ command: string; args: string[] }> = [];
  const run: RunFn = (command, args) => {
    calls.push({ command, args });
    if (command === "id") {
      return Promise.resolve({
        success: true,
        stdout: "appuser-grp",
        stderr: "",
      });
    }
    return Promise.resolve({
      success: false,
      stdout: "",
      stderr: "group tpnode24 does not exist",
    });
  };
  await ensurePrincipalManagedGroups("appuser", new Set(["tpnode24"]), run);
  assertEquals(groupMutations(calls).length, 1);
});

test("ensureSystemPrincipals grants the runtimes its spec carries", async () => {
  const { run, calls } = captureRun({});
  await ensureSystemPrincipals(
    stubLayout(),
    [{
      principalId: "pr-1",
      username: "appuser",
      runtimes: [
        { runtime: "php", series: "8.4" },
        { runtime: "node", series: "24.17.0" },
      ],
    }],
    run,
  );
  const added = calls
    .filter((c) => c.args.includes("usermod") && c.args.includes("-aG"))
    .map((c) => c.args[3]);
  assertEquals(added.sort(), ["tpnode24", "tpphp84"]);
});

test("ensureSystemPrincipals grants the access group its spec carries", async () => {
  const { run, calls } = captureRun({});
  await ensureSystemPrincipals(
    stubLayout(),
    [{
      principalId: "pr-1",
      username: "appuser",
      shell: "/bin/bash",
      accessGroups: ["tpshell"],
      runtimes: [{ runtime: "php", series: "8.4" }],
    }],
    run,
  );
  const added = calls
    .filter((c) => c.args.includes("usermod") && c.args.includes("-aG"))
    .map((c) => c.args[3]);
  // Entitlements and access are one reconcile pass, so both land together.
  assertEquals(added.sort(), ["tpphp84", "tpshell"]);
});

test("downgrading from shell to files-only revokes the shell group", async () => {
  // The whole reason the containment set is a single one: an entitlement-only
  // pass would not recognize `tpshell` and would leave it behind.
  const { run, calls } = captureRun({ groups: ["appuser-grp", "tpshell"] });
  await ensureSystemPrincipals(
    stubLayout(),
    [{
      principalId: "pr-1",
      username: "appuser",
      accessGroups: ["tpsftp"],
    }],
    run,
  );
  const removed = calls
    .filter((c) => c.args.includes("gpasswd") && c.args.includes("-d"))
    .map((c) => c.args.at(-1));
  assertEquals(removed, ["tpshell"]);
});

test("a suspended account keeps its groups revoked and nothing else touched", async () => {
  const { run, calls } = captureRun({
    groups: ["appuser-grp", "tp", "tpsftp", "tpphp84"],
  });
  await ensureSystemPrincipals(
    stubLayout(),
    [{ principalId: "pr-1", username: "appuser", accessGroups: [] }],
    run,
  );
  const removed = calls
    .filter((c) => c.args.includes("gpasswd") && c.args.includes("-d"))
    .map((c) => c.args.at(-1));
  // `appuser-grp` and `tp` survive: they are outside the registry, so the
  // reconcile has no opinion about them no matter what the wire asks for.
  assertEquals(removed.sort(), ["tpphp84", "tpsftp"]);
});

test("an access group the registry does not define is dropped, not created", async () => {
  const { run, calls } = captureRun({});
  await ensureSystemPrincipals(
    stubLayout(),
    [{ principalId: "pr-1", username: "appuser", accessGroups: ["tproot"] }],
    run,
  );
  // Inventing the group would hand out an `sshd` Match block nobody wrote.
  assertEquals(
    calls.filter((c) => c.args.includes("usermod") && c.args.includes("-aG")),
    [],
  );
});

test("the principal home root is traverse-only, not listable", async () => {
  const { run, calls } = captureRun({});
  const layout = stubLayout();
  await ensureSystemPrincipals(
    layout,
    [{ principalId: "pr-1", username: "appuser" }],
    run,
  );
  const mkdir = calls.find((c) =>
    c.args.includes("install") && c.args.includes("-d") &&
    c.args.at(-1) === layout.principalHomeRoot
  );
  assert(mkdir);
  // 0755 would let any tenant with a shell `ls /srv/users` and enumerate every
  // other account on the box.
  assertEquals(mkdir.args[mkdir.args.indexOf("-m") + 1], "0751");
});
