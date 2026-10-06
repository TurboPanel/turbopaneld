import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import type { LayoutPaths } from "../paths/layout.ts";
import { accessGroup } from "../runtime/registry.ts";
import {
  assertIdOverridesInBand,
  DEFAULT_PRINCIPAL_SHELL,
  ensureDirectoryOwnedByPrincipal,
  ensureDirectoryWithOwner,
  ensureEngineGroupMembership,
  ensurePrincipalManagedGroups,
  ensurePrincipalPassword,
  ensureSupplementaryGroupMembership,
  ensureSystemPrincipals,
  parseGroupGid,
  parsePasswdHomeShell,
  type PrincipalEnsureSpec,
  principalUnixGroupName,
  resolveManagedGroups,
  type RunFn,
  type RunResult,
  userSupplementaryGroups,
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
  /** `sudo getent shadow` reply; defaults to a locked fresh account. */
  getentShadow?: RunResult;
  /** Supplementary groups `id -nG` reports for the account. */
  groups?: string[];
}): {
  run: RunFn;
  calls: Array<{ command: string; args: string[]; stdin?: string }>;
} {
  const calls: Array<{ command: string; args: string[]; stdin?: string }> = [];
  const run: RunFn = (command, args, stdin) => {
    calls.push({ command, args, ...(stdin === undefined ? {} : { stdin }) });
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
    if (
      command === "sudo" && args.includes("getent") && args.includes("shadow")
    ) {
      return Promise.resolve(
        handlers.getentShadow ??
          { success: true, stdout: "appuser:!:20000:0:99999:7:::", stderr: "" },
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
/** The passwd home: the tenant's `home/` inside the root-owned home. */
const loginHome = `${defaultHome}/home`;

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

  const groupadd = calls.find((c) =>
    c.command === "sudo" && c.args.includes("groupadd")
  );
  assertEquals(groupadd?.args, [
    "-n",
    "groupadd",
    "-K",
    "GID_MIN=15001",
    "-K",
    "GID_MAX=60000",
    "appuser-grp",
  ]);

  const useradd = calls.find((c) =>
    c.command === "sudo" && c.args.includes("useradd")
  );
  assertEquals(useradd?.args, [
    "-n",
    "useradd",
    "-K",
    "UID_MIN=15001",
    "-K",
    "UID_MAX=60000",
    "-g",
    "appuser-grp",
    "-d",
    loginHome,
    "-M",
    "-s",
    "/bin/bash",
    "appuser",
  ]);
  assertEquals(useradd?.args.includes("-u"), false);

  // The home is root's (the tenant could otherwise rename what root writes
  // into); the principal owns only home/, data/ and tmp/. Parent before child.
  const homeInstalls = calls
    .filter((c) =>
      c.command === "sudo" && c.args[1] === "install" &&
      c.args[c.args.length - 1].startsWith(defaultHome)
    )
    .map((c) => c.args.slice(4).join(" "));
  assertEquals(homeInstalls, [
    `0750 -o root -g appuser-grp ${defaultHome}`,
    `0700 -o appuser -g appuser-grp ${defaultHome}/home`,
    `0700 -o appuser -g appuser-grp ${defaultHome}/data`,
    `0700 -o appuser -g appuser-grp ${defaultHome}/tmp`,
    `0750 -o root -g appuser-grp ${defaultHome}/sites`,
    `0750 -o root -g appuser-grp ${defaultHome}/volumes`,
  ]);
  // The account is created before its tenant directories are chowned to it.
  const useraddAt = calls.findIndex((c) => c.args.includes("useradd"));
  const firstHomeAt = calls.findIndex((c) =>
    c.args[1] === "install" && c.args.includes(`${defaultHome}/home`)
  );
  assert(useraddAt < firstHomeAt);
});

test("ensureSystemPrincipals fresh create with explicit uid/gid passes -u and groupadd -g", async () => {
  const { run, calls } = captureRun({});
  await ensureSystemPrincipals(stubLayout(), [{
    ...baseSpec,
    uid: 15001,
    gid: 15001,
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
    "15001",
    "appuser-grp",
  ]);

  const useradd = calls.find((c) =>
    c.command === "sudo" && c.args.includes("useradd")
  );
  assertEquals(useradd?.args, [
    "-n",
    "useradd",
    "-u",
    "15001",
    "-g",
    "appuser-grp",
    "-d",
    loginHome,
    "-M",
    "-s",
    "/bin/bash",
    "appuser",
  ]);
});

test("ensureSystemPrincipals rejects an override below 15001 with no host calls", async () => {
  const uidRun = captureRun({});
  await assertRejects(
    () =>
      ensureSystemPrincipals(stubLayout(), [{
        ...baseSpec,
        uid: 10001,
        gid: 15001,
        home: defaultHome,
      }], uidRun.run),
    TypeError,
    "Principal uid override must be >= 15001",
  );
  assertEquals(uidRun.calls, []);

  const gidRun = captureRun({});
  await assertRejects(
    () =>
      ensureSystemPrincipals(stubLayout(), [{
        ...baseSpec,
        uid: 15001,
        gid: 10001,
        home: defaultHome,
      }], gidRun.run),
    TypeError,
    "Principal gid override must be >= 15001",
  );
  assertEquals(gidRun.calls, []);
});

test("ensureSystemPrincipals rejects a later override below 15001 before any host call", async () => {
  // A valid account followed by one below the floor must fail the whole
  // batch before the first host call. Checking inside the mutation loop
  // would create the first account and then throw.
  const { run, calls } = captureRun({});
  await assertRejects(
    () =>
      ensureSystemPrincipals(stubLayout(), [
        {
          ...baseSpec,
          uid: 15001,
          gid: 15001,
          home: defaultHome,
        },
        {
          principalId: "01936b3e-aaaa-bbbb-cccc-123456789abd",
          username: "otheruser",
          uid: 10001,
          gid: 15002,
          home: "/srv/users/otheruser",
        },
      ], run),
    TypeError,
    "Principal uid override must be >= 15001",
  );
  assertEquals(calls, []);
});

test("ensureSystemPrincipals adopts matching home and reconciles shell only", async () => {
  const { run, calls } = captureRun({
    getentGroup: { success: true, stdout: "appuser-grp:x:15001:", stderr: "" },
    getentPasswd: {
      success: true,
      stdout:
        "appuser:x:15001:15001::/srv/users/appuser/home:/usr/sbin/nologin",
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

test("ensureSystemPrincipals rejects an adopted group below the current UID/GID floor", async () => {
  const { run, calls } = captureRun({
    getentGroup: { success: true, stdout: "appuser-grp:x:10001:", stderr: "" },
  });
  await assertRejects(
    () =>
      ensureSystemPrincipals(stubLayout(), [{
        ...baseSpec,
        home: defaultHome,
      }], run),
    Error,
    "Principal group appuser-grp has gid=10001, below the current PRINCIPAL_ID_MIN=15001 — needs UID/GID migration",
  );
  assertEquals(
    calls.some((c) => c.command === "getent" && c.args[0] === "passwd"),
    false,
  );
  assertEquals(
    calls.some((c) =>
      c.command === "sudo" &&
      (c.args.includes("groupadd") || c.args.includes("useradd"))
    ),
    false,
  );
});

test("ensureSystemPrincipals rejects an adopted user below the current UID/GID floor", async () => {
  const { run, calls } = captureRun({
    getentGroup: { success: true, stdout: "appuser-grp:x:15001:", stderr: "" },
    getentPasswd: {
      success: true,
      stdout:
        "appuser:x:10001:15001::/srv/users/appuser/home:/usr/sbin/nologin",
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
    "Principal user appuser has uid=10001, below the current PRINCIPAL_ID_MIN=15001 — needs UID/GID migration",
  );
  assertEquals(
    calls.some((c) =>
      c.command === "sudo" &&
      (c.args.includes("useradd") || c.args.includes("usermod"))
    ),
    false,
  );
});

test("ensureSystemPrincipals refuses foreign home without usermod or install", async () => {
  const { run, calls } = captureRun({
    getentGroup: { success: true, stdout: "appuser-grp:x:15005:", stderr: "" },
    getentPasswd: {
      success: true,
      stdout: "appuser:x:15005:15005::/var/www:/usr/sbin/nologin",
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
    "refusing to adopt existing account `appuser` — home `/var/www` does not match `/srv/users/appuser/home`",
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
    getentGroup: { success: true, stdout: "appuser-grp:x:15001:", stderr: "" },
    getentPasswd: {
      success: true,
      stdout: "appuser:x:33:33::/srv/users/appuser/home:/usr/sbin/nologin",
      stderr: "",
    },
  });
  await assertRejects(
    () =>
      ensureSystemPrincipals(stubLayout(), [{
        ...baseSpec,
        uid: 15001,
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
    getentGroup: { success: true, stdout: "appuser-grp:x:15001:", stderr: "" },
  });
  await ensureSystemPrincipals(stubLayout(), [{
    ...baseSpec,
    gid: 15001,
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
    "-K",
    "UID_MIN=15001",
    "-K",
    "UID_MAX=60000",
    "-g",
    "appuser-grp",
    "-d",
    loginHome,
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
        gid: 15001,
        home: defaultHome,
        shell: "/bin/bash",
      }], run),
    Error,
    "Principal group appuser-grp already exists with gid=33; expected gid=15001",
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

test("ensureDirectoryOwnedByPrincipal goes through install -d, never mkdir + chown", async () => {
  // A writable parent: the daemon could mkdir here, and must not.
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
    assertEquals(calls, [{
      command: "sudo",
      args: [
        "-n",
        "install",
        "-d",
        "-m",
        "0750",
        "-o",
        "appuser",
        "-g",
        "appuser-grp",
        path,
      ],
    }]);
    await assertRejects(() => Deno.stat(path), Deno.errors.NotFound);
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
        gid: 15001,
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
      stdout: "appuser-grp:x:15001:",
      stderr: "",
    },
    getentPasswd: {
      success: true,
      stdout: "appuser:x:bad:bad::/srv/users/appuser/home:/bin/bash",
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
        stdout: "appuser-grp:x:15001:",
        stderr: "",
      });
    }
    if (command === "getent" && args[0] === "passwd") {
      return Promise.resolve({
        success: true,
        stdout: `appuser:x:15001:15001::${loginHome}:/bin/false`,
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

test("resolveManagedGroups grants the password group only alongside an SSH level", () => {
  const base = { username: "appuser" } as PrincipalEnsureSpec;
  const withGroups = (...accessGroups: string[]) =>
    resolveManagedGroups({ ...base, accessGroups });
  const password = accessGroup("password")!;
  const sftp = accessGroup("sftp")!;
  const shell = accessGroup("shell")!;
  assert(!withGroups(password).has(password));
  assert(withGroups(password, sftp).has(password));
  assert(withGroups(password, shell).has(password));
  assert(withGroups(sftp).has(sftp));
});

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
  // Revoke first, then grant.
  assertEquals(groupMutations(calls), [
    ["-n", "gpasswd", "-d", "appuser", "tpnode24"],
    ["-n", "usermod", "-aG", "tpphp84", "appuser"],
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
  assertEquals(added.sort(), ["tpnode24", "tpphp84", "tpprincipal"]);
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
  assertEquals(added.sort(), ["tpphp84", "tpprincipal", "tpshell"]);
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

test("switching access level revokes the old group before granting the new one", async () => {
  // Granting first would leave the account in tpsftp and tpshell at once,
  // and sshd would match whichever block comes first.
  const { run, calls } = captureRun({ groups: ["appuser-grp", "tpshell"] });
  await ensureSystemPrincipals(
    stubLayout(),
    [{ principalId: "pr-1", username: "appuser", accessGroups: ["tpsftp"] }],
    run,
  );
  const membership = calls
    .filter((c) => c.args.includes("gpasswd") || c.args.includes("-aG"))
    .map((c) => c.args.slice(-2).join(" "));
  assertEquals(membership, [
    "appuser tpshell",
    "tpprincipal appuser",
    "tpsftp appuser",
  ]);
});

test("ensureSystemPrincipals refuses sftp and shell together before any host call", async () => {
  // One access level per principal: sshd applies the first matching block,
  // so an account in both would be jailed with no shell.
  const { run, calls } = captureRun({});
  await assertRejects(
    () =>
      ensureSystemPrincipals(stubLayout(), [
        { ...baseSpec, accessGroups: ["tpsftp"] },
        {
          principalId: "pr-2",
          username: "otheruser",
          accessGroups: ["tpshell", "tpsftp"],
        },
      ], run),
    TypeError,
    "otheruser: SSH access groups tpsftp and tpshell are exclusive",
  );
  assertEquals(calls, []);
});

test("the password group still rides along with one access level", async () => {
  const { run, calls } = captureRun({});
  await ensureSystemPrincipals(
    stubLayout(),
    [{ ...baseSpec, accessGroups: ["tpshell", "tppasswd"] }],
    run,
  );
  const added = calls
    .filter((c) => c.args.includes("-aG"))
    .map((c) => c.args.at(-2));
  assertEquals(added, ["tppasswd", "tpprincipal", "tpshell"]);
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
    calls
      .filter((c) => c.args.includes("usermod") && c.args.includes("-aG"))
      .map((c) => c.args[3]),
    ["tpprincipal"],
  );
});

test("every principal joins the every-principal group, even with no SSH level", async () => {
  // A site owner with no access level matched no sshd block, so a key it put
  // in its own ~/.ssh/authorized_keys authenticated and TCP forwarding reached
  // the host's loopback. tpprincipal selects the drop-in's backstop block.
  const { run, calls } = captureRun({});
  await ensureSystemPrincipals(
    stubLayout(),
    [{ principalId: "pr-1", username: "appuser", accessGroups: [] }],
    run,
  );
  assertEquals(
    calls
      .filter((c) => c.args.includes("usermod") && c.args.includes("-aG"))
      .map((c) => c.args[3]),
    ["tpprincipal"],
  );
});

test("a principal that cannot join the every-principal group fails the reconcile", async () => {
  // Best-effort is right for a runtime group, wrong here: a silent miss leaves
  // the account on the host's sshd defaults.
  const { run: base } = captureRun({});
  const run: RunFn = (command, args, stdin) =>
    args.includes("-aG") && args.includes("tpprincipal")
      ? Promise.resolve({
        success: false,
        stdout: "",
        stderr: "usermod: group 'tpprincipal' does not exist",
      })
      : base(command, args, stdin);
  await assertRejects(
    () =>
      ensureSystemPrincipals(
        stubLayout(),
        [{ principalId: "pr-1", username: "appuser" }],
        run,
      ),
    Error,
    "tpprincipal",
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
  // other account on the box. 0751 is the same contract but a world bit that
  // trips ansible:S2612 — traverse is an other:x ACL instead.
  assertEquals(mkdir.args[mkdir.args.indexOf("-m") + 1], "0750");
  const acl = calls.find((c) =>
    c.args.includes("setfacl") && c.args.at(-1) === layout.principalHomeRoot
  );
  assert(acl);
  assertEquals(acl.args.includes("o::x"), true);
});

test("a failed home-root traverse ACL fails the principal ensure", async () => {
  const layout = stubLayout();
  const { run } = captureRun({});
  const failing: RunFn = (command, args) => {
    if (args.includes("setfacl")) {
      return Promise.resolve({
        success: false,
        stdout: "",
        stderr: "",
      });
    }
    return run(command, args);
  };
  await assertRejects(
    () =>
      ensureSystemPrincipals(
        layout,
        [{ principalId: "pr-1", username: "appuser" }],
        failing,
      ),
    Error,
    "Failed to grant traverse ACL",
  );
});

// --- Password reconcile ------------------------------------------------------

const VALID_HASH = `$6$saltstring$${"a".repeat(86)}`;
const OTHER_HASH = `$6$saltstring$${"b".repeat(86)}`;

function shadowEntry(field: string): RunResult {
  return {
    success: true,
    stdout: `appuser:${field}:20000:0:99999:7:::`,
    stderr: "",
  };
}

test("ensurePrincipalPassword sets a differing hash over stdin, never argv", async () => {
  const { run, calls } = captureRun({ getentShadow: shadowEntry("!") });
  await ensurePrincipalPassword("appuser", VALID_HASH, run);

  const chpasswd = calls.find((c) =>
    c.command === "sudo" && c.args.includes("chpasswd")
  );
  assertEquals(chpasswd?.args, ["-n", "chpasswd", "-e"]);
  // The hash reaches the tool via stdin only: an argv is world-readable via
  // `ps` for the life of the process.
  assertEquals(chpasswd?.stdin, `appuser:${VALID_HASH}\n`);
  assert(
    calls.every((c) => !c.args.includes(VALID_HASH)),
    "the hash must never appear in argv",
  );
});

test("ensurePrincipalPassword skips the write when the hash already matches", async () => {
  const { run, calls } = captureRun({ getentShadow: shadowEntry(VALID_HASH) });
  await ensurePrincipalPassword("appuser", VALID_HASH, run);
  assertEquals(
    calls.some((c) => c.args.includes("chpasswd")),
    false,
  );
});

test("ensurePrincipalPassword replaces a stale hash", async () => {
  const { run, calls } = captureRun({ getentShadow: shadowEntry(OTHER_HASH) });
  await ensurePrincipalPassword("appuser", VALID_HASH, run);
  const chpasswd = calls.find((c) => c.args.includes("chpasswd"));
  assertEquals(chpasswd?.stdin, `appuser:${VALID_HASH}\n`);
});

test("ensurePrincipalPassword locks a live password when no hash is desired", async () => {
  const { run, calls } = captureRun({ getentShadow: shadowEntry(OTHER_HASH) });
  await ensurePrincipalPassword("appuser", undefined, run);
  const lock = calls.find((c) =>
    c.command === "sudo" && c.args.includes("usermod")
  );
  assertEquals(lock?.args, ["-n", "usermod", "-p", "!", "appuser"]);
});

test("ensurePrincipalPassword leaves an already-locked account alone", async () => {
  for (const field of ["!", "*", `!${OTHER_HASH}`]) {
    const { run, calls } = captureRun({ getentShadow: shadowEntry(field) });
    await ensurePrincipalPassword("appuser", undefined, run);
    assertEquals(
      calls.some((c) => c.args.includes("usermod")),
      false,
      `field ${field} is already locked`,
    );
  }
});

test("ensurePrincipalPassword locks fail-closed when shadow cannot be read", async () => {
  const { run, calls } = captureRun({
    getentShadow: { success: false, stdout: "", stderr: "denied" },
  });
  await ensurePrincipalPassword("appuser", undefined, run);
  const lock = calls.find((c) => c.args.includes("usermod"));
  assertEquals(lock?.args, ["-n", "usermod", "-p", "!", "appuser"]);
});

test("ensurePrincipalPassword refuses anything that is not a sha512-crypt hash", async () => {
  const rejected = [
    "hunter2",
    "$1$old$md5hash",
    `$6$saltstring$${"a".repeat(85)}`,
    `$6$saltstring$${"a".repeat(86)}:extra`,
    `$6$bad salt$${"a".repeat(86)}`,
    `$6$saltstring$${"a".repeat(86)}\nroot:x`,
  ];
  for (const hash of rejected) {
    const { run, calls } = captureRun({ getentShadow: shadowEntry("!") });
    await assertRejects(
      () => ensurePrincipalPassword("appuser", hash, run),
      TypeError,
      "Invalid principal password hash",
    );
    assertEquals(calls.some((c) => c.args.includes("chpasswd")), false);
  }
});

test("ensurePrincipalPassword accepts an explicit rounds parameter", async () => {
  const withRounds = `$6$rounds=100000$saltstring$${"a".repeat(86)}`;
  const { run, calls } = captureRun({ getentShadow: shadowEntry("!") });
  await ensurePrincipalPassword("appuser", withRounds, run);
  const chpasswd = calls.find((c) => c.args.includes("chpasswd"));
  assertEquals(chpasswd?.stdin, `appuser:${withRounds}\n`);
});

test("a failed password set is loud", async () => {
  const { run } = captureRun({ getentShadow: shadowEntry("!") });
  const failing: RunFn = (command, args, stdin) => {
    if (args.includes("chpasswd")) {
      return Promise.resolve({
        success: false,
        stdout: "",
        stderr: "chpasswd denied",
      });
    }
    return run(command, args, stdin);
  };
  await assertRejects(
    () => ensurePrincipalPassword("appuser", VALID_HASH, failing),
    Error,
    "chpasswd denied",
  );
});

test("a failed password lock is loud", async () => {
  const { run } = captureRun({ getentShadow: shadowEntry(OTHER_HASH) });
  const failing: RunFn = (command, args, stdin) => {
    if (args.includes("usermod")) {
      return Promise.resolve({
        success: false,
        stdout: "",
        stderr: "usermod denied",
      });
    }
    return run(command, args, stdin);
  };
  // A password that silently outlives its revocation is a security problem.
  await assertRejects(
    () => ensurePrincipalPassword("appuser", undefined, failing),
    Error,
    "usermod denied",
  );
});

test("ensureSystemPrincipals applies the spec's password hash", async () => {
  const { run, calls } = captureRun({ getentShadow: shadowEntry("!") });
  await ensureSystemPrincipals(stubLayout(), [{
    ...baseSpec,
    home: defaultHome,
    shell: "/bin/bash",
    passwordHash: VALID_HASH,
  }], run);
  const chpasswd = calls.find((c) => c.args.includes("chpasswd"));
  assertEquals(chpasswd?.stdin, `appuser:${VALID_HASH}\n`);
});

test("ensureSystemPrincipals locks the password when the spec carries none", async () => {
  const { run, calls } = captureRun({ getentShadow: shadowEntry(OTHER_HASH) });
  await ensureSystemPrincipals(stubLayout(), [{
    ...baseSpec,
    home: defaultHome,
    shell: "/bin/bash",
  }], run);
  const lock = calls.find((c) =>
    c.args.includes("usermod") && c.args.includes("-p")
  );
  assertEquals(lock?.args, ["-n", "usermod", "-p", "!", "appuser"]);
});

test("ensureSystemPrincipals rejects a shell outside the allowlist", async () => {
  const { run } = captureRun({});
  await assertRejects(
    () =>
      ensureSystemPrincipals(stubLayout(), [{
        ...baseSpec,
        home: defaultHome,
        shell: "/bin/zsh",
      }], run),
    TypeError,
    "Principal shell is not allowed",
  );
});

test("ensureSystemPrincipals drops an unknown runtime instead of failing", async () => {
  const { run, calls } = captureRun({});
  await ensureSystemPrincipals(stubLayout(), [{
    ...baseSpec,
    home: defaultHome,
    runtimes: [{ runtime: "python", series: "3.12" }],
  }], run);
  assertEquals(
    calls
      .filter((c) => c.args.includes("usermod") && c.args.includes("-aG"))
      .map((c) => c.args[3]),
    ["tpprincipal"],
  );
});

test("ensureSystemPrincipals rejects existing username with mismatched gid override", async () => {
  const { run } = captureRun({
    getentGroup: { success: true, stdout: "appuser-grp:x:15001:", stderr: "" },
    getentPasswd: {
      success: true,
      stdout: `appuser:x:15001:33::${loginHome}:/usr/sbin/nologin`,
      stderr: "",
    },
  });
  await assertRejects(
    () =>
      ensureSystemPrincipals(stubLayout(), [{
        ...baseSpec,
        uid: 15001,
        gid: 15001,
        home: defaultHome,
      }], run),
    Error,
    "already exists with uid=15001 gid=33",
  );
});

test("ensureSystemPrincipals skips usermod when the adopted shell already matches", async () => {
  const { run, calls } = captureRun({
    getentGroup: { success: true, stdout: "appuser-grp:x:15001:", stderr: "" },
    getentPasswd: {
      success: true,
      stdout: `appuser:x:15001:15001::${loginHome}:/bin/bash`,
      stderr: "",
    },
  });
  await ensureSystemPrincipals(stubLayout(), [{
    ...baseSpec,
    home: defaultHome,
    shell: "/bin/bash",
  }], run);
  assertEquals(
    calls.some((c) =>
      c.command === "sudo" && c.args.includes("usermod") &&
      c.args.includes("-s")
    ),
    false,
  );
});

test("ensureSystemPrincipals uses generic errors when sudo stderr is empty", async () => {
  const failingInstall: RunFn = (command, args) => {
    if (command === "sudo" && args.includes("install")) {
      return Promise.resolve({ success: false, stdout: "", stderr: "" });
    }
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  await assertRejects(
    () =>
      ensureSystemPrincipals(stubLayout(), [{
        ...baseSpec,
        home: defaultHome,
      }], failingInstall),
    Error,
    "Failed to create directory",
  );

  const failingGroupadd: RunFn = (command, args) => {
    if (command === "getent") {
      return Promise.resolve({ success: false, stdout: "", stderr: "" });
    }
    if (command === "sudo" && args.includes("groupadd")) {
      return Promise.resolve({ success: false, stdout: "", stderr: "" });
    }
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  await assertRejects(
    () =>
      ensureSystemPrincipals(stubLayout(), [{
        ...baseSpec,
        home: defaultHome,
      }], failingGroupadd),
    Error,
    "Failed to create principal group",
  );

  const failingUseradd: RunFn = (command, args) => {
    if (command === "getent" && args[0] === "group") {
      return Promise.resolve({ success: false, stdout: "", stderr: "" });
    }
    if (command === "getent" && args[0] === "passwd") {
      return Promise.resolve({ success: false, stdout: "", stderr: "" });
    }
    if (command === "sudo" && args.includes("useradd")) {
      return Promise.resolve({ success: false, stdout: "", stderr: "" });
    }
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  await assertRejects(
    () =>
      ensureSystemPrincipals(stubLayout(), [{
        ...baseSpec,
        home: defaultHome,
      }], failingUseradd),
    Error,
    "Failed to create principal user",
  );

  const failingUsermod: RunFn = (command, args) => {
    if (command === "getent" && args[0] === "group") {
      return Promise.resolve({
        success: true,
        stdout: "appuser-grp:x:15001:",
        stderr: "",
      });
    }
    if (command === "getent" && args[0] === "passwd") {
      return Promise.resolve({
        success: true,
        stdout: `appuser:x:15001:15001::${loginHome}:/bin/false`,
        stderr: "",
      });
    }
    if (command === "sudo" && args.includes("usermod") && args.includes("-s")) {
      return Promise.resolve({ success: false, stdout: "", stderr: "" });
    }
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  await assertRejects(
    () =>
      ensureSystemPrincipals(stubLayout(), [{
        ...baseSpec,
        home: defaultHome,
        shell: "/bin/bash",
      }], failingUsermod),
    Error,
    "Failed to update principal shell",
  );
});

test("ensureDirectoryWithOwner treats a bare owner as both user and group", async () => {
  const calls: string[][] = [];
  await ensureDirectoryWithOwner(
    "/srv/users",
    "0750",
    "root",
    (command, args) => {
      calls.push([command, ...args]);
      return Promise.resolve({ success: true, stdout: "", stderr: "" });
    },
  );
  assertEquals(calls[0], [
    "sudo",
    "-n",
    "install",
    "-d",
    "-m",
    "0750",
    "-o",
    "root",
    "-g",
    "root",
    "/srv/users",
  ]);
});

test("userSupplementaryGroups returns empty when id fails", async () => {
  const groups = await userSupplementaryGroups(
    "appuser",
    () => Promise.resolve({ success: false, stdout: "denied", stderr: "nope" }),
  );
  assertEquals([...groups], []);
});

test("ensureSystemPrincipals finishes one principal before starting the next, one host call at a time", async () => {
  const { run: inner, calls } = captureRun({});
  let inFlight = 0;
  let maxInFlight = 0;
  const run: RunFn = async (command, args, stdin) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    const result = await inner(command, args, stdin);
    inFlight--;
    return result;
  };
  await ensureSystemPrincipals(stubLayout(), [
    { ...baseSpec, username: "alice", home: "/srv/users/alice" },
    { ...baseSpec, username: "bob", home: "/srv/users/bob" },
  ], run);
  assertEquals(maxInFlight, 1);
  const creations = calls
    .filter((c) => c.args.includes("groupadd") || c.args.includes("useradd"))
    .map((c) =>
      `${c.args.includes("groupadd") ? "group" : "user"} ${c.args.at(-1)}`
    );
  assertEquals(creations, [
    "group alice-grp",
    "user alice",
    "group bob-grp",
    "user bob",
  ]);
});

test("ensureSystemPrincipals stops at the first principal that fails and never starts the next", async () => {
  const { run: inner, calls } = captureRun({});
  const run: RunFn = (command, args, stdin) => {
    if (args.includes("useradd")) {
      return Promise.resolve({ success: false, stdout: "", stderr: "denied" });
    }
    return inner(command, args, stdin);
  };
  await assertRejects(
    () =>
      ensureSystemPrincipals(stubLayout(), [
        { ...baseSpec, username: "alice", home: "/srv/users/alice" },
        { ...baseSpec, username: "bob", home: "/srv/users/bob" },
      ], run),
    Error,
  );
  assertEquals(calls.some((c) => c.args.includes("bob-grp")), false);
  assertEquals(calls.some((c) => c.args.includes("bob")), false);
});

test("ensurePrincipalManagedGroups adds in sorted order and keeps going after a failed add", async () => {
  const calls: string[][] = [];
  const run: RunFn = (command, args) => {
    if (command === "id") {
      return Promise.resolve({
        success: true,
        stdout: "appuser-grp",
        stderr: "",
      });
    }
    calls.push(args);
    return Promise.resolve(
      args.includes("tpnode24")
        ? { success: false, stdout: "", stderr: "no such group" }
        : { success: true, stdout: "", stderr: "" },
    );
  };
  const warnings = await ensurePrincipalManagedGroups(
    "appuser",
    new Set(["tpphp84", "tpnode24", "tpnode22"]),
    run,
  );
  assertEquals(calls.map((a) => a.at(-2)), ["tpnode22", "tpnode24", "tpphp84"]);
  // The failed add is reported, not swallowed (a runtime not installed here).
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], "could not add appuser to tpnode24");
  assertStringIncludes(warnings[0], "no such group");
});

test("ensurePrincipalManagedGroups revokes in sorted order and stops at the first failed revoke", async () => {
  const revoked: string[] = [];
  const run: RunFn = (command, args) => {
    if (command === "id") {
      return Promise.resolve({
        success: true,
        stdout: "appuser-grp tpphp84 tpnode22 tpnode24",
        stderr: "",
      });
    }
    revoked.push(args.at(-1) ?? "");
    return Promise.resolve(
      args.at(-1) === "tpnode24"
        ? { success: false, stdout: "", stderr: "gpasswd denied" }
        : { success: true, stdout: "", stderr: "" },
    );
  };
  await assertRejects(
    () => ensurePrincipalManagedGroups("appuser", new Set(), run),
    Error,
    "gpasswd denied",
  );
  assertEquals(revoked, ["tpnode22", "tpnode24"]);
});

test("ensurePrincipalManagedGroups is loud when a revoke fails", async () => {
  const run: RunFn = (command, args) => {
    if (command === "id") {
      return Promise.resolve({
        success: true,
        stdout: "appuser-grp tpnode24",
        stderr: "",
      });
    }
    if (args.includes("gpasswd")) {
      return Promise.resolve({
        success: false,
        stdout: "",
        stderr: "gpasswd denied",
      });
    }
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  await assertRejects(
    () => ensurePrincipalManagedGroups("appuser", new Set(), run),
    Error,
    "gpasswd denied",
  );
});

test("ensurePrincipalManagedGroups uses a generic revoke error when stderr is empty", async () => {
  const run: RunFn = (command, args) => {
    if (command === "id") {
      return Promise.resolve({
        success: true,
        stdout: "tpphp84",
        stderr: "",
      });
    }
    if (args.includes("gpasswd")) {
      return Promise.resolve({ success: false, stdout: "", stderr: "" });
    }
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  await assertRejects(
    () => ensurePrincipalManagedGroups("appuser", new Set(), run),
    Error,
    "Failed to remove appuser from group tpphp84",
  );
});

test("ensureSupplementaryGroupMembership surfaces empty-stderr failures", async () => {
  await assertRejects(
    () =>
      ensureSupplementaryGroupMembership(
        "appuser",
        "tpnode24",
        () => Promise.resolve({ success: false, stdout: "", stderr: "" }),
      ),
    Error,
    "Failed to add appuser to group tpnode24",
  );
});

test("ensureEngineGroupMembership adds the engine account to the principal group", async () => {
  const calls: string[][] = [];
  await ensureEngineGroupMembership(
    "tpnginx",
    "appuser-grp",
    (command, args) => {
      calls.push([command, ...args]);
      return Promise.resolve({ success: true, stdout: "", stderr: "" });
    },
  );
  assertEquals(calls[0], [
    "sudo",
    "-n",
    "usermod",
    "-aG",
    "appuser-grp",
    "tpnginx",
  ]);
});

test("ensurePrincipalPassword locks when shadow has no password field", async () => {
  const { run, calls } = captureRun({
    getentShadow: { success: true, stdout: "appuser", stderr: "" },
  });
  await ensurePrincipalPassword("appuser", undefined, run);
  assertEquals(
    calls.some((c) => c.args.includes("usermod") && c.args.includes("-p")),
    true,
  );
});

test("ensurePrincipalPassword uses generic errors when sudo stderr is empty", async () => {
  const failingSet: RunFn = (command, args, stdin) => {
    if (args.includes("chpasswd")) {
      return Promise.resolve({ success: false, stdout: "", stderr: "" });
    }
    return captureRun({ getentShadow: shadowEntry("!") }).run(
      command,
      args,
      stdin,
    );
  };
  await assertRejects(
    () => ensurePrincipalPassword("appuser", VALID_HASH, failingSet),
    Error,
    "Failed to set password for appuser",
  );

  const failingLock: RunFn = (command, args, stdin) => {
    if (args.includes("usermod") && args.includes("-p")) {
      return Promise.resolve({ success: false, stdout: "", stderr: "" });
    }
    return captureRun({ getentShadow: shadowEntry(OTHER_HASH) }).run(
      command,
      args,
      stdin,
    );
  };
  await assertRejects(
    () => ensurePrincipalPassword("appuser", undefined, failingLock),
    Error,
    "Failed to lock password for appuser",
  );
});

test("ensureDirectoryWithOwner default runner pipes stdin and reports output", async () => {
  const original = Deno.Command;
  let wroteStdin = "";
  Deno.Command = class {
    constructor(
      _command: string,
      opts: { stdin?: "null" | "piped" },
    ) {
      this.stdinMode = opts.stdin ?? "null";
    }
    stdinMode: "null" | "piped";
    spawn() {
      return {
        stdin: {
          getWriter: () => ({
            write: (chunk: Uint8Array) => {
              wroteStdin += new TextDecoder().decode(chunk);
              return Promise.resolve();
            },
            close: () => Promise.resolve(),
          }),
        },
        output: () =>
          Promise.resolve({
            success: true,
            stdout: new TextEncoder().encode("ok\n"),
            stderr: new TextEncoder().encode(""),
          }),
      };
    }
  } as unknown as typeof Deno.Command;
  try {
    await ensureDirectoryWithOwner("/tmp/tp-owner", "0750", "root:root");
    await ensurePrincipalPassword("appuser", VALID_HASH);
    assertEquals(wroteStdin.includes(`appuser:${VALID_HASH}`), true);
  } finally {
    Deno.Command = original;
  }
});

// Adopted-account rules run in a fixed order (ids, floor, home, shell) and each
// refusal leaves the host untouched. One row per way the rules can overlap.
const ADOPTED_USER_CASES: Array<{
  label: string;
  passwd: string;
  spec: Partial<PrincipalEnsureSpec>;
  group: string;
  error: string;
}> = [
  {
    label: "uid override mismatch wins over a foreign home",
    passwd: "appuser:x:15002:15001::/srv/users/other:/usr/sbin/nologin",
    spec: { uid: 15001 },
    group: "appuser-grp:x:15001:",
    error:
      "Principal username appuser already exists with uid=15002 gid=15001; expected uid=15001 gid=undefined",
  },
  {
    label: "gid override mismatch alone",
    passwd: "appuser:x:15001:15009::/srv/users/appuser/home:/usr/sbin/nologin",
    spec: { gid: 15001 },
    group: "appuser-grp:x:15001:",
    error:
      "Principal username appuser already exists with uid=15001 gid=15009; expected uid=undefined gid=15001",
  },
  {
    label: "both overrides mismatched",
    passwd: "appuser:x:15002:15003::/srv/users/appuser/home:/usr/sbin/nologin",
    spec: { uid: 15001, gid: 15001 },
    group: "appuser-grp:x:15001:",
    error:
      "already exists with uid=15002 gid=15003; expected uid=15001 gid=15001",
  },
  {
    label: "uid below the floor wins over a foreign home",
    passwd: "appuser:x:10001:15001::/srv/users/other:/usr/sbin/nologin",
    spec: {},
    group: "appuser-grp:x:15001:",
    error:
      "Principal user appuser has uid=10001, below the current PRINCIPAL_ID_MIN=15001",
  },
  {
    label: "foreign home is refused even when the shell differs",
    passwd: "appuser:x:15001:15001::/srv/users/other:/bin/bash",
    spec: {},
    group: "appuser-grp:x:15001:",
    error:
      "refusing to adopt existing account `appuser` — home `/srv/users/other` does not match `/srv/users/appuser/home`",
  },
];

for (const c of ADOPTED_USER_CASES) {
  test(`ensureSystemPrincipals adopted user: ${c.label}`, async () => {
    const { run, calls } = captureRun({
      getentGroup: { success: true, stdout: c.group, stderr: "" },
      getentPasswd: { success: true, stdout: c.passwd, stderr: "" },
    });
    await assertRejects(
      () =>
        ensureSystemPrincipals(stubLayout(), [{
          ...baseSpec,
          ...c.spec,
          home: defaultHome,
        }], run),
      Error,
      c.error,
    );
    assertEquals(
      calls.some((call) =>
        call.command === "sudo" &&
        (call.args.includes("useradd") || call.args.includes("usermod"))
      ),
      false,
    );
  });
}

test("ensureSystemPrincipals adopts an account below the floor when its uid is an explicit override", async () => {
  // With an explicit uid the floor rule does not apply; ensureSystemPrincipals
  // separately refuses overrides below the floor, so use one at the floor.
  const { run, calls } = captureRun({
    getentGroup: { success: true, stdout: "appuser-grp:x:15001:", stderr: "" },
    getentPasswd: {
      success: true,
      stdout: `appuser:x:15001:15001::${loginHome}:/bin/bash`,
      stderr: "",
    },
  });
  await ensureSystemPrincipals(stubLayout(), [{
    ...baseSpec,
    uid: 15001,
    gid: 15001,
    home: defaultHome,
    shell: "/bin/bash",
  }], run);
  // Supplementary-group joins (`usermod -aG`) are membership, not a change to
  // the adopted account itself.
  assertEquals(
    calls.some((call) =>
      call.command === "sudo" &&
      (call.args.includes("useradd") ||
        (call.args.includes("usermod") && !call.args.includes("-aG")))
    ),
    false,
  );
});

test("ensureSystemPrincipals fails when useradd lands below the uid floor (Debian 13 behaviour)", async () => {
  const base = captureRun({}).run;
  let created = false;
  const run: RunFn = (command, args, stdin) => {
    if (command === "sudo" && args.includes("useradd")) created = true;
    if (command === "getent" && args[0] === "passwd" && created) {
      return Promise.resolve({
        success: true,
        stdout: "appuser:x:10000:15002::/srv/users/appuser/home:/bin/bash",
        stderr: "",
      });
    }
    return base(command, args, stdin);
  };
  const err = await assertRejects(
    () =>
      ensureSystemPrincipals(stubLayout(), [{
        ...baseSpec,
        home: defaultHome,
        shell: "/bin/bash",
      }], run),
    Error,
    "uid=10000",
  );
  assert(err.message.includes("usermod -u"));
});

test("a uid/gid override must sit in the principal band, never in systemd's throwaway build range", () => {
  const spec = (uid?: number, gid?: number): PrincipalEnsureSpec =>
    ({ principalId: "p", username: "carol", uid, gid }) as PrincipalEnsureSpec;
  assertIdOverridesInBand(spec());
  assertIdOverridesInBand(spec(15001, 60000));
  for (const [uid, gid] of [[61500, 15001], [15001, 65519], [15000, 15001]]) {
    assertThrows(
      () => assertIdOverridesInBand(spec(uid, gid)),
      RangeError,
      "outside 15001–60000",
    );
  }
});
