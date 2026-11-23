import { assertEquals, assertStringIncludes } from "@std/assert";
import type { ManagedApplyCredential } from "../../contracts/commands-contracts.ts";
import {
  ensureOwnerRolesSql,
  handOverPlatformObjectsSql,
} from "./postgres-owner-role-sql.ts";
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
// `18-alpine` is the managed default image; its BusyBox tools differ from the
// Debian images' GNU ones, so the restore script must pass on both.
const SERIES = (
  Deno.env.get("TURBOPANEL_REAL_POSTGRES_SERIES") ?? "16,18,18-alpine"
)
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

/**
 * Make the container's TCP side look like the managed engine's: TLS on, and
 * a `pg_hba.conf` that admits a TCP client only with `hostssl` and a password
 * from the container's own address (as on the managed network), and rejects
 * everything else. The socket stays open so the test's own `psql` calls work.
 * The restore reaches the engine as a non-admin login only this way.
 */
async function platformTransport(name: string): Promise<void> {
  const script = [
    "set -eu",
    "ip=$(hostname -i | cut -d' ' -f1)",
    // The Alpine image ships no openssl; fetch it there.
    "command -v openssl >/dev/null || apk add --no-cache openssl >/dev/null",
    'openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost -keyout "$PGDATA/server.key" -out "$PGDATA/server.crt" 2>/dev/null',
    'chown postgres "$PGDATA/server.key" "$PGDATA/server.crt"',
    'chmod 600 "$PGDATA/server.key"',
    'printf \'local all all trust\\nhostssl all all %s/32 scram-sha-256\\nhost all all all reject\\n\' "$ip" > "$PGDATA/pg_hba.conf"',
    `psql -X -q -U postgres -c "ALTER SYSTEM SET ssl = 'on'" -c "SELECT pg_reload_conf()" >/dev/null`,
    "sleep 1",
  ].join("\n");
  const done = await docker(["exec", name, "sh", "-c", script]);
  assertEquals(done.success, true, done.stderr);
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
        await platformTransport(name);
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
           SELECT lo_create(424242);
           CREATE TABLE public.items (id int PRIMARY KEY);
           INSERT INTO public.items SELECT g FROM generate_series(1, 50) g;
           CREATE TABLE public.notes (
             item_id int REFERENCES public.items (id), body text);
           INSERT INTO public.notes VALUES (1, 'n1'), (2, 'n2');
           CREATE VIEW public.item_notes AS
             SELECT i.id, n.body FROM public.items i JOIN public.notes n
               ON n.item_id = i.id;
           CREATE SEQUENCE public.s_extra;
           SELECT setval('public.s_extra', 100);`,
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
           INSERT INTO public.notes VALUES (3, 'late');
           SELECT setval('public.s_extra', 500);
           CREATE TABLE public.after_backup (id int REFERENCES public.items (id));
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
        // The schema reset's DROP ... CASCADE notices stay out of the output.
        assertEquals(
          restored.stderr.includes("NOTICE"),
          false,
          restored.stderr,
        );
        assertEquals(
          await sql(
            "postgres",
            `SELECT (SELECT count(*) FROM public.items) || ',' ||
                    (SELECT string_agg(body, ',' ORDER BY body)
                       FROM public.item_notes) || ',' ||
                    (SELECT last_value FROM public.s_extra) || ',' ||
                    (to_regclass('public.after_backup') IS NULL);`,
          ),
          "50,n1,n2,100,true",
          "dependent objects (foreign key, view, sequence) match the backup",
        );

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
        assertStringIncludes(failed.stderr, "pg_restore: error");
        assertEquals(failed.stderr.includes("NOTICE"), false, failed.stderr);
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
        await docker(["rm", "-f", "-v", name]);
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
        await platformTransport(name);
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

        await sql(ensureOwnerRolesSql("appdb"), "postgres");
        await sql(createDatabaseSql("appdb", "tp_appdb_owner"), "postgres");
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
        await docker(["rm", "-f", "-v", name]);
      }
    },
  });
  test({
    name:
      `real Postgres ${series}: restore hands objects to the owner role, drops later tables, and apply repairs ownership`,
    ignore: !dockerUp,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const name = `tp-restore-own-pg${series}-${
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
        await platformTransport(name);
        const run = (user: string, sqlText: string, database = "shop") =>
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
          ], sqlText);
        const sql = async (
          user: string,
          sqlText: string,
          database = "shop",
        ) => {
          const out = await run(user, sqlText, database);
          assertEquals(out.success, true, out.stderr);
          return out.stdout.trim();
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
        const login = (username: string, level: string) => ({
          ...credential(username, [level]),
          databases: ["shop"],
        });
        const logins = [login("migrate", "owner"), login("app", "read-write")];
        const apply = () =>
          postgresManagedEngineRuntime.applyCredentials(ctx, logins, {
            ownerRoleDatabases: ["shop"],
          });
        await sql("postgres", ensureOwnerRolesSql("shop"), "postgres");
        await sql(
          "postgres",
          "CREATE DATABASE shop OWNER tp_shop_owner;",
          "postgres",
        );
        await apply();
        await sql(
          "migrate",
          `CREATE TABLE public.a (id serial PRIMARY KEY, v text);
           INSERT INTO public.a (v) VALUES ('x');`,
        );
        const dump = await docker([
          "exec",
          "-u",
          "postgres",
          name,
          ...backup.dumpArgv(ctx, { database: "shop" }),
        ]);
        assertEquals(dump.success, true, dump.stderr);
        await sql("migrate", "CREATE TABLE public.later (id int);");

        const restored = await docker(
          [
            "exec",
            "-i",
            "-u",
            "0",
            name,
            ...backup.restoreArgv(ctx, { database: "shop" }),
          ],
          dump.bytes,
        );
        assertEquals(restored.success, true, restored.stderr);

        assertEquals(
          await sql(
            "postgres",
            `SELECT tableowner || ',' || (to_regclass('public.later') IS NULL) FROM pg_tables WHERE tablename = 'a';`,
          ),
          "tp_shop_owner,true",
          "restored table belongs to the owner role and the later table is gone",
        );
        await sql(
          "migrate",
          "ALTER TABLE public.a ADD COLUMN w int; SELECT count(*) FROM public.a;",
        );
        assertEquals(await sql("app", "SELECT count(*) FROM public.a;"), "1");
        await sql("app", "INSERT INTO public.a (v) VALUES ('y');");
        await sql(
          "migrate",
          "ALTER SEQUENCE public.a_id_seq RESTART; CREATE TABLE public.b (id int);",
        );

        // A database restored by an earlier release is repaired by the next apply.
        await sql(
          "postgres",
          "ALTER TABLE public.a OWNER TO postgres; ALTER SEQUENCE public.a_id_seq OWNER TO postgres;",
        );
        assertEquals(
          (await run("migrate", "ALTER TABLE public.a ADD COLUMN z int;"))
            .success,
          false,
          "the migration login is refused before the repair",
        );
        await apply();
        await sql("migrate", "ALTER TABLE public.a ADD COLUMN z int;");
        assertEquals(
          await sql(
            "postgres",
            `SELECT c.relowner::regrole::text FROM pg_class c WHERE relname = 'a_id_seq';`,
          ),
          "tp_shop_owner",
        );
      } finally {
        await docker(["rm", "-f", "-v", name]);
      }
    },
  });

  test({
    name:
      `real Postgres ${series}: hand-over leaves extension and other roles' objects, waits at most 5s for a lock, rolls back with the restore, and refuses an admin-owned database`,
    ignore: !dockerUp,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const name = `tp-handover-pg${series}-${crypto.randomUUID().slice(0, 8)}`;
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
        await platformTransport(name);
        const psqlArgs = (database: string) => [
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
        ];
        const sql = async (sqlText: string, database = "shop") => {
          const out = await docker(psqlArgs(database), sqlText);
          assertEquals(out.success, true, out.stderr);
          return out.stdout.trim();
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
        const logins = [{
          ...credential("migrate", ["owner"]),
          databases: ["shop"],
        }];
        const apply = () =>
          postgresManagedEngineRuntime.applyCredentials(ctx, logins, {
            ownerRoleDatabases: ["shop"],
          });
        const ownerOf = (relation: string) =>
          sql(
            `SELECT relowner::regrole::text FROM pg_class WHERE oid = '${relation}'::regclass;`,
          );

        await sql(ensureOwnerRolesSql("shop"), "postgres");
        await sql("CREATE DATABASE shop OWNER tp_shop_owner;", "postgres");
        await apply();
        await sql(
          `CREATE EXTENSION pgcrypto SCHEMA public;
           CREATE ROLE other LOGIN;
           GRANT CONNECT ON DATABASE shop TO other;
           GRANT USAGE, CREATE ON SCHEMA public TO other;
           CREATE TABLE public.a (id int);
           ALTER TABLE public.a OWNER TO postgres;`,
        );
        assertEquals(
          (await docker(
            psqlArgs("shop"),
            "CREATE TABLE public.theirs (id int);".replace(
              "CREATE",
              "SET ROLE other; CREATE",
            ),
          )).success,
          true,
        );

        // Apply hands the admin's table over; the extension's functions and
        // the other role's table stay where they are.
        await apply();
        assertEquals(await ownerOf("public.a"), "tp_shop_owner");
        assertEquals(await ownerOf("public.theirs"), "other");
        assertEquals(
          await sql(
            `SELECT proowner::regrole::text FROM pg_proc WHERE proname = 'digest' LIMIT 1;`,
          ),
          "postgres",
          "an extension's functions stay with the extension",
        );

        // A busy table fails the apply within about 5 s and changes nothing.
        await sql("ALTER TABLE public.a OWNER TO postgres;");
        const locker = new Deno.Command("docker", {
          args: [
            ...psqlArgs("shop").filter((arg) => arg !== "-q"),
            "-c",
            "BEGIN; LOCK TABLE public.a IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(40);",
          ],
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
        }).spawn();
        await delay(1000);
        const startedAt = Date.now();
        let message = "";
        try {
          await apply();
        } catch (error) {
          message = String(error);
        }
        const elapsedMs = Date.now() - startedAt;
        try {
          locker.kill("SIGTERM");
        } catch {
          /* already exited */
        }
        await locker.status.catch(() => undefined);
        // Killing the client leaves the server session holding the lock.
        await sql(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(40)%' AND pid <> pg_backend_pid();",
        );
        assertStringIncludes(message, "lock timeout");
        if (elapsedMs > 20_000) {
          throw new Error(`apply waited ${elapsedMs}ms for a lock`);
        }
        assertEquals(await ownerOf("public.a"), "postgres");
        await apply();
        assertEquals(await ownerOf("public.a"), "tp_shop_owner");

        // A hand-over that fails rolls the whole restore back.
        const dump = await docker([
          "exec",
          "-u",
          "postgres",
          name,
          ...backup.dumpArgv(ctx, { database: "shop" }),
        ]);
        assertEquals(dump.success, true, dump.stderr);
        await sql("CREATE TABLE public.made_later (id int);");
        const argv = backup.restoreArgv(ctx, { database: "shop" });
        // Position 8 is the finish SQL that runs inside the replay transaction.
        argv[8] = handOverPlatformObjectsSql(
          "(SELECT 'no_such_role')",
          "ARRAY[current_user::text]",
        ) + "\n" + argv[8];
        const failed = await docker(
          ["exec", "-i", "-u", "0", name, ...argv],
          dump.bytes,
        );
        assertEquals(failed.success, false);
        assertStringIncludes(failed.stderr, "database is unchanged");
        assertEquals(
          await sql("SELECT to_regclass('public.made_later') IS NOT NULL;"),
          "t",
          "a failed hand-over leaves the database as it was",
        );

        // A database the platform admin (a superuser) owns is refused, not
        // restored through a superuser session; its data is untouched.
        await sql("CREATE DATABASE plain;", "postgres");
        await sql("CREATE TABLE public.p (id int);", "plain");
        const plainDump = await docker([
          "exec",
          "-u",
          "postgres",
          name,
          ...backup.dumpArgv(ctx, { database: "plain" }),
        ]);
        assertEquals(plainDump.success, true, plainDump.stderr);
        await sql("CREATE TABLE public.p_later (id int);", "plain");
        const plainRestore = await docker(
          [
            "exec",
            "-i",
            "-u",
            "0",
            name,
            ...backup.restoreArgv(ctx, { database: "plain" }),
          ],
          plainDump.bytes,
        );
        assertEquals(plainRestore.success, false, plainRestore.stderr);
        assertStringIncludes(plainRestore.stderr, "restore refused");
        assertStringIncludes(plainRestore.stderr, "database is unchanged");
        assertEquals(
          await sql(
            "SELECT to_regclass('public.p_later') IS NOT NULL;",
            "plain",
          ),
          "t",
        );
      } finally {
        await docker(["rm", "-f", "-v", name]);
      }
    },
  });
}

for (const series of SERIES) {
  test({
    name:
      `real Postgres ${series}: restore runs tenant-defined code as the database owner, never as a superuser`,
    ignore: !dockerUp,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const name = `tp-restrole-pg${series}-${crypto.randomUUID().slice(0, 8)}`;
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
        await platformTransport(name);
        const run = (user: string, sqlText: string, database = "shop") =>
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
          ], sqlText);
        const sql = async (
          user: string,
          sqlText: string,
          database = "shop",
        ) => {
          const out = await run(user, sqlText, database);
          assertEquals(out.success, true, out.stderr);
          return out.stdout.trim();
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
        const login = (username: string, level: string) => ({
          ...credential(username, [level]),
          databases: ["shop"],
        });
        await sql("postgres", ensureOwnerRolesSql("shop"), "postgres");
        await sql(
          "postgres",
          "CREATE DATABASE shop OWNER tp_shop_owner;",
          "postgres",
        );
        await postgresManagedEngineRuntime.applyCredentials(
          ctx,
          [login("migrate", "owner"), login("app", "read-write")],
          { ownerRoleDatabases: ["shop"] },
        );

        // The tenant's own code: it notes who runs it and tries to make its
        // login a superuser. The volatile function does the work; the
        // immutable wrapper is what a CHECK, an index and a view may call.
        await sql(
          "migrate",
          `CREATE TABLE public.audit (src text, who text, super boolean);
           CREATE FUNCTION public.plant(src text) RETURNS boolean
             LANGUAGE plpgsql VOLATILE AS $f$
           BEGIN
             INSERT INTO public.audit
               SELECT src, current_user, r.rolsuper
                 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user;
             BEGIN
               ALTER ROLE migrate SUPERUSER;
             EXCEPTION WHEN OTHERS THEN NULL;
             END;
             RETURN true;
           END $f$;
           CREATE FUNCTION public.hook(src text) RETURNS text
             LANGUAGE sql IMMUTABLE AS $f$
             SELECT CASE WHEN public.plant(src) THEN src END $f$;
           CREATE TABLE public.checked (
             id int CHECK (public.plant('check')));
           INSERT INTO public.checked VALUES (1), (2);
           CREATE TABLE public.indexed (v text);
           INSERT INTO public.indexed VALUES ('a'), ('b');
           CREATE INDEX indexed_hook ON public.indexed (public.hook(v));
           CREATE MATERIALIZED VIEW public.mv AS
             SELECT id, public.hook('matview') AS h FROM public.checked;`,
        );
        // Setup runs the code as the tenant; only restore-time rows count.
        await sql("migrate", "DELETE FROM public.audit;");

        const dump = await docker([
          "exec",
          "-u",
          "postgres",
          name,
          ...backup.dumpArgv(ctx, { database: "shop" }),
        ]);
        assertEquals(dump.success, true, dump.stderr);

        const restored = await docker(
          [
            "exec",
            "-i",
            "-u",
            "0",
            name,
            ...backup.restoreArgv(ctx, { database: "shop" }),
          ],
          dump.bytes,
        );
        assertEquals(restored.success, true, restored.stderr);

        assertEquals(
          await sql(
            "postgres",
            "SELECT rolsuper FROM pg_roles WHERE rolname = 'migrate';",
            "postgres",
          ),
          "f",
          "the tenant login is still not a superuser",
        );
        assertEquals(
          await sql(
            "postgres",
            "SELECT count(*) FROM public.audit WHERE super;",
          ),
          "0",
          "no tenant code ran in a superuser session",
        );
        assertEquals(
          await sql(
            "postgres",
            "SELECT string_agg(DISTINCT src, ',' ORDER BY src) FROM public.audit WHERE who <> 'migrate';",
          ),
          "a,b,check,matview",
          "the restore did run the check, the index expression and the view",
        );
        assertEquals(
          await sql(
            "postgres",
            "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'tp\\_restore%';",
            "postgres",
          ),
          "0",
          "no temporary restore login is left behind",
        );
      } finally {
        await docker(["rm", "-f", "-v", name]);
      }
    },
  });
}

type ShopEnv = {
  name: string;
  sql: (user: string, sqlText: string, database?: string) => Promise<string>;
  dumpAndRestore: (mutate?: () => Promise<void>) => Promise<Run>;
};

/**
 * One throwaway engine with the platform transport and a database `shop`
 * owned by the owner role, with a `migrate` (owner) and an `app` (read-write)
 * login. `dumpAndRestore` takes a backup, runs `mutate` (changes made after
 * the backup), then restores the backup and returns the result.
 */
async function withShop(
  series: string,
  fn: (env: ShopEnv) => Promise<void>,
): Promise<void> {
  const name = `tp-restrole-pg${series}-${crypto.randomUUID().slice(0, 8)}`;
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
        throw new Error(`postgres:${series} did not start: ${started.stderr}`);
      }
      console.warn(`skipping real Postgres ${series}: container not ready`);
      return;
    }
    await platformTransport(name);
    const sql = async (user: string, sqlText: string, database = "shop") => {
      const out = await docker([
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
      assertEquals(out.success, true, out.stderr);
      return out.stdout.trim();
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
    const login = (username: string, level: string) => ({
      ...credential(username, [level]),
      databases: ["shop"],
    });
    await sql("postgres", ensureOwnerRolesSql("shop"), "postgres");
    await sql(
      "postgres",
      "CREATE DATABASE shop OWNER tp_shop_owner;",
      "postgres",
    );
    await postgresManagedEngineRuntime.applyCredentials(
      ctx,
      [login("migrate", "owner"), login("app", "read-write")],
      { ownerRoleDatabases: ["shop"] },
    );
    await fn({
      name,
      sql,
      dumpAndRestore: async (mutate) => {
        const dump = await docker([
          "exec",
          "-u",
          "postgres",
          name,
          ...backup.dumpArgv(ctx, { database: "shop" }),
        ]);
        assertEquals(dump.success, true, dump.stderr);
        if (mutate) await mutate();
        return docker(
          [
            "exec",
            "-i",
            "-u",
            "0",
            name,
            ...backup.restoreArgv(ctx, { database: "shop" }),
          ],
          dump.bytes,
        );
      },
    });
  } finally {
    await docker(["rm", "-f", "-v", name]);
  }
}

for (const series of SERIES) {
  test({
    name:
      `real Postgres ${series}: a failure after the large-object section rolls the whole restore back`,
    ignore: !dockerUp,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () =>
      withShop(series, async ({ sql, dumpAndRestore }) => {
        // The refresh of this view runs after the large objects (post-data)
        // and fails only for the restore (its session login is not `migrate`).
        await sql(
          "migrate",
          `CREATE TABLE public.keep (id int);
           INSERT INTO public.keep VALUES (1), (2);
           SELECT lo_create(424242);
           CREATE FUNCTION public.guard() RETURNS int
             LANGUAGE plpgsql VOLATILE AS $f$
           BEGIN
             IF session_user <> 'migrate' THEN
               RAISE EXCEPTION 'post-data failure on purpose';
             END IF;
             RETURN 1;
           END $f$;
           CREATE MATERIALIZED VIEW public.guarded AS SELECT public.guard() AS g;`,
        );
        const restored = await dumpAndRestore(async () => {
          await sql(
            "migrate",
            `INSERT INTO public.keep VALUES (3);
             CREATE TABLE public.after_backup (id int);
             SELECT lo_unlink(424242);`,
          );
        });
        assertEquals(restored.success, false, "the restore must fail");
        assertStringIncludes(restored.stderr, "post-data failure on purpose");
        assertStringIncludes(restored.stderr, "database is unchanged");
        assertEquals(
          await sql("postgres", "SELECT count(*) FROM public.keep;"),
          "3",
          "the data made after the backup is still there",
        );
        assertEquals(
          await sql(
            "postgres",
            "SELECT count(*) FROM pg_class WHERE relname = 'after_backup';",
          ),
          "1",
          "the schema reset was rolled back too",
        );
        assertEquals(
          await sql(
            "postgres",
            "SELECT count(*) FROM pg_largeobject_metadata WHERE oid = 424242;",
          ),
          "0",
          "the large object was not brought back by a failed restore",
        );
        assertEquals(
          await sql(
            "postgres",
            "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'tp\\_restore%';",
            "postgres",
          ),
          "0",
          "no temporary restore login is left behind",
        );
      }),
  });

  test({
    name:
      `real Postgres ${series}: dump code running as the owner cannot switch to or alter another login`,
    ignore: !dockerUp,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () =>
      withShop(series, async ({ sql, dumpAndRestore }) => {
        const hashes = () =>
          sql(
            "postgres",
            `SELECT string_agg(rolname || ':' || md5(coalesce(rolpassword, '')), ',' ORDER BY rolname)
               FROM pg_authid WHERE rolname IN ('app', 'legacy_own', 'migrate');`,
            "postgres",
          );
        // Dump text that runs at restore time and tries to become, or change,
        // the other logins. `RESET ROLE` goes back to the session login.
        await sql(
          "migrate",
          `CREATE TABLE public.audit (who text, target text, switched boolean, altered boolean);
           CREATE FUNCTION public.probe() RETURNS boolean
             LANGUAGE plpgsql VOLATILE AS $f$
           DECLARE t text; cur text := current_user; sw boolean; al boolean;
           BEGIN
             FOREACH t IN ARRAY ARRAY['app', 'legacy_own', 'postgres'] LOOP
               sw := false; al := false;
               EXECUTE 'RESET ROLE';
               BEGIN
                 EXECUTE format('SET ROLE %I', t);
                 sw := true;
                 BEGIN
                   EXECUTE format('ALTER ROLE %I PASSWORD %L', t, 'changed-by-dump');
                   al := true;
                 EXCEPTION WHEN OTHERS THEN NULL;
                 END;
               EXCEPTION WHEN OTHERS THEN NULL;
               END;
               EXECUTE 'RESET ROLE';
               BEGIN
                 EXECUTE format('ALTER ROLE %I PASSWORD %L', t, 'changed-by-dump');
                 al := true;
               EXCEPTION WHEN OTHERS THEN NULL;
               END;
               INSERT INTO public.audit VALUES (cur, t, sw, al);
               EXECUTE format('SET ROLE %I', cur);
             END LOOP;
             RETURN true;
           END $f$;
           CREATE TABLE public.checked (id int CHECK (public.probe()));
           INSERT INTO public.checked VALUES (1);`,
        );
        // The setup run is only the tenant's own session: keep restore rows.
        await sql("migrate", "DELETE FROM public.audit;");
        let before = "";
        const restored = await dumpAndRestore(async () => {
          // After the backup: a schema owned by a login that is not the owner
          // role. The restore has to drop it, so the restore login holds that
          // login's rights.
          await sql(
            "postgres",
            `CREATE ROLE legacy_own LOGIN PASSWORD 'legacy-secret-1';
             CREATE SCHEMA legacy AUTHORIZATION legacy_own;
             CREATE TABLE legacy.t (id int);
             ALTER TABLE legacy.t OWNER TO legacy_own;`,
          );
          before = await hashes();
        });
        assertEquals(restored.success, true, restored.stderr);
        assertEquals(
          await sql(
            "postgres",
            "SELECT count(*) FROM public.audit WHERE who = 'tp_shop_owner';",
          ),
          "3",
          "the probe ran at restore time, as the owner role",
        );
        assertEquals(
          await sql(
            "postgres",
            "SELECT count(*) FROM public.audit WHERE switched OR altered;",
          ),
          "0",
          "dump code could neither switch to nor alter another login",
        );
        assertEquals(
          await hashes(),
          before,
          "no login's password changed",
        );
        assertEquals(
          await sql(
            "postgres",
            "SELECT count(*) FROM pg_namespace WHERE nspname = 'legacy';",
          ),
          "0",
          "the other login's schema was dropped by the reset",
        );
      }),
  });
}
