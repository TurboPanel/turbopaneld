/**
 * Runs the real MySQL standby seed script against throwaway containers when
 * Docker is available: the import has to work while `read_only` stays ON (only
 * `super_read_only` is lifted), and an account without SUPER must be refused
 * for the whole seed. A server that has run two UUIDs must also print a final
 * GTID set that the daemon accepts. Containers and the network are removed
 * afterwards.
 */

import { assertEquals } from "@std/assert";
import { docker, dockerReachable } from "../../testing/docker-run.ts";
import { waitFor } from "../../testing/wait-for.ts";
import { boundedGtid } from "./replica-freshness.ts";
import { buildMysqlStandbySeedScript } from "./mysql.ts";
import { primaryFinalGtidSetSql, seedWindowReadOnlySql } from "./mysql-sql.ts";
import { execStandbySeed, formatStandbySeedFailure } from "./standby-probe.ts";
import type { ManagedEngineContext } from "./types.ts";

const test = Deno.test.bind(Deno);

const IMAGE = "mysql:9.7";
const ROW_VALUE = ["row", "value", "fixture"].join("-");
const USER_PASSWORD = ["seed", "user", "fixture"].join("-");

const DOCKER_AVAILABLE = await dockerReachable();
if (!DOCKER_AVAILABLE) {
  console.warn(
    "SKIPPED mysql-seed.docker.test.ts: Docker is not reachable, so the real MySQL seed check did not run.",
  );
}

function sql(name: string, statement: string, user = "root") {
  return docker([
    "exec",
    name,
    "mysql",
    "--protocol=socket",
    `-u${user}`,
    ...(user === "root" ? [] : [`-p${USER_PASSWORD}`]),
    "-N",
    "-B",
    "-e",
    statement,
  ]);
}

async function startServer(
  name: string,
  network: string,
  serverId: number,
): Promise<void> {
  const run = await docker([
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "--network",
    network,
    "-e",
    "MYSQL_ALLOW_EMPTY_PASSWORD=1",
    IMAGE,
    `--server-id=${serverId}`,
    "--gtid-mode=ON",
    "--enforce-gtid-consistency=ON",
    "--log-bin=mysql-bin",
  ]);
  if (!run.success) throw new Error(`docker run failed: ${run.stderr}`);
  await waitFor(
    `${name} to accept logins`,
    async () => (await sql(name, "SELECT 1")).success,
    { timeoutMs: 180_000, intervalMs: 1_000 },
  );
}

test({
  name:
    "the MySQL seed imports with read_only on and refuses accounts without SUPER, and a two-UUID final set is readable",
  ignore: !DOCKER_AVAILABLE,
  fn: async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const network = `tp-myseed-net-${suffix}`;
    const primary = `tp-myseed-primary-${suffix}`;
    const standby = `tp-myseed-standby-${suffix}`;
    await docker(["network", "create", network]);
    try {
      await startServer(primary, network, 1);
      await startServer(standby, network, 2);
      const setup = await sql(
        primary,
        "CREATE DATABASE shop; CREATE TABLE shop.t (id INT, note VARCHAR(80)); " +
          `INSERT INTO shop.t VALUES (1, '${ROW_VALUE}'); ` +
          `CREATE USER 'seed_u'@'%' IDENTIFIED BY '${USER_PASSWORD}'; ` +
          "GRANT ALL ON shop.* TO 'seed_u'@'%';",
      );
      assertEquals(setup.success, true, setup.stderr);

      // A server that has run two UUIDs: the final set has a newline in it.
      const purged = await sql(
        primary,
        "SET GLOBAL gtid_purged = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa:1-5'",
      );
      assertEquals(purged.success, true, purged.stderr);
      const final = await sql(primary, primaryFinalGtidSetSql());
      assertEquals(final.success, true, final.stderr);
      assertEquals(final.stdout.includes("\\n"), false, final.stdout);
      assertEquals(boundedGtid(final.stdout) !== undefined, true, final.stdout);

      const window = await sql(standby, seedWindowReadOnlySql());
      assertEquals(window.success, true, window.stderr);
      const ctx = {
        rootUsername: "root",
        exec: (argv: string[], input?: string) =>
          docker(["exec", "-i", standby, ...argv], input),
      } as unknown as ManagedEngineContext;
      const defaults = `[client]\nuser=root\nhost=${primary}\nport=3306\n`;
      const seed = await execStandbySeed(
        ctx,
        buildMysqlStandbySeedScript,
        defaults,
      );
      assertEquals(seed.success, true, formatStandbySeedFailure(seed));

      const rows = await sql(standby, "SELECT note FROM shop.t WHERE id=1");
      assertEquals(rows.stdout.trim(), ROW_VALUE);

      // The seed brought the account over; it still cannot write here.
      const flush = await sql(standby, "FLUSH PRIVILEGES");
      assertEquals(flush.success, true, flush.stderr);
      const refused = await sql(
        standby,
        "INSERT INTO shop.t VALUES (2, 'x')",
        "seed_u",
      );
      assertEquals(refused.success, false);
      assertEquals(
        `${refused.stderr}${refused.stdout}`.includes("--read-only"),
        true,
        refused.stderr,
      );
    } finally {
      await docker(["rm", "-f", primary, standby]);
      await docker(["network", "rm", network]);
    }
  },
});
