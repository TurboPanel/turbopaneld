import { assertEquals } from "@std/assert";
import type { LayoutPaths } from "../paths/layout.ts";
import type { PrincipalEnsureSpec } from "../deploy/ensure-principal.ts";
import type {
  PrincipalSshSpec,
  SshApplyPaths,
  SshApplyResult,
} from "../deploy/ssh/apply.ts";
import {
  EMPTY_SET_KEPT_WARNING,
  FOLDER_LIST_UNAVAILABLE_WARNING,
  handlePrincipalsReconcile,
} from "./principals-reconcile.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const LAYOUT = { principalHomeRoot: "/srv/users" } as LayoutPaths;

test("handlePrincipalsReconcile maps optional fields and defaults ssh keys", async () => {
  const ensured: PrincipalEnsureSpec[][] = [];
  const sshCalls: {
    principals: readonly PrincipalSshSpec[];
    paths?: SshApplyPaths;
  }[] = [];
  const ssh: SshApplyResult = {
    changedPrincipals: ["alice"],
    removedPrincipals: ["bob"],
    sshdReloaded: true,
    sftpChroot: true,
    warnings: ["AllowUsers is set"],
  };

  const result = await handlePrincipalsReconcile(
    {
      principals: [
        {
          principalId: "p1",
          username: "alice",
          uid: 2001,
          gid: 2001,
          home: "/srv/users/alice",
          shell: "/bin/bash",
          accessGroups: ["tpshell"],
          sshKeys: ["ssh-ed25519 AAAA"],
          passwordHash: `$6$saltstring$${"a".repeat(86)}`,
        },
        {
          principalId: "p2",
          username: "carol",
        },
      ],
    },
    new Date().toISOString(),
    {
      resolveLayout: () => LAYOUT,
      ensureSystemPrincipals: (_layout, principals) => {
        ensured.push(principals);
        return Promise.resolve();
      },
      reportPrincipalIds: () => Promise.resolve([]),
      listAssetFolders: () => Promise.resolve([]),
      applySshAccess: (principals, paths) => {
        sshCalls.push({ principals, paths });
        return Promise.resolve(ssh);
      },
    },
  );

  if (ensured[0] === undefined || sshCalls[0] === undefined) {
    throw new TypeError("expected ensure and ssh apply to be called");
  }
  assertEquals(ensured[0][0], {
    principalId: "p1",
    username: "alice",
    uid: 2001,
    gid: 2001,
    home: "/srv/users/alice",
    shell: "/bin/bash",
    accessGroups: ["tpshell"],
    passwordHash: `$6$saltstring$${"a".repeat(86)}`,
  });
  // No passwordHash on carol: `ensureSystemPrincipals` reads that as "locked",
  // which is the state her account was created in.
  assertEquals(ensured[0][1], {
    principalId: "p2",
    username: "carol",
  });
  assertEquals(sshCalls[0].principals, [
    { username: "alice", keys: ["ssh-ed25519 AAAA"] },
    { username: "carol", keys: [] },
  ]);
  assertEquals(sshCalls[0].paths, { prune: true });
  assertEquals(result, {
    principalsApplied: 2,
    keysChanged: ["alice"],
    keysRemoved: ["bob"],
    sshdReloaded: true,
    sftpChroot: true,
    folders: [],
    warnings: ["AllowUsers is set"],
  });
});

test("handlePrincipalsReconcile treats empty sshKeys as none and empty payload as zero", async () => {
  let sshPrincipals: readonly PrincipalSshSpec[] = [];
  const result = await handlePrincipalsReconcile(
    {
      principals: [
        { principalId: "p3", username: "dave", sshKeys: [] },
      ],
    },
    "2026-01-01T00:00:00.000Z",
    {
      resolveLayout: () => LAYOUT,
      listAssetFolders: () => Promise.resolve([]),
      ensureSystemPrincipals: () => Promise.resolve(),
      applySshAccess: (principals) => {
        sshPrincipals = principals;
        return Promise.resolve({
          changedPrincipals: [],
          removedPrincipals: [],
          sshdReloaded: false,
          sftpChroot: false,
          warnings: [],
        });
      },
    },
  );
  assertEquals(sshPrincipals, [{ username: "dave", keys: [] }]);
  assertEquals(result.principalsApplied, 1);
  assertEquals(result.keysChanged, []);
  assertEquals(result.keysRemoved, []);
  assertEquals(result.sshdReloaded, false);
});

test("handlePrincipalsReconcile reports a failed runtime group grant as a warning", async () => {
  const result = await handlePrincipalsReconcile(
    { principals: [{ principalId: "p4", username: "erin", sshKeys: [] }] },
    "2026-01-01T00:00:00.000Z",
    {
      resolveLayout: () => LAYOUT,
      listAssetFolders: () => Promise.resolve([]),
      ensureSystemPrincipals: () =>
        Promise.resolve(["could not add erin to tpsftp: no such group"]),
      applySshAccess: () =>
        Promise.resolve({
          changedPrincipals: [],
          removedPrincipals: [],
          sshdReloaded: false,
          sftpChroot: false,
          warnings: ["AllowUsers is set"],
        }),
    },
  );
  assertEquals(result.warnings, [
    "could not add erin to tpsftp: no such group",
    "AllowUsers is set",
  ]);
});

const NO_CHANGE: SshApplyResult = {
  changedPrincipals: [],
  removedPrincipals: [],
  sshdReloaded: false,
  sftpChroot: false,
  warnings: [],
};

test("handlePrincipalsReconcile keeps key files on an empty set unless allowEmpty is set", async () => {
  const prunes: Array<boolean | undefined> = [];
  const deps = {
    resolveLayout: () => LAYOUT,
    listAssetFolders: () => Promise.resolve([]),
    ensureSystemPrincipals: () => Promise.resolve(),
    applySshAccess: (
      _principals: readonly PrincipalSshSpec[],
      paths?: SshApplyPaths,
    ) => {
      prunes.push(paths?.prune);
      return Promise.resolve(NO_CHANGE);
    },
  };
  const kept = await handlePrincipalsReconcile(
    { principals: [] },
    "2026-01-01T00:00:00.000Z",
    deps,
  );
  assertEquals(kept.warnings, [EMPTY_SET_KEPT_WARNING]);
  assertEquals(kept.principalsRetired, undefined);

  const pruned = await handlePrincipalsReconcile(
    { principals: [], allowEmpty: true },
    "2026-01-01T00:00:00.000Z",
    deps,
  );
  assertEquals(pruned.warnings, []);
  assertEquals(prunes, [false, true]);
});

test("handlePrincipalsReconcile retires named accounts after the set is applied", async () => {
  const order: string[] = [];
  const result = await handlePrincipalsReconcile(
    {
      principals: [{ principalId: "p5", username: "frank" }],
      retirePrincipals: [{ username: "gone" }, { username: "busy" }],
    },
    "2026-01-01T00:00:00.000Z",
    {
      resolveLayout: () => LAYOUT,
      listAssetFolders: () => Promise.resolve([]),
      ensureSystemPrincipals: () => {
        order.push("ensure");
        return Promise.resolve();
      },
      applySshAccess: () => {
        order.push("ssh");
        return Promise.resolve(NO_CHANGE);
      },
      retirePrincipals: (usernames) => {
        order.push(`retire:${usernames.join(",")}`);
        return Promise.resolve({
          retired: ["gone"],
          failed: [{ username: "busy", error: "sites/ not empty" }],
        });
      },
    },
  );
  assertEquals(order, ["ensure", "ssh", "retire:gone,busy"]);
  assertEquals(result.principalsRetired, ["gone"]);
  assertEquals(result.warnings, ["principal busy kept: sites/ not empty"]);
});

test("handlePrincipalsReconcile reports the ids each account ended up with", async () => {
  const result = await handlePrincipalsReconcile(
    { principals: [{ principalId: "p1", username: "alice" }] },
    new Date().toISOString(),
    {
      resolveLayout: () => LAYOUT,
      ensureSystemPrincipals: () => Promise.resolve(),
      listAssetFolders: () => Promise.resolve([]),
      reportPrincipalIds: () =>
        Promise.resolve([{ principalId: "p1", uid: 20001, gid: 20001 }]),
      applySshAccess: () =>
        Promise.resolve({
          changedPrincipals: [],
          removedPrincipals: [],
          sshdReloaded: false,
          sftpChroot: false,
          warnings: [],
        }),
    },
  );
  assertEquals(result.principals, [
    { principalId: "p1", uid: 20001, gid: 20001 },
  ]);
});

const IDLE_DEPS = {
  resolveLayout: () => LAYOUT,
  ensureSystemPrincipals: () => Promise.resolve(),
  reportPrincipalIds: () => Promise.resolve([]),
  applySshAccess: () => Promise.resolve(NO_CHANGE),
};

test("handlePrincipalsReconcile reports the folders found on the host", async () => {
  const folders = [
    {
      owner: "alice",
      scope: "production",
      kind: "volume" as const,
      slug: "uploads",
      present: true,
    },
  ];
  const result = await handlePrincipalsReconcile(
    { principals: [{ principalId: "p1", username: "alice" }] },
    "2026-01-01T00:00:00.000Z",
    { ...IDLE_DEPS, listAssetFolders: () => Promise.resolve(folders) },
  );
  assertEquals(result.folders, folders);
  assertEquals(result.warnings, []);
});

test("handlePrincipalsReconcile leaves folders out, and says so, when the listing failed", async () => {
  const result = await handlePrincipalsReconcile(
    { principals: [{ principalId: "p1", username: "alice" }] },
    "2026-01-01T00:00:00.000Z",
    { ...IDLE_DEPS, listAssetFolders: () => Promise.resolve(null) },
  );
  assertEquals("folders" in result, false);
  assertEquals(result.warnings, [FOLDER_LIST_UNAVAILABLE_WARNING]);
});

test("handlePrincipalsReconcile asks for each account's home under the daemon's own root", async () => {
  const roots: Array<string | undefined> = [];
  await handlePrincipalsReconcile(
    { principals: [{ principalId: "p1", username: "alice" }] },
    "2026-01-01T00:00:00.000Z",
    {
      ...IDLE_DEPS,
      listAssetFolders: () => Promise.resolve([]),
      reportPrincipalIds: (_principals, _run, homeRoot) => {
        roots.push(homeRoot);
        return Promise.resolve([{
          principalId: "p1",
          uid: 20001,
          gid: 20001,
          home: `${homeRoot}/alice`,
        }]);
      },
    },
  );
  assertEquals(roots, ["/srv/users"]);
});
