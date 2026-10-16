/**
 * Postgres owner role per database, and the Database admin login.
 *
 * - A database made with `ownerRole` gets `tp_<db>_owner`, `_rw` and `_ro`
 *   (NOLOGIN) and belongs to the owner role. One that already exists with
 *   another owner is left alone.
 * - A migrations login (privilege `owner`) is a member of the owner role with
 *   no inherited rights and works as the owner role by session default.
 * - Without `ownerRole` nothing here runs: the grant-mode golden hashes cover
 *   the unchanged SQL for existing preset logins.
 */
import { assertEquals, assertThrows } from "@std/assert";
import type { ManagedApplyCredential } from "../../contracts/commands-contracts.ts";
import { mariadbManagedEngineRuntime } from "./mariadb.ts";
import { mysqlManagedEngineRuntime } from "./mysql.ts";
import { ownerRoleNames } from "./postgres-owner-role-sql.ts";
import { postgresManagedEngineRuntime } from "./postgres.ts";
import type {
  ManagedEngineContext,
  ManagedEngineExec,
  ManagedEngineRuntime,
} from "./types.ts";

const test = Deno.test.bind(Deno);

function harness(answers: (input: string) => string = () => "") {
  const inputs: string[] = [];
  const exec: ManagedEngineExec = (_argv, input) => {
    inputs.push(input ?? "");
    return Promise.resolve({
      success: true,
      stdout: answers(input ?? ""),
      stderr: "",
    });
  };
  const ctx: ManagedEngineContext = {
    containerId: "c1",
    composeServiceName: "svc",
    rootUsername: "root",
    defaultDatabase: "appdb",
    exec,
  };
  return { ctx, inputs };
}

const cred = (
  username: string,
  privileges: string[],
  extra: Partial<ManagedApplyCredential> = {},
): ManagedApplyCredential => ({
  principalId: `p-${username}`,
  username,
  role: "user",
  databases: ["shop"],
  privileges,
  password: "p1",
  ...extra,
});

test("owner role names are tp_<db>_owner, _rw and _ro and must fit 63 bytes", () => {
  assertEquals(ownerRoleNames("shop"), {
    owner: "tp_shop_owner",
    rw: "tp_shop_rw",
    ro: "tp_shop_ro",
  });
  assertThrows(() => ownerRoleNames("a".repeat(55)));
  assertEquals(ownerRoleNames("a".repeat(54)).owner.length, 63);
});

test("postgres: a new owner-role database gets its roles first, then is created for the owner role", async () => {
  const { ctx, inputs } = harness();
  await postgresManagedEngineRuntime.applyDatabases!(ctx, [
    { name: "shop", action: "create", ownerRole: true },
  ]);
  const sql = inputs.join("\n");
  assertEquals(sql.includes(`CREATE ROLE "tp_shop_owner" NOLOGIN`), true);
  assertEquals(sql.includes(`CREATE ROLE "tp_shop_rw" NOLOGIN`), true);
  assertEquals(sql.includes(`CREATE ROLE "tp_shop_ro" NOLOGIN`), true);
  assertEquals(
    sql.includes(`CREATE DATABASE "shop" OWNER "tp_shop_owner";`),
    true,
  );
  assertEquals(
    sql.indexOf("CREATE ROLE") < sql.indexOf("CREATE DATABASE"),
    true,
  );
});

test("postgres: an existing database with another owner is never converted", async () => {
  const { ctx, inputs } = harness((input) =>
    input.includes("r.rolname FROM pg_catalog.pg_database") ? "postgres\n" : ""
  );
  await postgresManagedEngineRuntime.applyDatabases!(ctx, [
    { name: "shop", action: "create", ownerRole: true },
  ]);
  const sql = inputs.join("\n");
  assertEquals(sql.includes("CREATE DATABASE"), false);
  assertEquals(sql.includes("CREATE ROLE"), false);
  assertEquals(sql.includes("ALTER DATABASE"), false);
  assertEquals(sql.includes("REASSIGN"), false);
});

test("postgres: dropping an owner-role database drops its three roles after the database", async () => {
  const { ctx, inputs } = harness();
  await postgresManagedEngineRuntime.applyDatabases!(ctx, [
    { name: "shop", action: "drop", ownerRole: true },
  ]);
  const sql = inputs.join("\n");
  assertEquals(
    sql.indexOf("DROP DATABASE") < sql.indexOf(`DROP ROLE "tp_shop_rw"`),
    true,
  );
  assertEquals(sql.includes(`DROP ROLE "tp_shop_owner"`), true);
  // A plain drop (no flag) touches no roles.
  const plain = harness();
  await postgresManagedEngineRuntime.applyDatabases!(plain.ctx, [
    { name: "shop", action: "drop" },
  ]);
  assertEquals(plain.inputs.join("\n").includes("DROP ROLE"), false);
});

const ownerRoleAnswers = (input: string) =>
  input.includes("tp_' || d.datname || '_owner'") ? "shop\n" : "";

test("postgres: logins on an owner-role database work through the roles", async () => {
  const { ctx, inputs } = harness(ownerRoleAnswers);
  await postgresManagedEngineRuntime.applyCredentials(
    ctx,
    [
      cred("migrate", ["owner"]),
      cred("app", ["read-write"]),
      cred("viewer", ["read-only"]),
    ],
    { ownerRoleDatabases: ["shop"] },
  );
  const sql = inputs.join("\n");
  // Migrations login: owner role with INHERIT FALSE, SET TRUE, session default.
  assertEquals(
    sql.includes(
      `EXECUTE 'GRANT "tp_shop_owner" TO "migrate" WITH INHERIT FALSE, SET TRUE';`,
    ),
    true,
  );
  assertEquals(
    sql.includes(
      `ALTER ROLE "migrate" IN DATABASE "shop" SET role = 'tp_shop_owner';`,
    ),
    true,
  );
  assertEquals(
    sql.includes(
      `EXECUTE 'GRANT "tp_shop_rw" TO "app" WITH INHERIT TRUE, SET FALSE';`,
    ),
    true,
  );
  assertEquals(
    sql.includes(
      `EXECUTE 'GRANT "tp_shop_ro" TO "viewer" WITH INHERIT TRUE, SET FALSE';`,
    ),
    true,
  );
  // Older clusters: plain grant plus role-wide NOINHERIT for the migrations login.
  assertEquals(sql.includes(`ALTER ROLE "migrate" NOINHERIT;`), true);
  // The login never takes the database; no per-login schema is made.
  assertEquals(sql.includes(`OWNER TO "migrate"`), false);
  assertEquals(sql.includes(`CREATE SCHEMA "app"`), false);
  // Defaults for objects the owner role (and the platform admin) creates.
  assertEquals(
    sql.includes(
      `ALTER DEFAULT PRIVILEGES FOR ROLE "tp_shop_owner" GRANT SELECT ON TABLES TO "tp_shop_ro";`,
    ),
    true,
  );
  assertEquals(
    sql.includes(
      `ALTER DEFAULT PRIVILEGES FOR ROLE "root" GRANT SELECT ON TABLES TO "tp_shop_ro";`,
    ),
    true,
  );
  // Not another login's defaults.
  assertEquals(sql.includes(`FOR ROLE "app"`), false);
  assertEquals(sql.includes(`FOR ROLE "migrate"`), false);
});

test("postgres: a login that is no longer a migrations login loses the role and the session default", async () => {
  const { ctx, inputs } = harness(ownerRoleAnswers);
  await postgresManagedEngineRuntime.applyCredentials(
    ctx,
    [cred("migrate", ["read-write"])],
    { ownerRoleDatabases: ["shop"] },
  );
  const sql = inputs.join("\n");
  assertEquals(sql.includes(`REVOKE "tp_shop_owner" FROM "migrate"`), true);
  assertEquals(
    sql.includes(`ALTER ROLE "migrate" IN DATABASE "shop" RESET role;`),
    true,
  );
});

test("postgres: the Database admin login is a plain member of the owner role with fixed attributes", async () => {
  const { ctx, inputs } = harness(ownerRoleAnswers);
  await postgresManagedEngineRuntime.applyCredentials(
    ctx,
    [cred("dba", ["admin"], { grantMode: "self" })],
    { ownerRoleDatabases: ["shop"] },
  );
  const sql = inputs.join("\n");
  assertEquals(
    sql.includes(
      `EXECUTE 'GRANT "tp_shop_owner" TO "dba" WITH INHERIT TRUE, SET TRUE';`,
    ),
    true,
  );
  assertEquals(
    sql.includes(
      `ALTER ROLE "dba" IN DATABASE "shop" SET role = 'tp_shop_owner';`,
    ),
    true,
  );
  assertEquals(
    sql.includes(
      `ALTER ROLE "dba" NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`,
    ),
    true,
  );
  assertEquals(
    sql.includes(`GRANT CONNECT, TEMPORARY ON DATABASE "shop" TO "dba"`),
    true,
  );
  // Never CREATEROLE/SUPERUSER/REPLICATION/BYPASSRLS on the login.
  const attrs = sql.split("\n").filter((l) =>
    l.includes('"dba"') && /CREATE ROLE|ALTER ROLE/.test(l)
  );
  assertEquals(
    attrs.some((l) =>
      /(?<!NO)(SUPERUSER|CREATEROLE|REPLICATION|BYPASSRLS)/.test(l)
    ),
    false,
  );
});

test("postgres: a Database admin on a database without an owner role gets the read-write rights", async () => {
  const { ctx, inputs } = harness();
  await postgresManagedEngineRuntime.applyCredentials(ctx, [
    cred("dba", ["admin"]),
  ]);
  const sql = inputs.join("\n");
  assertEquals(
    sql.includes(`GRANT CONNECT, TEMPORARY ON DATABASE "shop" TO "dba"`),
    true,
  );
  assertEquals(sql.includes("tp_shop_owner"), false);
  // Never ownership, never membership in a platform role.
  assertEquals(sql.includes(`OWNER TO "dba"`), false);
  assertEquals(/GRANT "[^"]+" TO "dba"/.test(sql), false);
});

for (
  const [name, engine] of [
    ["mysql", mysqlManagedEngineRuntime],
    ["mariadb", mariadbManagedEngineRuntime],
  ] as Array<[string, ManagedEngineRuntime]>
) {
  test(`${name}: the Database admin login gets ALL on its databases with the grant option and nothing global`, async () => {
    const { ctx, inputs } = harness();
    await engine.applyCredentials(ctx, [
      cred("dba", ["admin"], { grantMode: "self" }),
    ]);
    const sql = inputs.join("\n");
    assertEquals(
      /GRANT ALL PRIVILEGES ON `shop`\.\* TO `dba`@[^\n]* WITH GRANT OPTION;/
        .test(sql),
      true,
    );
    const mine = sql.split("\n").filter((l) =>
      l.includes("`dba`") && l.startsWith("GRANT")
    );
    assertEquals(mine.some((l) => l.includes("*.*")), false);
    assertEquals(
      mine.some((l) => /CREATE USER|SET_ANY_DEFINER|SET USER|SUPER/.test(l)),
      false,
    );
  });
}

test("postgres: a database that is not flagged keeps today's SQL (owner login still takes the database)", async () => {
  const run = async (options?: { ownerRoleDatabases: string[] }) => {
    const { ctx, inputs } = harness();
    await postgresManagedEngineRuntime.applyCredentials(
      ctx,
      [cred("migrate", ["owner"]), cred("app", ["read-write"])],
      options,
    );
    return inputs;
  };
  const plain = await run();
  assertEquals(await run({ ownerRoleDatabases: [] }), plain);
  const sql = plain.join("\n");
  assertEquals(sql.includes(`ALTER DATABASE "shop" OWNER TO "migrate"`), true);
  assertEquals(sql.includes("tp_shop"), false);
  assertEquals(sql.includes("pg_auth_members"), false);
});

test("postgres: a migrations login never takes an owner-role database, even when an apply comes without the flag", async () => {
  const { ctx, inputs } = harness(ownerRoleAnswers);
  await postgresManagedEngineRuntime.applyCredentials(ctx, [
    cred("migrate", ["owner"]),
  ]);
  const sql = inputs.join("\n");
  assertEquals(sql.includes(`OWNER TO "migrate"`), false);
  assertEquals(sql.includes(`"tp_shop_owner" TO "migrate"`), true);
});

/** The catalog answers for the database owner, emptiness and owner-role probe. */
function chosenOwnerAnswers(owner: string, empty: boolean) {
  return (input: string): string => {
    if (input.includes("r.rolname FROM pg_catalog.pg_database")) {
      return `${owner}\n`;
    }
    if (input.includes("SELECT (NOT EXISTS")) {
      return empty ? "true\n" : "false\n";
    }
    if (input.includes("SELECT d.datname FROM pg_catalog.pg_database d")) {
      return owner === "app" || owner === "tp_shop_owner" ? "shop\n" : "";
    }
    return "";
  };
}

test("postgres: the first database of a new cluster moves onto its owner role while it is empty", async () => {
  const { ctx, inputs } = harness(chosenOwnerAnswers("root", true));
  await postgresManagedEngineRuntime.applyDatabases!(ctx, [
    { name: "shop", action: "create", ownerRole: true },
  ]);
  const sql = inputs.join("\n");
  assertEquals(sql.includes("CREATE DATABASE"), false);
  assertEquals(sql.includes(`CREATE ROLE "tp_shop_owner" NOLOGIN`), true);
  assertEquals(
    sql.includes(`ALTER DATABASE "shop" OWNER TO "tp_shop_owner"`),
    true,
  );
});

test("postgres: the first database keeps its owner once anything is in it", async () => {
  const { ctx, inputs } = harness(chosenOwnerAnswers("root", false));
  await postgresManagedEngineRuntime.applyDatabases!(ctx, [
    { name: "shop", action: "create", ownerRole: true },
  ]);
  const sql = inputs.join("\n");
  assertEquals(sql.includes("ALTER DATABASE"), false);
  assertEquals(sql.includes("CREATE ROLE"), false);
});

test("postgres: a chosen owner login takes the database and works through the owner role", async () => {
  const { ctx, inputs } = harness(chosenOwnerAnswers("tp_shop_owner", true));
  await postgresManagedEngineRuntime.applyCredentials(
    ctx,
    [cred("app", ["read-write"]), cred("viewer", ["read-only"])],
    { ownerRoleDatabases: ["shop"], ownerLogins: { shop: "app" } },
  );
  const sql = inputs.join("\n");
  assertEquals(sql.includes(`ALTER DATABASE "shop" OWNER TO "app"`), true);
  assertEquals(
    sql.includes(`(r.rolname = 'tp_' || d.datname || '_owner' OR`),
    true,
  );
  // The owner role still owns what gets created; the login works as it.
  assertEquals(
    sql.includes(
      `ALTER ROLE "app" IN DATABASE "shop" SET role = 'tp_shop_owner';`,
    ),
    true,
  );
  assertEquals(
    sql.includes(`ALTER DEFAULT PRIVILEGES FOR ROLE "app" GRANT`),
    true,
  );
  // The login is not also a group member of the data roles.
  assertEquals(sql.includes(`"tp_shop_rw" TO "app"`), false);
  assertEquals(sql.includes(`"tp_shop_ro" TO "viewer"`), true);
});

test("postgres: a chosen owner login never takes a database that someone else owns", async () => {
  const { ctx, inputs } = harness(chosenOwnerAnswers("other", true));
  await postgresManagedEngineRuntime.applyCredentials(
    ctx,
    [cred("app", ["read-write"])],
    { ownerRoleDatabases: ["shop"], ownerLogins: { shop: "app" } },
  );
  assertEquals(inputs.join("\n").includes(`OWNER TO "app"`), false);
});

test("postgres: a read-only login never takes a database over", async () => {
  const { ctx, inputs } = harness(chosenOwnerAnswers("tp_shop_owner", true));
  await postgresManagedEngineRuntime.applyCredentials(
    ctx,
    [cred("viewer", ["read-only"])],
    { ownerRoleDatabases: ["shop"], ownerLogins: { shop: "viewer" } },
  );
  assertEquals(inputs.join("\n").includes(`OWNER TO "viewer"`), false);
});

test("postgres: a database already owned by its chosen login is not reported as another owner", async () => {
  const { ctx, inputs } = harness(chosenOwnerAnswers("app", true));
  await postgresManagedEngineRuntime.applyDatabases!(ctx, [
    { name: "shop", action: "create", ownerRole: true, ownerLogin: "app" },
  ]);
  const sql = inputs.join("\n");
  assertEquals(sql.includes("CREATE DATABASE"), false);
  assertEquals(sql.includes("ALTER DATABASE"), false);
  assertEquals(sql.includes(`CREATE ROLE "tp_shop_owner" NOLOGIN`), true);
});

test("postgres: a database with an owner role and a login owner stays an owner-role database when the choice is left out", async () => {
  const { ctx, inputs } = harness(chosenOwnerAnswers("app", true));
  await postgresManagedEngineRuntime.applyCredentials(
    ctx,
    [cred("migrate", ["owner"])],
    { ownerRoleDatabases: ["shop"] },
  );
  const sql = inputs.join("\n");
  assertEquals(sql.includes(`OWNER TO "migrate"`), false);
  assertEquals(sql.includes(`"tp_shop_owner" TO "migrate"`), true);
  assertEquals(sql.includes("AND r.rolname NOT IN ('postgres'"), true);
});

test("postgres: a platform role named as owner is ignored", async () => {
  const { ctx, inputs } = harness(chosenOwnerAnswers("root", true));
  await postgresManagedEngineRuntime.applyDatabases!(ctx, [
    { name: "shop", action: "create", ownerRole: true, ownerLogin: "root" },
  ]);
  await postgresManagedEngineRuntime.applyCredentials(
    ctx,
    [cred("app", ["read-write"])],
    { ownerRoleDatabases: ["shop"], ownerLogins: { shop: "root" } },
  );
  assertEquals(inputs.join("\n").includes(`OWNER TO "root"`), false);
});

test("postgres: the engine's own databases are never handed to an owner role", async () => {
  const { ctx, inputs } = harness(chosenOwnerAnswers("root", true));
  await postgresManagedEngineRuntime.applyDatabases!(ctx, [
    { name: "template1", action: "create", ownerRole: true },
  ]);
  assertEquals(inputs.join("\n").includes("ALTER DATABASE"), false);
});

test("postgres: an owner login that no longer qualifies hands the database back to the owner role", async () => {
  const { ctx, inputs } = harness(chosenOwnerAnswers("app", true));
  await postgresManagedEngineRuntime.applyCredentials(
    ctx,
    [cred("app", ["read-only"])],
    { ownerRoleDatabases: ["shop"], ownerLogins: { shop: "app" } },
  );
  assertEquals(
    inputs.join("\n").includes(`OWNER TO "tp_shop_owner"`),
    true,
  );
});
