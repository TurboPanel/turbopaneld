import { assertEquals, assertStringIncludes } from "@std/assert";
import type { ManagedApplyCredential } from "../../contracts/commands-contracts.ts";
import { forEachSequential } from "../../util/sequential.ts";
import { createDatabaseSql } from "./postgres-sql.ts";
import { postgresManagedEngineRuntime } from "./postgres.ts";
import type { ManagedEngineContext } from "./types.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/**
 * The login levels against a REAL Postgres server, one throwaway container per
 * series (no published port; removed afterwards). The unit tests next door
 * only compare SQL strings; this one runs the engine's own `applyCredentials`
 * and then connects as each login to see what Postgres actually allows.
 *
 * Runs when Docker answers and either `CI` or `TURBOPANEL_REAL_POSTGRES=1` is
 * set (skipped otherwise, so a plain local `deno test` stays offline). A CI run
 * that cannot start the container only warns, unless
 * `TURBOPANEL_REQUIRE_REAL_POSTGRES=1` turns that into a failure.
 * `TURBOPANEL_REAL_POSTGRES_SERIES` (comma separated majors) overrides the
 * default `16,18`.
 */
const SERIES = (Deno.env.get("TURBOPANEL_REAL_POSTGRES_SERIES") ?? "16,18")
  .split(",").map((value) => value.trim()).filter((value) => value.length > 0);
const REQUIRE = Deno.env.get("TURBOPANEL_REQUIRE_REAL_POSTGRES") === "1";
const WANTED = Deno.env.get("TURBOPANEL_REAL_POSTGRES") === "1" ||
  Deno.env.get("CI") === "true";

const DENIED = "permission denied";
const NO_DATABASE_ACCESS = "permission denied for database";

type Run = { success: boolean; stdout: string; stderr: string };

async function docker(args: string[], input?: string): Promise<Run> {
  try {
    const child = new Deno.Command("docker", {
      args,
      stdin: input === undefined ? "null" : "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    if (input !== undefined) {
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(input));
      await writer.close();
    }
    const out = await child.output();
    return {
      success: out.success,
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
    };
  } catch (error) {
    return { success: false, stdout: "", stderr: String(error) };
  }
}

const dockerUp = WANTED || REQUIRE ? (await docker(["info"])).success : false;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Ready only on the final server: the init-time one has no TCP listener. */
async function waitReady(name: string, attemptsLeft: number): Promise<boolean> {
  const probe = await docker([
    "exec",
    name,
    "pg_isready",
    "-h",
    "127.0.0.1",
    "-U",
    "postgres",
  ]);
  if (probe.success) return true;
  if (attemptsLeft <= 1) return false;
  await delay(1000);
  return waitReady(name, attemptsLeft - 1);
}

type Session = {
  /** Run SQL as a login; `ok` is false when Postgres refused any statement. */
  as: (user: string, database: string, sql: string) => Promise<Run>;
  /** One value, as the platform admin. */
  value: (sql: string, database?: string) => Promise<string>;
};

function sessionFor(name: string): Session {
  const as = (user: string, database: string, sql: string) =>
    docker([
      "exec",
      "-i",
      name,
      "psql",
      "-X",
      "-q",
      "-t",
      "-A",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      user,
      "-d",
      database,
    ], sql);
  const value = async (sql: string, database = "postgres") => {
    const run = await as("postgres", database, sql);
    assertEquals(run.success, true, run.stderr);
    return run.stdout.trim();
  };
  return { as, value };
}

function credential(
  username: string,
  databases: string[],
  privileges: string[],
): ManagedApplyCredential {
  return {
    principalId: `p-${username}`,
    username,
    role: "user",
    databases,
    privileges,
    password: ["pw", crypto.randomUUID()].join("-"),
  };
}

const CREDENTIALS: ManagedApplyCredential[] = [
  credential("own", ["appdb"], ["owner"]),
  credential("rw", ["appdb"], ["read-write"]),
  credential("ro", ["appdb"], ["read-only"]),
  credential("stranger", [], []),
];

async function expectRefused(
  session: Session,
  user: string,
  database: string,
  sql: string,
  message: string,
): Promise<void> {
  const run = await session.as(user, database, sql);
  assertEquals(run.success, false, `${user} should be refused: ${sql}`);
  assertStringIncludes(run.stderr, message);
}

async function expectAllowed(
  session: Session,
  user: string,
  database: string,
  sql: string,
): Promise<void> {
  const run = await session.as(user, database, sql);
  assertEquals(
    run.success,
    true,
    `${user} should be allowed: ${sql}\n${run.stderr}`,
  );
}

async function snapshot(session: Session): Promise<string> {
  return await session.value(
    `SELECT (SELECT xmin::text FROM pg_database WHERE datname = 'appdb') || '/' ||
            (SELECT xmin::text FROM pg_namespace WHERE nspname = 'public') || '/' ||
            (SELECT string_agg(xmin::text, ',' ORDER BY relname) FROM pg_class
              WHERE relname IN ('orders', 'orders_id_seq', 'rw_made'));`,
    "appdb",
  );
}

async function proveLogins(
  session: Session,
  applyAgain: () => Promise<void>,
  major: number,
): Promise<void> {
  // The owner makes a table and a sequence.
  await expectAllowed(
    session,
    "own",
    "appdb",
    `CREATE TABLE public.orders (id serial PRIMARY KEY, note text);
     INSERT INTO public.orders (note) VALUES ('first');`,
  );
  // A table that existed before the next apply is covered by the same rules.
  await applyAgain();

  // Read-write: reads and writes, and nothing that runs code as someone else.
  await expectAllowed(
    session,
    "rw",
    "appdb",
    `INSERT INTO public.orders (note) VALUES ('rw');
     UPDATE public.orders SET note = 'rw2' WHERE id = 1;
     DELETE FROM public.orders WHERE id = 2;
     SELECT nextval('public.orders_id_seq');
     CREATE TABLE public.rw_made (id int);
     TRUNCATE public.rw_made;`,
  );
  const trigger =
    `CREATE FUNCTION public.rw_fn() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';
    CREATE TRIGGER rw_trg BEFORE INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION public.rw_fn();`;
  await expectRefused(session, "rw", "appdb", trigger, DENIED);
  await expectRefused(
    session,
    "rw",
    "appdb",
    `ALTER TABLE public.orders ADD COLUMN extra int;`,
    "must be owner",
  );
  await expectRefused(
    session,
    "rw",
    "appdb",
    `DROP TABLE public.orders;`,
    "must be owner",
  );
  await expectRefused(
    session,
    "rw",
    "appdb",
    `CREATE ROLE sneaky;`,
    DENIED,
  );
  // Exactly the five table privileges, no REFERENCES or TRIGGER.
  const held = await session.value(
    `SELECT string_agg(p, ',' ORDER BY p) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
      WHERE has_table_privilege('rw', 'public.orders', p)`,
    "appdb",
  );
  assertEquals(held, "DELETE,INSERT,SELECT,TRUNCATE,UPDATE");
  if (major >= 17) {
    assertEquals(
      await session.value(
        `SELECT has_table_privilege('rw', 'public.orders', 'MAINTAIN')`,
        "appdb",
      ),
      "f",
    );
  }
  // The owner login cannot be made to run a writer's code on a writer's table.
  await expectRefused(
    session,
    "own",
    "appdb",
    `CREATE TRIGGER own_trg BEFORE INSERT ON public.rw_made FOR EACH ROW EXECUTE FUNCTION public.rw_fn();`,
    "permission denied for table rw_made",
  );
  // A table the platform admin makes later (a restore) is reachable, still
  // without TRIGGER.
  await session.value(`CREATE TABLE public.restored (id int)`, "appdb");
  await expectAllowed(
    session,
    "rw",
    "appdb",
    `INSERT INTO public.restored VALUES (1);`,
  );
  await expectRefused(
    session,
    "rw",
    "appdb",
    `CREATE TRIGGER t3 BEFORE INSERT ON public.restored FOR EACH ROW EXECUTE FUNCTION public.rw_fn();`,
    "permission denied for table restored",
  );
  assertEquals(
    await session.value(
      `SELECT has_table_privilege('rw', 'public.restored', 'TRIGGER')`,
      "appdb",
    ),
    "f",
  );

  // Read-only: reads, and cannot change a table, sequence or schema. The
  // session default is lifted first so it is the privileges that refuse.
  const lifted = (sql: string) =>
    `SET default_transaction_read_only = off;\n${sql}`;
  await expectAllowed(
    session,
    "ro",
    "appdb",
    `SELECT count(*) FROM public.orders;`,
  );
  await expectRefused(
    session,
    "ro",
    "appdb",
    lifted(`INSERT INTO public.orders (note) VALUES ('x');`),
    DENIED,
  );
  await expectRefused(
    session,
    "ro",
    "appdb",
    lifted(`SELECT nextval('public.orders_id_seq');`),
    DENIED,
  );
  await expectRefused(
    session,
    "ro",
    "appdb",
    lifted(`CREATE TABLE public.ro_made (id int);`),
    DENIED,
  );
  await expectRefused(
    session,
    "ro",
    "appdb",
    lifted(`CREATE SCHEMA ro_schema;`),
    DENIED,
  );
  await expectRefused(
    session,
    "ro",
    "appdb",
    lifted(`CREATE TEMP TABLE t (id int);`),
    DENIED,
  );
  await expectRefused(
    session,
    "ro",
    "appdb",
    lifted(`TRUNCATE public.orders;`),
    DENIED,
  );

  // Lock-down: nobody gets in by default.
  await expectRefused(
    session,
    "stranger",
    "appdb",
    `SELECT 1;`,
    NO_DATABASE_ACCESS,
  );
  await expectRefused(
    session,
    "rw",
    "other",
    `SELECT 1;`,
    NO_DATABASE_ACCESS,
  );
  await expectRefused(
    session,
    "ro",
    "postgres",
    `SELECT 1;`,
    NO_DATABASE_ACCESS,
  );
  // A ProxySQL monitor login (member of pg_monitor) still reaches `postgres`.
  await session.value(
    `CREATE ROLE mon LOGIN; GRANT pg_monitor TO mon;`,
  );
  await applyAgain();
  await expectAllowed(session, "mon", "postgres", `SELECT 1;`);
  await expectRefused(
    session,
    "mon",
    "appdb",
    `SELECT 1;`,
    NO_DATABASE_ACCESS,
  );
}

async function proveOldClusterIsCorrected(
  session: Session,
  applyAgain: () => Promise<void>,
): Promise<void> {
  // What the first draft of the grants left behind: ALL on tables, now and
  // for tables the owner makes later.
  await session.value(
    `GRANT ALL ON ALL TABLES IN SCHEMA public TO rw;
     ALTER DEFAULT PRIVILEGES FOR ROLE own GRANT ALL ON TABLES TO rw;`,
    "appdb",
  );
  await expectAllowed(
    session,
    "own",
    "appdb",
    `CREATE TABLE public.later (id int);`,
  );
  assertEquals(
    await session.value(
      `SELECT has_table_privilege('rw', 'public.later', 'TRIGGER')`,
      "appdb",
    ),
    "t",
  );
  await applyAgain();
  await forEachSequential(["orders", "later"], async (table) => {
    assertEquals(
      await session.value(
        `SELECT has_table_privilege('rw', 'public.${table}', 'TRIGGER') OR has_table_privilege('rw', 'public.${table}', 'REFERENCES')`,
        "appdb",
      ),
      "f",
      `${table} still carries TRIGGER or REFERENCES for the read-write login`,
    );
  });
  await expectAllowed(
    session,
    "own",
    "appdb",
    `CREATE TABLE public.after_fix (id int);`,
  );
  assertEquals(
    await session.value(
      `SELECT has_table_privilege('rw', 'public.after_fix', 'TRIGGER'), has_table_privilege('rw', 'public.after_fix', 'INSERT')`,
      "appdb",
    ),
    "f|t",
  );
}

for (const series of SERIES) {
  test({
    name:
      `real Postgres ${series}: login levels, lock-down and no TRIGGER for read-write`,
    ignore: !dockerUp,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const name = `tp-grants-pg${series}-${crypto.randomUUID().slice(0, 8)}`;
      const started = await docker([
        "run",
        "-d",
        "--rm",
        "--name",
        name,
        "-e",
        "POSTGRES_HOST_AUTH_METHOD=trust",
        `postgres:${series}`,
      ]);
      try {
        if (!started.success || !(await waitReady(name, 60))) {
          if (REQUIRE) {
            throw new Error(
              `postgres:${series} did not start: ${started.stderr}`,
            );
          }
          console.warn(`skipping real Postgres ${series}: container not ready`);
          return;
        }
        const session = sessionFor(name);
        const ctx: ManagedEngineContext = {
          containerId: name,
          composeServiceName: "postgres",
          rootUsername: "postgres",
          defaultDatabase: "postgres",
          exec: (argv, input) => docker(["exec", "-i", name, ...argv], input),
        };
        const applyAgain = async () => {
          await postgresManagedEngineRuntime.applyCredentials(ctx, CREDENTIALS);
        };
        const major = Math.floor(
          Number(await session.value(`SHOW server_version_num;`)) / 10000,
        );
        assertEquals(String(major), series);

        await session.value(createDatabaseSql("appdb"));
        await session.value(createDatabaseSql("other"));
        await applyAgain();
        await proveLogins(session, applyAgain, major);

        // A repeated apply rewrites no ACL: the catalog rows are untouched.
        await applyAgain();
        const before = await snapshot(session);
        await applyAgain();
        assertEquals(await snapshot(session), before);

        await proveOldClusterIsCorrected(session, applyAgain);
      } finally {
        await docker(["rm", "-f", name]);
      }
    },
  });
}
