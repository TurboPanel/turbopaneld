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
           INSERT INTO reports.totals VALUES (7);
           CREATE SCHEMA ext;
           CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA ext;
           CREATE PUBLICATION tp_restore_pub FOR TABLE public.orders;
           SELECT lo_create(424242);`,
        );
        await sql(
          "postgres",
          `CREATE FUNCTION tp_restore_trf() RETURNS event_trigger
             LANGUAGE plpgsql AS $$ BEGIN END; $$;
           CREATE EVENT TRIGGER tp_restore_et ON ddl_command_end
             EXECUTE FUNCTION tp_restore_trf();`,
        );
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
        // schema, a table dropped after backup, a login added after backup,
        // and a publication only in the live database (not in the dump).
        const lateLogin = credential("late_rw", ["read-write"]);
        await postgresManagedEngineRuntime.applyCredentials(ctx, [
          ...CREDENTIALS,
          lateLogin,
        ]);
        await sql(
          "own",
          `INSERT INTO public.orders (note) VALUES ('after-backup');
           CREATE TABLE public.made_later (id int);
           CREATE SCHEMA later;
           CREATE TABLE later.t (id int);
           DROP TABLE reports.totals;
           CREATE PUBLICATION only_after_backup FOR TABLE public.made_later;`,
        );
        await sql(
          "postgres",
          "ALTER DATABASE appdb SET tp.post_backup_only = 'kept';",
          "postgres",
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
        const aclAfter = await schemaPrivileges();
        for (
          const entry of [
            "public:PUBLIC:USAGE",
            "public:own:CREATE",
            "public:own:USAGE",
            "public:ro:USAGE",
            "public:rw:USAGE",
          ]
        ) {
          assertStringIncludes(
            aclAfter,
            entry,
            "the public schema keeps its backup-era privileges",
          );
        }
        assertStringIncludes(
          aclAfter,
          "public:late_rw:USAGE",
          "a login added after the backup keeps its public schema grant",
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
            `SELECT n.nspname FROM pg_extension e
               JOIN pg_namespace n ON n.oid = e.extnamespace
              WHERE e.extname = 'pgcrypto';`,
          ),
          "ext",
          "extension in a non-public schema should be back from the backup",
        );
        assertEquals(
          (await sql(
            "postgres",
            "SELECT encode(ext.digest('x', 'sha256'), 'hex');",
          )).length,
          64,
          "extension in schema ext should work after restore",
        );
        assertEquals(
          await sql(
            "postgres",
            "SELECT count(*) FROM pg_publication WHERE pubname = 'tp_restore_pub';",
          ),
          "1",
          "publication from the backup should be restored",
        );
        assertEquals(
          await sql(
            "postgres",
            "SELECT count(*) FROM pg_event_trigger WHERE evtname = 'tp_restore_et';",
          ),
          "1",
          "event trigger from the backup should be restored",
        );
        assertEquals(
          await sql(
            "postgres",
            "SELECT count(*) FROM pg_largeobject_metadata WHERE oid = 424242;",
          ),
          "1",
          "large object from the backup should be restored",
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
        // Login created after the backup: role grants survive restore; the
        // per-login schema is recreated by restoreReadWriteLoginSchemasSql.
        await sql(
          "late_rw",
          "CREATE TABLE late_rw.after_restore (id int); INSERT INTO late_rw.after_restore VALUES (1);",
        );
        assertEquals(
          await sql("postgres", "SELECT count(*) FROM late_rw.after_restore;"),
          "1",
        );
        // pg_restore --clean --if-exists: drops/recreates only objects in the
        // archive; post-backup database-global objects absent from the dump stay.
        assertEquals(
          await sql(
            "postgres",
            "SELECT count(*) FROM pg_publication WHERE pubname = 'only_after_backup';",
          ),
          "1",
          "publications not in the dump are left in place by --clean",
        );
        assertEquals(
          await sql(
            "postgres",
            "SELECT current_setting('tp.post_backup_only', true);",
          ),
          "kept",
          "database settings not in the dump are left in place by --clean",
        );
        assertEquals(
          await sql(
            "postgres",
            "SELECT count(*) FROM pg_event_trigger WHERE evtname = 'tp_restore_et';",
          ),
          "1",
          "event triggers from the backup are restored by replay",
        );
        assertEquals(
          await sql(
            "postgres",
            "SELECT count(*) FROM pg_publication_tables WHERE pubname = 'only_after_backup';",
          ),
          "0",
          "a post-backup publication survives but its table was removed by schema reset",
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

  test({
    name:
      `real Postgres ${series}: restore fails within 35s under lock contention and rolls back`,
    ignore: !dockerUp,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const name = `tp-restore-lock-pg${series}-${
        crypto.randomUUID().slice(0, 8)
      }`;
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
        const sql = async (sqlText: string, database = "appdb") => {
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
            "postgres",
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

        await sql(createDatabaseSql("appdb"), "postgres");
        await sql(
          `CREATE TABLE public.orders (id serial PRIMARY KEY, note text);
           INSERT INTO public.orders (note) VALUES ('held');`,
        );
        const dump = await docker([
          "exec",
          "-u",
          "postgres",
          name,
          ...backup.dumpArgv(ctx, { database: "appdb" }),
        ]);
        assertEquals(dump.success, true, dump.stderr);
        await sql(
          `INSERT INTO public.orders (note) VALUES ('after-backup');
           CREATE TABLE public.extra (id int);`,
        );

        const locker = new Deno.Command("docker", {
          args: [
            "exec",
            "-i",
            name,
            "psql",
            "-X",
            "-v",
            "ON_ERROR_STOP=1",
            "-U",
            "postgres",
            "-d",
            "appdb",
            "-c",
            "BEGIN; LOCK TABLE public.orders IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(60);",
          ],
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
        }).spawn();
        await delay(500);

        const restoreArgv = backup.restoreArgv(ctx, { database: "appdb" });
        const startedAt = Date.now();
        const failed = await docker(
          ["exec", "-i", "-u", "0", name, ...restoreArgv],
          dump.bytes,
        );
        const elapsedMs = Date.now() - startedAt;
        try {
          locker.kill("SIGTERM");
        } catch {
          /* already exited */
        }
        await locker.status.catch(() => undefined);

        assertEquals(failed.success, false, failed.stderr);
        const restoreErr = `${failed.stderr}\n${failed.stdout}`;
        assertStringIncludes(restoreErr, "database is unchanged");
        assertStringIncludes(restoreErr, "lock timeout");
        if (elapsedMs >= 35_000) {
          throw new Error(
            `restore waited ${elapsedMs}ms; expected lock_timeout near 30s`,
          );
        }
        assertEquals(
          await sql("SELECT count(*) FROM public.orders;"),
          "2",
          "failed restore must leave rows from before the attempt",
        );
        assertEquals(
          await sql(
            "SELECT to_regclass('public.extra') IS NOT NULL;",
          ),
          "t",
          "failed restore must not drop post-backup objects",
        );
      } finally {
        await docker(["rm", "-f", name]);
      }
    },
  });
}
