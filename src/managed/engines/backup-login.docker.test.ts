/**
 * The backup login's rights against real MySQL and MariaDB servers when Docker
 * is available: the generated grants let `mysqldump` / `mariadb-dump` copy a
 * database with its views, triggers, events and routines, and nothing more
 * (no writes, no other database). Containers are removed afterwards.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { docker, dockerReachable } from "../../testing/docker-run.ts";
import { grantBackupPrivileges } from "./grant-databases.ts";
import {
  createClientAccountSql as mariadbAccountSql,
  grantBackupDatabaseSql as mariadbBackupSql,
} from "./mariadb-sql.ts";
import {
  createClientAccountSql as mysqlAccountSql,
  grantBackupDatabaseSql as mysqlBackupSql,
  grantBackupGlobalSql as mysqlBackupGlobalSql,
} from "./mysql-sql.ts";

const test = Deno.test.bind(Deno);

const ROOT_PASSWORD = ["root", "backup", "fixture"].join("-");
const BACKUP_PASSWORD = ["backup", "fixture", "pw"].join("-");

const ENGINES = [
  {
    image: "mysql:8.4",
    rootEnv: "MYSQL_ROOT_PASSWORD",
    client: "mysql",
    dump: "mysqldump",
    accountSql: mysqlAccountSql,
    grantSql: mysqlBackupSql,
    globalSql: mysqlBackupGlobalSql,
    dumpFlags: ["--set-gtid-purged=OFF"],
  },
  {
    image: "mariadb:11.8",
    rootEnv: "MARIADB_ROOT_PASSWORD",
    client: "mariadb",
    dump: "mariadb-dump",
    accountSql: mariadbAccountSql,
    grantSql: mariadbBackupSql,
    globalSql: undefined,
    dumpFlags: [] as string[],
  },
];

const DOCKER_AVAILABLE = await dockerReachable();
if (!DOCKER_AVAILABLE) {
  console.warn(
    "SKIPPED backup-login.docker.test.ts: Docker is not reachable, so the real MySQL/MariaDB checks did not run.",
  );
}

for (const engine of ENGINES) {
  test({
    name:
      `the backup login dumps a whole database and writes nothing on ${engine.image}`,
    ignore: !DOCKER_AVAILABLE,
    fn: async () => {
      const name = `tp-backup-login-${crypto.randomUUID().slice(0, 8)}`;
      const run = await docker([
        "run",
        "-d",
        "--rm",
        "--name",
        name,
        "-e",
        `${engine.rootEnv}=${ROOT_PASSWORD}`,
        engine.image,
      ]);
      if (!run.success) throw new Error(`docker run failed: ${run.stderr}`);
      // Over the local socket, so the `localhost` account is the one used.
      const as = (user: string, password: string, statement: string) =>
        docker([
          "exec",
          name,
          engine.client,
          `-u${user}`,
          `-p${password}`,
          "-N",
          "-B",
          "-e",
          statement,
        ]);
      const sql = async (statement: string): Promise<string> => {
        const result = await as("root", ROOT_PASSWORD, statement);
        if (!result.success) throw new Error(result.stderr);
        return result.stdout;
      };
      try {
        let ready = false;
        for (let attempt = 0; attempt < 90 && !ready; attempt++) {
          ready = (await as("root", ROOT_PASSWORD, "SELECT 1")).success;
          if (!ready) await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        if (!ready) throw new Error("engine did not become ready");
        await sql(
          "CREATE DATABASE shop; CREATE DATABASE closed; " +
            "CREATE TABLE shop.orders (id INT PRIMARY KEY, total INT); " +
            "INSERT INTO shop.orders VALUES (1, 10), (2, 20); " +
            "CREATE TABLE closed.secret (id INT); " +
            "CREATE VIEW shop.order_total AS SELECT SUM(total) AS t FROM shop.orders; " +
            "CREATE TRIGGER shop.orders_bi BEFORE INSERT ON shop.orders FOR EACH ROW SET NEW.total = NEW.total; " +
            "CREATE EVENT shop.nightly ON SCHEDULE EVERY 1 DAY DO SELECT 1; " +
            "CREATE PROCEDURE shop.order_count() SELECT COUNT(*) FROM shop.orders;",
        );
        const hosts = ["localhost"];
        await sql(engine.accountSql("nightly", BACKUP_PASSWORD, hosts));
        const apply = () =>
          grantBackupPrivileges({
            databases: ["shop"],
            username: "nightly",
            hosts,
            grantSql: engine.grantSql,
            globalSql: engine.globalSql,
            run: sql,
          });
        await apply();
        // A repeated apply is a no-op, not an error.
        await apply();

        const dump = await docker([
          "exec",
          name,
          engine.dump,
          "-unightly",
          `-p${BACKUP_PASSWORD}`,
          "--single-transaction",
          "--no-tablespaces",
          "--routines",
          "--triggers",
          "--events",
          ...engine.dumpFlags,
          "shop",
        ]);
        assertEquals(dump.success, true, dump.stderr);
        assertStringIncludes(dump.stdout, "INSERT INTO `orders` VALUES");
        // MariaDB writes one row per line; MySQL writes them on one line.
        assertStringIncludes(dump.stdout, "(2,20)");
        assertStringIncludes(dump.stdout, "VIEW `order_total`");
        assertStringIncludes(dump.stdout, "TRIGGER");
        assertStringIncludes(dump.stdout, "EVENT `nightly`");
        assertStringIncludes(dump.stdout, "PROCEDURE `order_count`");

        const write = await as(
          "nightly",
          BACKUP_PASSWORD,
          "INSERT INTO shop.orders VALUES (3, 30)",
        );
        assertEquals(write.success, false, "the backup login must not write");
        const other = await as(
          "nightly",
          BACKUP_PASSWORD,
          "SELECT * FROM closed.secret",
        );
        assertEquals(other.success, false, "an unlisted database stays closed");
        const accounts = await as(
          "nightly",
          BACKUP_PASSWORD,
          "SELECT COUNT(*) FROM mysql.user",
        );
        assertEquals(accounts.success, false, "the account table stays closed");
      } finally {
        await docker(["rm", "-f", name]);
      }
    },
  });
}
