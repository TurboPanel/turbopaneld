/**
 * Postgres managed-engine runtime — admin-role stability regression coverage.
 *
 * The instance may resolve a *suffixed* user-facing root principal username
 * (e.g. `postgres_a1b2c3d4`) when two managed Postgres clusters in the same
 * server-owning organization would otherwise collide on the default
 * `postgres` login (see `resolveAvailableManagedRootUsername` in the
 * instance repo). `instance/src/lib/managed/postgres.ts` deliberately keeps
 * the container's bootstrap superuser (`POSTGRES_USER`) pinned to the stable
 * platform admin role regardless of that suffix — these tests assert the
 * daemon-side half of that contract: every admin operation connects as the
 * engine spec's static `rootUsername`, and the credential-apply path creates
 * the (possibly suffixed) user-facing root as a *separate* role rather than
 * assuming it is the connection identity.
 */

import { assertEquals } from "@std/assert";
import type { ManagedApplyCredential } from "../../instance/commands/contracts.ts";
import { getManagedEngineRuntime } from "./index.ts";
import type { ManagedEngineContext, ManagedEngineExec } from "./types.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

type RecordedExec = { argv: string[]; input?: string };

function recordingExec(): { exec: ManagedEngineExec; calls: RecordedExec[] } {
  const calls: RecordedExec[] = [];
  const exec: ManagedEngineExec = (argv, input) => {
    calls.push({ argv: [...argv], input });
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  return { exec, calls };
}

function buildContext(exec: ManagedEngineExec): ManagedEngineContext {
  return {
    containerId: "c1",
    composeServiceName: "postgres",
    // Always the stable platform admin — never the (possibly suffixed)
    // user-facing root principal. See module doc above.
    rootUsername: "postgres",
    defaultDatabase: "postgres",
    exec,
  };
}

test("applyCredentials connects as the stable platform admin even for a suffixed root credential", async () => {
  const engine = getManagedEngineRuntime("postgres");
  const { exec, calls } = recordingExec();
  const ctx = buildContext(exec);

  // Simulates the second of two Postgres clusters in the same server-owning
  // org, where `resolveAvailableManagedRootUsername` suffixed the preferred
  // "postgres" root login to avoid a ProxySQL-namespace collision.
  const suffixedRootCredential: ManagedApplyCredential = {
    principalId: "p-root",
    username: "postgres_a1b2c3d4",
    role: "root",
    databases: ["appdb"],
    password: "s3cret-root",
  };

  const applied = await engine.applyCredentials(ctx, [suffixedRootCredential]);
  assertEquals(applied, ["postgres_a1b2c3d4"]);

  assertEquals(calls.length, 1);
  const [call] = calls;
  // Connection identity is the stable admin, not the suffixed credential.
  assertEquals(call!.argv.includes("-U"), true);
  assertEquals(call!.argv[call!.argv.indexOf("-U") + 1], "postgres");
  // The SQL body creates/alters a *separate* superuser role named after the
  // suffixed credential — never reusing the connection identity.
  assertEquals(call!.input?.includes('"postgres_a1b2c3d4"'), true);
  assertEquals(call!.input?.includes("SUPERUSER"), true);
  assertEquals(call!.input?.includes('"postgres"'), false);
});

test("applyCredentials grants non-root credentials without superuser regardless of naming overlap", async () => {
  const engine = getManagedEngineRuntime("postgres");
  const { exec, calls } = recordingExec();
  const ctx = buildContext(exec);

  const appCredential: ManagedApplyCredential = {
    principalId: "p-app",
    username: "app_user",
    role: "user",
    databases: ["appdb"],
    privileges: ["read-write"],
    password: "s3cret-app",
  };

  await engine.applyCredentials(ctx, [appCredential]);

  const createCall = calls.find((c) => c.input?.includes("app_user"));
  if (!createCall) {
    throw new TypeError("expected a create-role call for app_user");
  }
  assertEquals(createCall.input?.includes("NOSUPERUSER"), true);
  assertEquals(createCall.argv[createCall.argv.indexOf("-U") + 1], "postgres");
});

test("dropUsers never drops the stable platform admin, even when it matches a stored username", async () => {
  const engine = getManagedEngineRuntime("postgres");
  const { exec, calls } = recordingExec();
  const ctx = buildContext(exec);

  if (!engine.dropUsers) {
    throw new TypeError("expected postgres dropUsers support");
  }
  const dropped = await engine.dropUsers(ctx, ["postgres", "orphaned_user"]);

  assertEquals(dropped, ["orphaned_user"]);
  assertEquals(calls.some((c) => c.input?.includes('"postgres"')), false);
  assertEquals(calls.some((c) => c.input?.includes('"orphaned_user"')), true);
});

test("waitReady and readVersion always target the stable platform admin", async () => {
  const engine = getManagedEngineRuntime("postgres");
  const { exec, calls } = recordingExec();
  const ctx = buildContext(exec);

  await engine.waitReady(ctx);
  await engine.readVersion(ctx);

  for (const call of calls) {
    const idx = call.argv.indexOf("-U");
    assertEquals(idx >= 0, true);
    assertEquals(call.argv[idx + 1], "postgres");
  }
});

test("backup dump/restore argv always target the stable platform admin regardless of ctx construction order", () => {
  const engine = getManagedEngineRuntime("postgres");
  if (!engine.backup) throw new TypeError("expected postgres backup support");
  const ctx = buildContext(recordingExec().exec);

  const dumpArgv = engine.backup.dumpArgv(ctx, { database: "appdb" });
  const restoreArgv = engine.backup.restoreArgv(ctx, { database: "appdb" });

  assertEquals(dumpArgv, ["pg_dump", "-Fc", "-U", "postgres", "-d", "appdb"]);
  assertEquals(restoreArgv.includes("-U"), true);
  assertEquals(restoreArgv[restoreArgv.indexOf("-U") + 1], "postgres");
});
