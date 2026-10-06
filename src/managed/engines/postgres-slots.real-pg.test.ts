import { assertEquals } from "@std/assert";
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
 * The cut-off replica path against a REAL Postgres server, one throwaway
 * container per series (no published port; removed afterwards): a replica
 * slot is invalidated by a small `max_slot_wal_keep_size`, later applies must
 * not hide it, the replacement slot must not make the primary hold WAL again,
 * and a re-seed through `pg_basebackup -S` must clear it.
 *
 * Runs when Docker answers and either `CI` or `TURBOPANEL_REAL_POSTGRES=1` is
 * set (skipped otherwise, so a plain local `deno test` stays offline).
 * `TURBOPANEL_REQUIRE_REAL_POSTGRES=1` turns a container that cannot start
 * into a failure. `TURBOPANEL_REAL_POSTGRES_SERIES` (comma separated majors)
 * overrides the default `16,18`.
 */
const SERIES = (Deno.env.get("TURBOPANEL_REAL_POSTGRES_SERIES") ?? "16,18")
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

async function admin(name: string, sql: string): Promise<string> {
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
  ], sql);
  assertEquals(run.success, true, run.stderr);
  return run.stdout.trim();
}

/** Write well past the 32 MB slot cap and let checkpoints remove the WAL. */
async function churnWal(name: string): Promise<void> {
  await admin(
    name,
    `CREATE TABLE IF NOT EXISTS churn (g int, pad text);
     INSERT INTO churn SELECT g, repeat('x', 200) FROM generate_series(1, 600000) g;
     CHECKPOINT; SELECT pg_switch_wal(); CHECKPOINT; CHECKPOINT;`,
  );
}

for (const series of SERIES) {
  test({
    name:
      `real Postgres ${series}: a cut-off replica stays reported until it is re-seeded`,
    ignore: !dockerUp,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const name = `tp-slots-pg${series}-${crypto.randomUUID().slice(0, 8)}`;
      const started = await docker([
        "run",
        "-d",
        "--rm",
        "--name",
        name,
        "-e",
        "POSTGRES_HOST_AUTH_METHOD=trust",
        `postgres:${series}`,
        "-c",
        "max_slot_wal_keep_size=32MB",
        "-c",
        "max_wal_size=64MB",
        "-c",
        "min_wal_size=32MB",
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
        const ctx: ManagedEngineContext = {
          containerId: name,
          composeServiceName: "postgres",
          rootUsername: "postgres",
          defaultDatabase: "postgres",
          exec: (argv, input) => docker(["exec", "-i", name, ...argv], input),
        };
        const replication = postgresManagedEngineRuntime.replication!;
        const spec = {
          username: "tp_repl",
          password: ["tp", crypto.randomUUID()].join("-"),
          desiredSlots: ["tp_member_a"],
        };
        const retention = async () =>
          (await replication.readHealth(ctx, "primary")).slotRetention;
        const slotRow = () =>
          admin(
            name,
            `SELECT active, COALESCE(wal_status, 'none'), restart_lsn IS NULL FROM pg_replication_slots WHERE slot_name = 'tp_member_a'`,
          );

        // A healthy slot, then a replica that never comes back.
        await replication.ensurePrimary!(ctx, spec);
        assertEquals(await retention(), { state: "ok" });
        await churnWal(name);
        assertEquals((await retention())?.state, "critical");
        assertEquals((await retention())?.walStatus, "lost");

        // The next apply replaces the lost slot; the cut-off must still show,
        // and the replacement must not hold WAL while the replica is away.
        await replication.ensurePrimary!(ctx, spec);
        const replaced = await retention();
        assertEquals(replaced?.state, "critical");
        assertEquals(replaced?.walStatus, "awaiting_resync");
        assertEquals(replaced?.retainedBytes, 0);
        await churnWal(name);
        await replication.ensurePrimary!(ctx, spec);
        assertEquals((await retention())?.walStatus, "awaiting_resync");
        assertEquals(await slotRow(), "f|none|t");

        // A slot that merely resembles the managed prefix is not ours.
        await admin(
          name,
          `SELECT pg_create_physical_replication_slot('tpxmemberxother')`,
        );
        await replication.pruneOrphanSlots!(ctx, ["tp_member_a"]);
        assertEquals(
          await admin(
            name,
            `SELECT count(*) FROM pg_replication_slots WHERE slot_name = 'tpxmemberxother'`,
          ),
          "1",
        );

        // The Resync: a real base backup through the replacement slot.
        const seeded = await docker([
          "exec",
          name,
          "pg_basebackup",
          "-h",
          "127.0.0.1",
          "-U",
          "postgres",
          "-D",
          "/tmp/reseed",
          "-X",
          "stream",
          "-S",
          "tp_member_a",
        ]);
        assertEquals(seeded.success, true, seeded.stderr);
        assertEquals(await retention(), { state: "ok" });
      } finally {
        await docker(["rm", "-f", name]);
      }
    },
  });
}
