/**
 * Real-container proof of the planned-switchover final position.
 *
 * Needs a local Docker engine and the `postgres:18` image (pulled on first
 * use). Everything it creates (network, volumes, containers) is named with a
 * per-run suffix and removed at the end. Skipped when Docker is not reachable.
 *
 * What it proves, on a real primary with a streaming standby under write load:
 * after a clean stop the position the daemon reports (computed end of the
 * shutdown record) equals the standby's `pg_last_wal_replay_lsn()` once it has
 * caught up, `pg_controldata`'s own checkpoint location does not, a paused
 * standby is still behind the reported position, and the promote reports the
 * same position and the next timeline.
 */
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { waitFor } from "../../testing/wait-for.ts";
import { formatLsn, parseLsn } from "./postgres-wal.ts";
import { getManagedEngineRuntime } from "./index.ts";
import type { ManagedEngineContext } from "./types.ts";

const IMAGE = "postgres:18";
const DATA = "/var/lib/postgresql/data";
const test = Deno.test.bind(Deno);

type Result = {
  success: boolean;
  stdout: string;
  stderr: string;
  code: number;
};

async function docker(args: string[], stdin?: string): Promise<Result> {
  const child = new Deno.Command("docker", {
    args,
    stdin: stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (stdin !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdin));
    await writer.close();
  }
  const out = await child.output();
  return {
    success: out.success,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
    code: out.code,
  };
}

async function dockerReachable(): Promise<boolean> {
  try {
    return (await docker(["info", "--format", "{{.ServerVersion}}"])).success;
  } catch {
    return false;
  }
}

async function ok(args: string[], stdin?: string): Promise<string> {
  const result = await docker(args, stdin);
  assert(result.success, `docker ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

async function scalar(container: string, sql: string): Promise<string> {
  return (await ok(["exec", container, "psql", "-U", "postgres", "-Atc", sql]))
    .trim();
}

const available = await dockerReachable();

test({
  name:
    "final position of a cleanly stopped primary equals the caught-up standby replay position",
  ignore: !available,
  fn: async () => {
    const suffix = String(Deno.pid);
    const net = `tpfp-net-${suffix}`;
    const primary = `tpfp-p-${suffix}`;
    const standby = `tpfp-s-${suffix}`;
    const primaryVolume = `tpfp-pv-${suffix}`;
    const standbyVolume = `tpfp-sv-${suffix}`;
    try {
      await ok(["network", "create", net]);
      await ok(["volume", "create", primaryVolume]);
      await ok(["volume", "create", standbyVolume]);
      await ok([
        "run",
        "-d",
        "--name",
        primary,
        "--network",
        net,
        "-e",
        "POSTGRES_PASSWORD=pw",
        "-e",
        `PGDATA=${DATA}`,
        "-v",
        `${primaryVolume}:/var/lib/postgresql`,
        IMAGE,
        "-c",
        "wal_level=replica",
        "-c",
        "max_wal_senders=5",
      ]);
      // The image first runs a setup server on the socket only, stops it, and
      // then starts the real one. Only the real one listens on TCP, so asking
      // over TCP waits past the setup server instead of racing its shutdown.
      await waitFor(
        "primary ready",
        async () =>
          (await docker([
            "exec",
            primary,
            "pg_isready",
            "-q",
            "-h",
            "127.0.0.1",
          ])).success,
        { timeoutMs: 90_000, intervalMs: 500 },
      );
      await waitFor(
        "primary accepts queries",
        async () =>
          (await docker([
            "exec",
            primary,
            "psql",
            "-U",
            "postgres",
            "-Atc",
            "select 1",
          ])).success,
        { timeoutMs: 60_000, intervalMs: 500 },
      );
      await ok([
        "exec",
        primary,
        "psql",
        "-U",
        "postgres",
        "-qc",
        "create role repl replication login password 'pw'",
      ]);
      await ok([
        "exec",
        primary,
        "bash",
        "-c",
        `echo "host replication repl all scram-sha-256" >> ${DATA}/pg_hba.conf`,
      ]);
      await ok([
        "exec",
        primary,
        "psql",
        "-U",
        "postgres",
        "-qc",
        "select pg_reload_conf()",
      ]);
      await ok([
        "run",
        "--rm",
        "--user",
        "root",
        "--network",
        net,
        "-e",
        "PGPASSWORD=pw",
        "-v",
        `${standbyVolume}:/var/lib/postgresql`,
        IMAGE,
        "bash",
        "-c",
        `chown postgres /var/lib/postgresql && gosu postgres pg_basebackup -h ${primary} -U repl -D ${DATA} -R -X stream -c fast`,
      ]);
      await ok([
        "run",
        "-d",
        "--name",
        standby,
        "--network",
        net,
        "-e",
        "POSTGRES_PASSWORD=pw",
        "-e",
        `PGDATA=${DATA}`,
        "-v",
        `${standbyVolume}:/var/lib/postgresql`,
        IMAGE,
      ]);
      await waitFor(
        "standby in recovery",
        async () =>
          (await docker([
            "exec",
            standby,
            "psql",
            "-U",
            "postgres",
            "-Atc",
            "select pg_is_in_recovery()",
          ])).stdout.trim() === "t",
        { timeoutMs: 90_000, intervalMs: 500 },
      );

      await ok([
        "exec",
        primary,
        "pgbench",
        "-U",
        "postgres",
        "-i",
        "-s",
        "2",
        "-q",
        "postgres",
      ]);
      // Replay paused so the standby is provably behind while the primary writes.
      await ok([
        "exec",
        standby,
        "psql",
        "-U",
        "postgres",
        "-qc",
        "select pg_wal_replay_pause()",
      ]);
      await ok([
        "exec",
        "-d",
        primary,
        "pgbench",
        "-U",
        "postgres",
        "-c",
        "4",
        "-j",
        "2",
        "-T",
        "600",
        "postgres",
      ]);
      await waitFor(
        "write load running",
        async () =>
          Number(
            await scalar(primary, "select count(*) from pgbench_history"),
          ) >= 300,
        { timeoutMs: 90_000, intervalMs: 250 },
      );

      // A clean stop: fast shutdown (the image's stop signal) with a long grace period.
      await ok(["stop", "-t", "120", primary]);
      const state = await ok([
        "run",
        "--rm",
        "-e",
        "LC_ALL=C",
        "-v",
        `${primaryVolume}:/var/lib/postgresql`,
        IMAGE,
        "pg_controldata",
        DATA,
      ]);
      assert(
        /Database cluster state:\s+shut down\s*$/m.test(state),
        `not a clean shutdown:\n${state}`,
      );
      const checkpoint =
        /Latest checkpoint location:\s+(\S+)/.exec(state)?.[1] ?? "";

      const runtime = getManagedEngineRuntime("postgres");
      const final = await runtime.replication!.readStoppedPrimaryFinalPosition!(
        {
          image: IMAGE,
          volumes: [{ name: primaryVolume, target: "/var/lib/postgresql" }],
          containerUser: runtime.containerUser,
          runDocker: async (argv) => {
            const r = await docker(argv);
            return {
              success: r.success,
              stdout: r.stdout,
              stderr: r.stderr,
              code: r.code,
            };
          },
        },
      );
      assert(final !== null, "the daemon reported no final position");
      assertEquals(final.timeline, 1);
      // pg_controldata's checkpoint location is where the shutdown record starts, not where the WAL ends.
      assertNotEquals(final.lsn, checkpoint);
      assert(parseLsn(final.lsn)! > parseLsn(checkpoint)!);

      // Paused standby: everything received, not replayed, so it is behind the reported end.
      await waitFor("standby received the final position", async () => {
        const received = await scalar(
          standby,
          "select pg_last_wal_receive_lsn()",
        );
        return parseLsn(received) !== null &&
          parseLsn(received)! >= parseLsn(final.lsn)!;
      }, { timeoutMs: 60_000, intervalMs: 250 });
      const paused = parseLsn(
        await scalar(standby, "select pg_last_wal_replay_lsn()"),
      )!;
      assert(
        paused < parseLsn(final.lsn)!,
        "a paused standby must be behind the final position",
      );

      await ok([
        "exec",
        standby,
        "psql",
        "-U",
        "postgres",
        "-qc",
        "select pg_wal_replay_resume()",
      ]);
      // Compared as numbers: pg_lsn text may be zero padded on newer releases.
      const replayed = async () =>
        parseLsn(await scalar(standby, "select pg_last_wal_replay_lsn()"));
      await waitFor(
        "standby replayed to the final position",
        async () => (await replayed()) === parseLsn(final.lsn),
        { timeoutMs: 60_000, intervalMs: 250 },
      );
      assertEquals(await replayed(), parseLsn(final.lsn));

      // Promote and read the position the new primary reports.
      await ok([
        "exec",
        standby,
        "psql",
        "-U",
        "postgres",
        "-Atc",
        "select pg_promote(true, 60)",
      ]);
      await waitFor(
        "standby promoted",
        async () =>
          (await scalar(standby, "select pg_is_in_recovery()")) === "f",
        { timeoutMs: 60_000, intervalMs: 250 },
      );
      const ctx: ManagedEngineContext = {
        containerId: standby,
        composeServiceName: "postgres",
        rootUsername: "postgres",
        defaultDatabase: "postgres",
        exec: async (argv, input) => {
          const r = await docker(["exec", "-i", standby, ...argv], input ?? "");
          return { success: r.success, stdout: r.stdout, stderr: r.stderr };
        },
      };
      const promoted = await runtime.replication!.readPromotedPosition!(ctx);
      assertEquals(promoted, { lsn: final.lsn, timeline: final.timeline + 1 });
      assertEquals(formatLsn(parseLsn(promoted!.lsn)!), final.lsn);
    } finally {
      for (const container of [primary, standby]) {
        await docker(["rm", "-f", container]);
      }
      for (const volume of [primaryVolume, standbyVolume]) {
        await docker(["volume", "rm", "-f", volume]);
      }
      await docker(["network", "rm", net]);
    }
  },
});
