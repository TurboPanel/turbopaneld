/**
 * Runs the real standby seed script (dump from a primary, import into an
 * empty standby) against throwaway MariaDB containers when Docker is
 * available. Containers and the network are removed afterwards.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { docker, dockerReachable } from "../../testing/docker-run.ts";
import { waitFor } from "../../testing/wait-for.ts";
import { buildMariadbStandbySeedScript } from "./mariadb.ts";
import { execStandbySeed, formatStandbySeedFailure } from "./standby-probe.ts";
import type { ManagedEngineContext } from "./types.ts";

const test = Deno.test.bind(Deno);

const ROOT_PASSWORD = ["seed", "root", "fixture"].join("-");
const SEED_USER_PASSWORD = ["seed", "user", "fixture"].join("-");
const SECRET_ROW_VALUE = ["row", "value", "must", "not", "leak"].join("-");
const IMAGES = ["mariadb:11.8", "mariadb:12.3"];

const DOCKER_AVAILABLE = await dockerReachable();
if (!DOCKER_AVAILABLE) {
  console.warn(
    "SKIPPED mariadb-seed.docker.test.ts: Docker is not reachable, so the real MariaDB seed check did not run.",
  );
}

async function startServer(
  image: string,
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
    `MARIADB_ROOT_PASSWORD=${ROOT_PASSWORD}`,
    image,
    `--server-id=${serverId}`,
    "--log-bin=mysql-bin",
  ]);
  if (!run.success) throw new Error(`docker run failed: ${run.stderr}`);
  await waitFor(
    `${name} to accept TCP logins`,
    async () => (await sql(name, "SELECT 1")).success,
    {
      timeoutMs: 120_000,
      intervalMs: 500,
    },
  );
}

function sql(name: string, statement: string) {
  return docker([
    "exec",
    name,
    "mariadb",
    "--protocol=tcp",
    "-h127.0.0.1",
    "-uroot",
    `-p${ROOT_PASSWORD}`,
    "-N",
    "-B",
    "-e",
    statement,
  ]);
}

for (
  const [image, readOnly] of IMAGES.flatMap((
    image,
  ) => [[image, false], [image, true]] as const)
) {
  test({
    name:
      `the standby seed script copies a primary into an empty standby on ${image}${
        readOnly ? " that stays read-only" : ""
      }`,
    ignore: !DOCKER_AVAILABLE,
    fn: async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const network = `tp-seed-net-${suffix}`;
      const primary = `tp-seed-primary-${suffix}`;
      const standby = `tp-seed-standby-${suffix}`;
      await docker(["network", "create", network]);
      try {
        await startServer(image, primary, network, 1);
        await startServer(image, standby, network, 2);
        const setup = await sql(
          primary,
          "CREATE DATABASE shop; CREATE TABLE shop.t (id INT, note VARCHAR(80)); " +
            `INSERT INTO shop.t VALUES (1, '${SECRET_ROW_VALUE}'); ` +
            `CREATE USER 'seed_u'@'%' IDENTIFIED BY '${SEED_USER_PASSWORD}';`,
        );
        assertEquals(setup.success, true, setup.stderr);

        if (readOnly) {
          // Read-only before and during the whole seed, the way the platform
          // config boots a standby: the socket admin imports through it.
          const lock = await sql(standby, "SET GLOBAL read_only = ON");
          assertEquals(lock.success, true, lock.stderr);
        }

        const ctx = {
          rootUsername: "root",
          socketPassword: ROOT_PASSWORD,
          exec: (argv: string[], input?: string) =>
            docker(["exec", "-i", standby, ...argv], input),
        } as unknown as ManagedEngineContext;
        const defaults = `[client]\nuser=root\npassword=${ROOT_PASSWORD}\n` +
          `host=${primary}\nport=3306\n`;

        const seed = await execStandbySeed(
          ctx,
          buildMariadbStandbySeedScript,
          defaults,
        );
        assertEquals(seed.success, true, formatStandbySeedFailure(seed));

        const rows = await sql(standby, "SELECT note FROM shop.t WHERE id=1");
        assertEquals(rows.stdout.trim(), SECRET_ROW_VALUE);
        const user = await sql(
          standby,
          "SELECT COUNT(*) FROM mysql.user WHERE user='seed_u'",
        );
        assertEquals(user.stdout.trim(), "1");
        if (readOnly) {
          const flag = await sql(standby, "SELECT @@GLOBAL.read_only");
          assertEquals(["1", "ON"].includes(flag.stdout.trim()), true);
        }

        // A failing seed (primary unreachable) reports both exit codes.
        const bad = await execStandbySeed(
          ctx,
          buildMariadbStandbySeedScript,
          defaults.replace(`host=${primary}`, "host=tp-no-such-host"),
        );
        assertEquals(bad.success, false);
        assertStringIncludes(
          `${bad.stderr}\n${bad.stdout}`,
          "dump_exit=",
        );
      } finally {
        await docker(["rm", "-f", primary, standby]);
        await docker(["network", "rm", network]);
      }
    },
  });
}
