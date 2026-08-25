import { assertEquals } from "@std/assert";
import type { LayoutPaths } from "../../paths/layout.ts";
import type { PrincipalEnsureSpec } from "../../deploy/ensure-principal.ts";
import type {
  PrincipalSshSpec,
  SshApplyPaths,
  SshApplyResult,
} from "../../deploy/ssh/apply.ts";
import { handlePrincipalsReconcile } from "./principals-reconcile.ts";

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
          runtimes: [{ runtime: "php", series: "8.4" }],
          accessGroups: ["tpshell"],
          sshKeys: ["ssh-ed25519 AAAA"],
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
    runtimes: [{ runtime: "php", series: "8.4" }],
    accessGroups: ["tpshell"],
  });
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
      ensureSystemPrincipals: () => Promise.resolve(),
      applySshAccess: (principals) => {
        sshPrincipals = principals;
        return Promise.resolve({
          changedPrincipals: [],
          removedPrincipals: [],
          sshdReloaded: false,
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
