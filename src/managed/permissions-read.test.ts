import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import type {
  ManagedPermissionsObserved,
  ObservedGrant,
  ObservedLogin,
} from "../contracts/cell-messages.ts";
import { postgresManagedEngineRuntime } from "./engines/postgres.ts";
import type {
  ManagedEngineContext,
  ManagedEngineRuntime,
  ManagedPermissionsEngineReport,
} from "./engines/types.ts";
import {
  boundLogin,
  budgetedExec,
  fitPermissions,
  PERMISSIONS_RESULT_MAX_BYTES,
  permissionsResultFrame,
  readManagedPermissions,
  validatePermissionsRequest,
} from "./permissions-read.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const MANAGED_ID = "00000000-0000-4000-8000-000000000001";

function ok(stdout = ""): DockerCliResult {
  return { success: true, code: 0, stdout, stderr: "" };
}

function fail(stderr: string): DockerCliResult {
  return { success: false, code: 1, stdout: "", stderr };
}

/** Docker that lists one engine container and answers `inspect` with `label`. */
function fakeDocker(
  options: { state?: string; label?: string; listed?: boolean } = {},
) {
  const calls: string[][] = [];
  const run = (args: string[]): Promise<DockerCliResult> => {
    calls.push(args);
    if (args[0] === "compose") {
      if (options.listed === false) return Promise.resolve(ok(""));
      return Promise.resolve(ok(JSON.stringify({
        ID: "abc123abc123",
        Name: "db-1",
        Service: "db",
        State: options.state ?? "running",
      })));
    }
    if (args[0] === "ps") return Promise.resolve(ok(""));
    if (args[0] === "inspect") {
      return Promise.resolve(ok(`${options.label ?? "<no value>"}\n`));
    }
    if (args[0] === "exec") {
      return Promise.resolve(fail("psql: could not connect to server"));
    }
    return Promise.resolve(fail("unexpected"));
  };
  return { calls, run };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    managedId: MANAGED_ID,
    engine: "postgres",
    logins: ["u1"],
    databases: ["appdb"],
    ...overrides,
  };
}

function fakeEngine(
  report: ManagedPermissionsEngineReport | Error,
): { engine: ManagedEngineRuntime; ctx: ManagedEngineContext } {
  return {
    engine: {
      ...postgresManagedEngineRuntime,
      readPermissions: () =>
        report instanceof Error
          ? Promise.reject(report)
          : Promise.resolve(report),
    },
    ctx: {
      containerId: "abc",
      composeServiceName: "db",
      rootUsername: "postgres",
      defaultDatabase: "postgres",
      exec: () => Promise.resolve({ success: false, stdout: "", stderr: "" }),
    },
  };
}

test("request validation: ids, engine, list sizes and name lengths", () => {
  assertEquals(
    validatePermissionsRequest(input({ managedId: "../x" })),
    { error: "managedId contains unsupported characters" },
  );
  assertEquals(
    validatePermissionsRequest(input({ engine: "oracle" })),
    { error: "unsupported managed engine" },
  );
  assertEquals(
    validatePermissionsRequest(input({ logins: "u1" })),
    { error: "logins must be a list" },
  );
  assertEquals(
    validatePermissionsRequest(
      input({ logins: Array.from({ length: 51 }, (_, i) => `u${i}`) }),
    ),
    { error: "at most 50 logins per request" },
  );
  assertEquals(
    validatePermissionsRequest(input({ logins: [""] })),
    { error: "logins must be names of 1 to 256 characters" },
  );
  assertEquals(
    validatePermissionsRequest(input({ logins: ["x".repeat(257)] })),
    { error: "logins must be names of 1 to 256 characters" },
  );
  // Postgres: past 100 databases the list is cut, not refused.
  const many = validatePermissionsRequest(
    input({ databases: Array.from({ length: 150 }, (_, i) => `d${i}`) }),
  );
  if ("error" in many) throw new TypeError(many.error);
  assertEquals(many.databases.length, 100);
  assertEquals(many.databases.at(-1), "d99");
  assertEquals(many.databasesCut, true);
  // Repeats past the limit are not a cut.
  const repeated = validatePermissionsRequest(
    input({
      databases: [...Array.from({ length: 100 }, (_, i) => `d${i}`), "d0"],
    }),
  );
  if ("error" in repeated) throw new TypeError(repeated.error);
  assertEquals(repeated.databasesCut, false);
  assertEquals(
    validatePermissionsRequest(input({ databases: [""] })),
    { error: "databases must be names of 1 to 256 characters" },
  );
  // MySQL / MariaDB ignore the list, whatever it holds.
  for (
    const databases of [
      undefined,
      "x",
      Array.from({ length: 5000 }, () => 7),
    ]
  ) {
    const ignored = validatePermissionsRequest(
      input({ engine: "mariadb", databases }),
    );
    if ("error" in ignored) throw new TypeError(ignored.error);
    assertEquals(ignored.databases, []);
  }
  // Duplicates collapse; MySQL-family requests drop the database list.
  assertEquals(
    validatePermissionsRequest(
      input({ engine: "mysql", logins: ["u1", "u1", "u2"] }),
    ),
    {
      managedId: MANAGED_ID,
      engine: "mysql",
      logins: ["u1", "u2"],
      databases: [],
      databasesCut: false,
    },
  );
});

test("an engine that is not running answers `engine not running`", async () => {
  const docker = fakeDocker({ listed: false });
  assertEquals(
    await readManagedPermissions(input(), { runDocker: docker.run }),
    { ok: false, error: "engine not running" },
  );
  const stopped = fakeDocker({ state: "exited", label: "postgres" });
  assertEquals(
    await readManagedPermissions(input(), { runDocker: stopped.run }),
    { ok: false, error: "engine not running" },
  );
});

test("the container's engine label must match the request", async () => {
  const mysql = fakeDocker({ label: "mysql" });
  assertEquals(
    await readManagedPermissions(input(), { runDocker: mysql.run }),
    { ok: false, error: "this database runs mysql, not postgres" },
  );
  assertEquals(mysql.calls.some((args) => args[0] === "exec"), false);
  const unlabelled = fakeDocker({});
  assertEquals(
    await readManagedPermissions(input(), { runDocker: unlabelled.run }),
    { ok: false, error: "could not confirm which engine this database runs" },
  );
});

test("an engine read failure is ok: false with a bounded error", async () => {
  const docker = fakeDocker({ label: "postgres" });
  const result = await readManagedPermissions(input(), {
    runDocker: docker.run,
    runDockerExec: docker.run,
  });
  assertEquals(result.ok, false);
  if (result.ok) throw new TypeError("expected a failure");
  assertStringIncludes(result.error, "psql failed");
  // Exec went through docker exec as root, SQL on stdin, never a password.
  const exec = docker.calls.find((args) => args[0] === "exec");
  assertEquals(exec?.slice(0, 5), ["exec", "-i", "-u", "0", "abc123abc123"]);

  const long = await readManagedPermissions(input(), {
    resolve: () => Promise.resolve(fakeEngine(new Error("x".repeat(9000)))),
  });
  if (long.ok) throw new TypeError("expected a failure");
  assertEquals(long.error.length, 4096);
});

test("a successful read is stamped and bounded", async () => {
  const result = await readManagedPermissions(input(), {
    resolve: () =>
      Promise.resolve(fakeEngine({
        serverVersion: "18.6",
        databasesRead: ["appdb"],
        logins: [{
          username: "u1",
          exists: true,
          memberships: [],
          grants: [{
            level: "database",
            database: "appdb",
            privileges: ["CONNECT"],
          }],
          defaults: [],
        }],
      })),
    now: () => new Date("2026-10-16T12:00:00.000Z"),
  });
  assertEquals(result, {
    ok: true,
    permissions: {
      engine: "postgres",
      observedAt: "2026-10-16T12:00:00.000Z",
      serverVersion: "18.6",
      databasesRead: ["appdb"],
      logins: [{
        username: "u1",
        exists: true,
        memberships: [],
        grants: [{
          level: "database",
          database: "appdb",
          privileges: ["CONNECT"],
        }],
        defaults: [],
      }],
    },
  });
});

test("per-item caps: privileges, columns and long names", () => {
  const grant: ObservedGrant = {
    level: "column",
    database: "appdb",
    object: "f".repeat(300),
    columns: Array.from({ length: 300 }, (_, i) => `c${i}`),
    privileges: Array.from({ length: 70 }, (_, i) => `P${i}`),
    grantable: ["P0"],
  };
  const login = boundLogin({
    username: "u1",
    exists: true,
    memberships: [],
    grants: [grant],
    defaults: [],
  });
  const bounded = login.grants[0]!;
  assertEquals(bounded.columns?.length, 256);
  assertEquals(bounded.privileges.length, 64);
  assertEquals(bounded.object?.length, 256);
  assertEquals(bounded.object?.endsWith("…"), true);
  assertEquals(login.truncated, true);

  const many = boundLogin({
    username: "u1",
    exists: true,
    memberships: [],
    grants: Array.from(
      { length: 2500 },
      (_, i) => ({ level: "table", object: `t${i}`, privileges: ["SELECT"] }),
    ),
    defaults: [],
  });
  assertEquals(many.grants.length, 2000);
  assertEquals(many.truncated, true);

  const small = boundLogin({
    username: "u1",
    exists: true,
    memberships: [],
    grants: [{ level: "global", privileges: ["USAGE"] }],
    defaults: [],
  });
  assertEquals(small.truncated, undefined);
});

function bigLogin(username: string, count: number): ObservedLogin {
  return {
    username,
    exists: true,
    memberships: [],
    grants: Array.from({ length: count }, (_, i) => ({
      level: "table",
      database: "appdb",
      schema: "public",
      object: `table_with_a_long_name_${i}`,
      privileges: ["SELECT", "INSERT", "UPDATE", "DELETE"],
      grantor: "app_owner",
    })),
    defaults: [],
  };
}

function frameBytes(permissions: ManagedPermissionsObserved): number {
  return new TextEncoder().encode(JSON.stringify(
    permissionsResultFrame("req-1", "2026-10-16T12:00:00.000Z", permissions),
  )).length;
}

test("the whole frame is cut under 100 KB, small logins stay whole", () => {
  const permissions: ManagedPermissionsObserved = {
    engine: "postgres",
    observedAt: "2026-10-16T12:00:00.000Z",
    logins: [
      bigLogin("big", 2000),
      bigLogin("medium", 400),
      bigLogin("tiny", 3),
    ],
  };
  assertEquals(
    frameBytes(permissions) > PERMISSIONS_RESULT_MAX_BYTES * 2,
    true,
  );
  const fitted = fitPermissions(
    permissions,
    PERMISSIONS_RESULT_MAX_BYTES,
    (p) => permissionsResultFrame("req-1", "2026-10-16T12:00:00.000Z", p),
  );
  assertEquals(frameBytes(fitted) <= PERMISSIONS_RESULT_MAX_BYTES, true);
  const [big, medium, tiny] = fitted.logins;
  assertEquals(big?.truncated, true);
  assertEquals(medium?.truncated, true);
  assertEquals(tiny?.grants.length, 3);
  assertEquals(tiny?.truncated, undefined);
  // The input is not changed.
  assertEquals(permissions.logins[0]?.grants.length, 2000);

  const modest = fitPermissions(
    { ...permissions, logins: [bigLogin("big", 900)] },
    PERMISSIONS_RESULT_MAX_BYTES,
  );
  assertEquals(modest.logins[0]?.truncated, true);
  assertEquals(
    JSON.stringify(modest).length <= PERMISSIONS_RESULT_MAX_BYTES,
    true,
  );
});

test("an engine without a reader is refused", async () => {
  const redis = await readManagedPermissions(input({ engine: "redis" }), {
    runDocker: () => Promise.reject(new Error("docker must not be called")),
  });
  assertEquals(redis.ok, false);
  const { ctx } = fakeEngine({ logins: [] });
  const result = await readManagedPermissions(input(), {
    resolve: () =>
      Promise.resolve({
        engine: { ...postgresManagedEngineRuntime, readPermissions: undefined },
        ctx,
      }),
  });
  assertEquals(result, {
    ok: false,
    error: "engine postgres cannot report permissions",
  });
});

test("failed databases pass through and a cut database list marks logins", async () => {
  let seenClock: unknown;
  const clock = { now: () => 0, budgetMs: 1 };
  const { engine, ctx } = fakeEngine({ logins: [] });
  const result = await readManagedPermissions(
    input({ databases: Array.from({ length: 120 }, (_, i) => `d${i}`) }),
    {
      clock,
      resolve: () =>
        Promise.resolve({
          ctx,
          engine: {
            ...engine,
            readPermissions: (_ctx, request, given) => {
              seenClock = given;
              assertEquals(request.databases.length, 100);
              return Promise.resolve({
                databasesRead: ["d0"],
                databasesFailed: ["d1"],
                logins: [
                  {
                    username: "u1",
                    exists: true,
                    memberships: [],
                    grants: [],
                    defaults: [],
                  },
                  {
                    username: "u2",
                    exists: false,
                    memberships: [],
                    grants: [],
                    defaults: [],
                  },
                ],
              });
            },
          },
        }),
    },
  );
  if (!result.ok) throw new TypeError(result.error);
  // The reader shares the handler's running budget.
  assertEquals(typeof (seenClock as { deadline?: unknown }).deadline, "object");
  assertEquals(result.permissions.databasesRead, ["d0"]);
  assertEquals(result.permissions.databasesFailed, ["d1"]);
  assertEquals(result.permissions.logins[0]?.truncated, true);
  assertEquals(result.permissions.logins[1]?.truncated, undefined);
});

const OPEN_DEADLINE = {
  expired: () => false,
  remainingMs: () => 30,
  roomForQuery: () => true,
};

test("a budgeted exec is refused once spent and killed when it overruns", async () => {
  const spent = budgetedExec(
    () => Promise.resolve({ success: true, stdout: "", stderr: "" }),
    { ...OPEN_DEADLINE, expired: () => true, remainingMs: () => 0 },
  );
  await assertRejects(() => spent(["true"]), Error, "ran out of time");

  let aborted = false;
  const hanging = budgetedExec(
    (_argv, _input, options) =>
      new Promise(() => {
        options?.signal?.addEventListener("abort", () => {
          aborted = true;
        });
      }),
    OPEN_DEADLINE,
  );
  await assertRejects(() => hanging(["psql"]), Error, "ran out of time");
  assertEquals(aborted, true);

  const quick = budgetedExec(
    () => Promise.resolve({ success: true, stdout: "ok", stderr: "" }),
    OPEN_DEADLINE,
  );
  assertEquals((await quick(["true"])).stdout, "ok");
});

test("a stuck database read is killed and reported as failed", async () => {
  let killed = false;
  const answers: [string, string][] = [
    ["server_version_num", '{"num": 180006, "text": "18.6"}'],
    [
      "WITH RECURSIVE",
      '[{"username": "u1", "oid": 16390, "attributes": {}, "memberships": [], "inherits": []}]',
    ],
    ["'tablespaces'", '{"tablespaces": [], "parameters": []}'],
    ["datallowconn", '["slow"]'],
  ];
  const { ctx } = fakeEngine({ logins: [] });
  const result = await readManagedPermissions(input({ databases: ["slow"] }), {
    clock: { deadline: OPEN_DEADLINE },
    resolve: () =>
      Promise.resolve({
        engine: postgresManagedEngineRuntime,
        ctx: {
          ...ctx,
          exec: (_argv, sql, options) => {
            const answer = answers.find(([marker]) => sql?.includes(marker));
            if (answer) {
              return Promise.resolve({
                success: true,
                stdout: answer[1],
                stderr: "",
              });
            }
            return new Promise(() => {
              options?.signal?.addEventListener("abort", () => {
                killed = true;
              });
            });
          },
        },
      }),
  });
  if (!result.ok) throw new TypeError(result.error);
  assertEquals(killed, true);
  assertEquals(result.permissions.databasesFailed, ["slow"]);
  assertEquals(result.permissions.databasesRead, []);
  assertEquals(result.permissions.logins[0]?.truncated, true);
});
