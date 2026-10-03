import { assertEquals } from "@std/assert";
import { retirePrincipals } from "./retire-principals.ts";
import type { SshApplyResult } from "./ssh/apply.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const SSH_OK: SshApplyResult = {
  changedPrincipals: [],
  removedPrincipals: [],
  sshdReloaded: false,
  sftpChroot: false,
  warnings: [],
};

test("retirePrincipals hands each account to tp-host principal-remove, once", async () => {
  const calls: string[][] = [];
  let rerenders = 0;
  const result = await retirePrincipals(["alice", "bob", "alice"], {
    runFn: (command, args) => {
      calls.push([command, ...args]);
      return Promise.resolve({ success: true, stdout: "", stderr: "" });
    },
    applySshAccess: () => {
      rerenders++;
      return Promise.resolve(SSH_OK);
    },
  });
  assertEquals(result, { retired: ["alice", "bob"], failed: [] });
  assertEquals(calls.map((argv) => argv.slice(-2)), [
    ["principal-remove", "alice"],
    ["principal-remove", "bob"],
  ]);
  assertEquals(calls.every((argv) => argv[0] === "sudo"), true);
  // One drop-in re-render for the whole batch.
  assertEquals(rerenders, 1);
});

test("retirePrincipals keeps an account tp-host refuses and keeps going", async () => {
  let rerenders = 0;
  const result = await retirePrincipals(["held", "free"], {
    runFn: (_command, args) =>
      Promise.resolve(
        args.at(-1) === "held"
          ? {
            success: false,
            stdout: "",
            stderr: "tp-host: principal-remove: held is still referenced",
          }
          : { success: true, stdout: "", stderr: "" },
      ),
    applySshAccess: () => {
      rerenders++;
      return Promise.resolve(SSH_OK);
    },
  });
  assertEquals(result.retired, ["free"]);
  assertEquals(result.failed, [{
    username: "held",
    error: "tp-host: principal-remove: held is still referenced",
  }]);
  assertEquals(rerenders, 1);
});

test("retirePrincipals leaves sshd alone when nothing was retired", async () => {
  let rerenders = 0;
  const result = await retirePrincipals(["held"], {
    runFn: () => Promise.reject(new Error("sudo: a password is required")),
    applySshAccess: () => {
      rerenders++;
      return Promise.resolve(SSH_OK);
    },
  });
  assertEquals(result.retired, []);
  assertEquals(result.failed[0]?.error, "sudo: a password is required");
  assertEquals(rerenders, 0);
  assertEquals(
    await retirePrincipals([], {
      runFn: () => Promise.reject(new Error("never called")),
    }),
    { retired: [], failed: [] },
  );
});

test("retirePrincipals survives a failed sshd re-render", async () => {
  const result = await retirePrincipals(["alice"], {
    runFn: () => Promise.resolve({ success: true, stdout: "", stderr: "" }),
    applySshAccess: () => Promise.reject(new Error("sshd -t failed")),
  });
  assertEquals(result.retired, ["alice"]);
});
