import { assertEquals, assertStringIncludes } from "@std/assert";
import type { ManagedApplyCredential } from "../../contracts/commands-contracts.ts";
import { postgresManagedEngineRuntime } from "./postgres.ts";
import type { ManagedEngineContext } from "./types.ts";

/** Sonar typescript:S2187 only recognizes `test()`; see postgres-grants.real-pg.test.ts. */
const test = Deno.test.bind(Deno);

/**
 * Handing a database that already holds data (the cluster's first database,
 * or one from before owner roles) to its owner role, against a REAL Postgres
 * server: nothing is lost, the two owner logins stop fighting over tables, the
 * Database admin login gets full rights, and without the request the database
 * is left exactly as it was. Same gating as the other `*.real-pg.test.ts`
 * files (Docker, and `CI` or `TURBOPANEL_REAL_POSTGRES=1`).
 */
const SERIES = (Deno.env.get("TURBOPANEL_REAL_POSTGRES_SERIES") ?? "18")
  .split(",").map((value) => value.trim()).filter((value) => value.length > 0);
const REQUIRE = Deno.env.get("TURBOPANEL_REQUIRE_REAL_POSTGRES") === "1";
const WANTED = Deno.env.get("TURBOPANEL_REAL_POSTGRES") === "1" ||
  Deno.env.get("CI") === "true";

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
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return waitReady(name, attemptsLeft - 1);
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

const LOGINS = [
  credential("mig", ["legacy"], ["owner"]),
  credential("mig2", ["legacy"], ["owner"]),
  credential("adm", ["legacy"], ["admin"]),
  credential("rw", ["legacy"], ["read-write"]),
  credential("ro", ["legacy"], ["read-only"]),
];

for (const series of SERIES) {
  test({
    name:
      `real Postgres ${series}: a first database with data moves onto its owner role on request`,
    ignore: !dockerUp,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const name = `tp-convert-pg${series}-${crypto.randomUUID().slice(0, 8)}`;
      const started = await docker([
        "run",
        "-d",
        "--rm",
        "--name",
        name,
        "-e",
        "POSTGRES_HOST_AUTH_METHOD=trust",
        "-e",
        "POSTGRES_DB=legacy",
        `postgres:${series}`,
      ]);
      try {
        if (!started.success || !(await waitReady(name, 60))) {
          if (REQUIRE) throw new Error(`postgres:${series} did not start`);
          console.warn(`skipping real Postgres ${series}: container not ready`);
          return;
        }
        const as = (user: string, sql: string) =>
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
            "legacy",
          ], sql);
        const value = async (sql: string) => {
          const run = await as("postgres", sql);
          assertEquals(run.success, true, run.stderr);
          return run.stdout.trim();
        };
        const allowed = async (user: string, sql: string) => {
          const run = await as(user, sql);
          assertEquals(run.success, true, `${user}: ${sql}\n${run.stderr}`);
        };
        const refused = async (user: string, sql: string, why: string) => {
          const run = await as(user, sql);
          assertEquals(run.success, false, `${user} should fail: ${sql}`);
          assertStringIncludes(run.stderr, why);
        };
        // Before the move the owner logins cannot all connect (each one that
        // takes the database loses the others' connect right), so the older
        // cluster's work is done as the platform admin acting as the login.
        const asRole = (role: string, sql: string) =>
          as("postgres", `SET ROLE ${role}; ${sql}`);
        const setup = async (role: string, sql: string) => {
          const run = await asRole(role, sql);
          assertEquals(run.success, true, run.stderr);
        };
        const ctx: ManagedEngineContext = {
          containerId: name,
          composeServiceName: "postgres",
          rootUsername: "postgres",
          defaultDatabase: "postgres",
          exec: (argv, input) => docker(["exec", "-i", name, ...argv], input),
        };
        const engine = postgresManagedEngineRuntime;
        const owners = () =>
          value(
            `SELECT r.rolname FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE d.datname = 'legacy'`,
          );
        const convertOptions = { ownerRoleDatabases: ["legacy"] };

        // An older cluster: the database belongs to the platform admin and
        // each owner login has made its own things in it.
        await engine.applyCredentials(ctx, LOGINS);
        await value(`GRANT ALL ON SCHEMA public TO mig, mig2`);
        await setup(
          "mig",
          `CREATE TABLE public.orders (id serial PRIMARY KEY, note text);
           INSERT INTO public.orders (note) VALUES ('kept');
           CREATE VIEW public.order_notes AS SELECT note FROM public.orders;
           CREATE TYPE public.mood AS ENUM ('ok');`,
        );
        await setup(
          "mig2",
          `CREATE TABLE public.items (id int); CREATE SCHEMA extra;
           CREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS 'SELECT 1';`,
        );
        const before = await asRole(
          "mig2",
          `ALTER TABLE public.orders ADD c int`,
        );
        assertEquals(before.success, false);
        assertStringIncludes(before.stderr, "must be owner");

        // Without the request an apply leaves the database exactly as it was.
        await engine.applyDatabases(ctx, [
          { name: "legacy", action: "create", ownerRole: true },
        ]);
        assertEquals(await owners(), "mig2");
        assertEquals(
          await value(
            `SELECT count(*) FROM pg_roles WHERE rolname = 'tp_legacy_owner'`,
          ),
          "0",
        );

        // With it, ownership moves and no data is lost.
        await engine.applyDatabases(ctx, [
          {
            name: "legacy",
            action: "create",
            ownerRole: true,
            convertExisting: true,
          },
        ]);
        await engine.applyCredentials(ctx, LOGINS, convertOptions);
        assertEquals(await owners(), "tp_legacy_owner");
        assertEquals(await value(`SELECT note FROM public.orders`), "kept");
        assertEquals(
          await value(
            `SELECT count(*) FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','v','S') AND r.rolname <> 'tp_legacy_owner'`,
          ),
          "0",
        );
        assertEquals(
          await value(
            `SELECT r.rolname FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner WHERE n.nspname = 'extra'`,
          ),
          "tp_legacy_owner",
        );

        // Both owner logins and the admin login can now change each other's work.
        await allowed("mig2", `ALTER TABLE public.orders ADD COLUMN c int`);
        await allowed("mig", `ALTER TABLE public.items ADD COLUMN c int`);
        await allowed("mig", `ALTER TYPE public.mood ADD VALUE 'fine'`);
        await allowed("adm", `ALTER TABLE public.orders DROP COLUMN c`);
        await allowed("adm", `CREATE TABLE public.by_admin (id int)`);
        await allowed("mig", `ALTER TABLE public.by_admin ADD COLUMN c int`);
        await allowed("rw", `INSERT INTO public.orders (note) VALUES ('rw')`);
        await allowed("rw", `SELECT * FROM public.by_admin`);
        await refused("rw", `DROP TABLE public.orders`, "must be owner");
        await allowed("ro", `SELECT * FROM public.orders`);
        await refused(
          "ro",
          `INSERT INTO public.orders (note) VALUES ('x')`,
          "read-only transaction",
        );

        // A repeat of the same apply changes nothing and loses nothing.
        await engine.applyDatabases(ctx, [
          {
            name: "legacy",
            action: "create",
            ownerRole: true,
            convertExisting: true,
          },
        ]);
        await engine.applyCredentials(ctx, LOGINS, convertOptions);
        assertEquals(await owners(), "tp_legacy_owner");
        assertEquals(await value(`SELECT count(*) FROM public.orders`), "2");
      } finally {
        await docker(["rm", "-f", name]);
      }
    },
  });
}
