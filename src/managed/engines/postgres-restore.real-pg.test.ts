import { assertEquals, assertStringIncludes } from "@std/assert";
import type { ManagedApplyCredential } from "../../contracts/commands-contracts.ts";
import { createDatabaseSql } from "./postgres-sql.ts";
import { postgresManagedEngineRuntime } from "./postgres.ts";
import type { ManagedEngineContext } from "./types.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}; Sonar typescript:S2187 only
 * recognizes `test()` and reports Deno suites as empty.
 */
const test = Deno.test.bind(Deno);

/**
 * A restore returns the database to exactly the backup's state, against a REAL
 * Postgres server (one throwaway container per series, removed afterwards).
 * Rows, tables and schemas made after the backup must be gone, the logins
 * bound to the database must keep their access, and a dump that fails halfway
 * must leave the customer's data untouched.
 *
 * Gating matches `postgres-grants.real-pg.test.ts`: runs when Docker answers
 * and either `CI` or `TURBOPANEL_REAL_POSTGRES=1` is set.
 */
const SERIES = (Deno.env.get("TURBOPANEL_REAL_POSTGRES_SERIES") ?? "16,18")
  .split(",").map((value) => value.trim()).filter((value) => value.length > 0);
const REQUIRE = Deno.env.get("TURBOPANEL_REQUIRE_REAL_POSTGRES") === "1";
const WANTED = Deno.env.get("TURBOPANEL_REAL_POSTGRES") === "1" ||
  Deno.env.get("CI") === "true";

type Run = { success: boolean; stdout: string; stderr: string };

async function docker(
  args: string[],
  input?: string | Uint8Array,
): Promise<Run & { bytes: Uint8Array }> {
  try {
    const child = new Deno.Command("docker", {
      args,
      stdin: input === undefined ? "null" : "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    if (input !== undefined) {
      const writer = child.stdin.getWriter();
      await writer.write(
        typeof input === "string" ? new TextEncoder().encode(input) : input,
      );
      await writer.close();
    }
    const out = await child.output();
    return {
      success: out.success,
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
      bytes: out.stdout,
    };
  } catch (error) {
    return {
      success: false,
      stdout: "",
      stderr: String(error),
      bytes: new Uint8Array(),
    };
  }
}

const dockerUp = WANTED || REQUIRE ? (await docker(["info"])).success : false;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function credential(
  username: string,
  privileges: string[],
): ManagedApplyCredential {
  return {
    principalId: `p-${username}`,
    username,
    role: "user",
    databases: ["appdb"],
    privileges,
    password: ["pw", crypto.randomUUID()].join("-"),
  };
}

const CREDENTIALS: ManagedApplyCredential[] = [
  credential("own", ["owner"]),
  credential("rw", ["read-write"]),
  credential("ro", ["read-only"]),
];

for (const series of SERIES) {
  test({
    name:
      `real Postgres ${series}: restore returns the database to the backup state, keeps logins, and rolls back a bad dump`,
    ignore: !dockerUp,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const name = `tp-restore-pg${series}-${crypto.randomUUID().slice(0, 8)}`;
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
        const sql = async (
          user: string,
          sqlText: string,
          database = "appdb",
        ) => {
          const run = await docker([
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
          ], sqlText);
          assertEquals(run.success, true, run.stderr);
          return run.stdout.trim();
        };
        const ctx: ManagedEngineContext = {
          containerId: name,
          composeServiceName: "postgres",
          rootUsername: "postgres",
          defaultDatabase: "postgres",
          exec: (argv, input) => docker(["exec", "-i", name, ...argv], input),
        };
        const backup = postgresManagedEngineRuntime.backup;
        if (!backup) throw new TypeError("expected postgres backup support");

        await sql("postgres", createDatabaseSql("appdb"), "postgres");
        await postgresManagedEngineRuntime.applyCredentials(ctx, CREDENTIALS);
        await sql(
          "own",
          `CREATE TABLE public.orders (id serial PRIMARY KEY, note text);
           INSERT INTO public.orders (note) VALUES ('first'), ('second');
           CREATE SCHEMA reports;
           CREATE TABLE reports.totals (n int);
           INSERT INTO reports.totals VALUES (7);`,
        );
        await sql("postgres", "CREATE EXTENSION IF NOT EXISTS pgcrypto;");
        await sql("postgres", "GRANT USAGE ON SCHEMA reports TO rw;");

        const schemaPrivileges = () =>
          sql(
            "postgres",
            `SELECT string_agg(
                      n.nspname || ':' ||
                      CASE e.grantee WHEN 0 THEN 'PUBLIC' ELSE e.grantee::regrole::text END ||
                      ':' || e.privilege_type, ',' ORDER BY
                      n.nspname || ':' ||
                      CASE e.grantee WHEN 0 THEN 'PUBLIC' ELSE e.grantee::regrole::text END ||
                      ':' || e.privilege_type)
               FROM pg_namespace n, aclexplode(n.nspacl) e
              WHERE n.nspname = 'public';`,
          );
        const aclBefore = await schemaPrivileges();

        // The backup, exactly as the daemon takes it.
        const dump = await docker([
          "exec",
          "-u",
          "postgres",
          name,
          ...backup.dumpArgv(ctx, { database: "appdb" }),
        ]);
        assertEquals(dump.success, true, dump.stderr);

        // Changes made after the backup: more rows, a new table, a new
        // schema, and a table that existed at backup time is dropped.
        await sql(
          "own",
          `INSERT INTO public.orders (note) VALUES ('after-backup');
           CREATE TABLE public.made_later (id int);
           CREATE SCHEMA later;
           CREATE TABLE later.t (id int);
           DROP TABLE reports.totals;`,
        );

        const restoreArgv = backup.restoreArgv(ctx, { database: "appdb" });
        const restored = await docker(
          ["exec", "-i", "-u", "0", name, ...restoreArgv],
          dump.bytes,
        );
        assertEquals(restored.success, true, restored.stderr);

        assertEquals(
          await sql(
            "postgres",
            "SELECT string_agg(note, ',' ORDER BY id) FROM public.orders;",
          ),
          "first,second",
          "rows made after the backup should be gone",
        );
        assertEquals(
          await sql(
            "postgres",
            "SELECT to_regclass('public.made_later') IS NULL;",
          ),
          "t",
          "a table made after the backup should be gone",
        );
        assertEquals(
          await sql(
            "postgres",
            "SELECT count(*) FROM pg_namespace WHERE nspname = 'later';",
          ),
          "0",
          "a schema made after the backup should be gone",
        );
        assertEquals(
          await sql("postgres", "SELECT n FROM reports.totals;"),
          "7",
          "a table dropped after the backup should be back",
        );
        assertEquals(
          await schemaPrivileges(),
          aclBefore,
          "the public schema keeps its privileges",
        );
        assertEquals(
          await sql(
            "postgres",
            "SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname = 'public';",
          ),
          "pg_database_owner",
          "the public schema keeps its owner",
        );
        assertEquals(
          await sql(
            "postgres",
            "SELECT count(*) FROM pg_extension WHERE extname = 'pgcrypto';",
          ),
          "1",
        );
        // The bound logins keep working after the restore.
        assertEquals(
          await sql("rw", "SELECT count(*) FROM public.orders;"),
          "2",
        );
        await sql(
          "rw",
          "INSERT INTO public.orders (note) VALUES ('rw-after');",
        );
        assertEquals(
          await sql("ro", "SELECT count(*) FROM public.orders;"),
          "3",
        );
        await sql(
          "own",
          "CREATE TABLE public.owner_can_still_create (id int);",
        );

        // A dump that fails halfway rolls everything back: data stays.
        const truncated = dump.bytes.slice(
          0,
          Math.floor(dump.bytes.length / 2),
        );
        const failed = await docker(
          ["exec", "-i", "-u", "0", name, ...restoreArgv],
          truncated,
        );
        assertEquals(failed.success, false, "a truncated dump must fail");
        assertStringIncludes(failed.stderr, "database is unchanged");
        assertEquals(
          await sql("postgres", "SELECT count(*) FROM public.orders;"),
          "3",
          "a failed restore must leave the customer's data in place",
        );
        assertEquals(
          await sql(
            "postgres",
            "SELECT to_regclass('public.owner_can_still_create') IS NOT NULL;",
          ),
          "t",
        );
      } finally {
        await docker(["rm", "-f", name]);
      }
    },
  });
}
