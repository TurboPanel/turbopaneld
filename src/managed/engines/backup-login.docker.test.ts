/**
 * The backup login's rights against real MySQL and MariaDB servers when Docker
 * is available: the generated grants let `mysqldump` / `mariadb-dump` copy a
 * database with its views, triggers, events and routines, including a
 * database made later with plain SQL, and nothing more (no writes, no
 * creating or dropping tables or databases). MySQL runs with GTIDs on, as a
 * managed server does, and dumps with the standard flags: that is when
 * `mysqldump` needs `FLUSH_TABLES`. Containers are removed afterwards.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { docker, dockerReachable } from "../../testing/docker-run.ts";
import { grantBackupPrivileges } from "./grant-databases.ts";
import {
  createClientAccountSql as mariadbAccountSql,
  grantBackupSql as mariadbBackupSql,
} from "./mariadb-sql.ts";
import {
  createClientAccountSql as mysqlAccountSql,
  grantBackupSql as mysqlBackupSql,
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
    serverArgs: ["--gtid-mode=ON", "--enforce-gtid-consistency=ON"],
    // The server orders static rights its own way and lists dynamic ones on
    // a line of their own.
    grants: [
      "GRANT SELECT, SHOW VIEW, EVENT, TRIGGER ON *.* TO `nightly`@`localhost`",
      "GRANT FLUSH_TABLES,SHOW_ROUTINE ON *.* TO `nightly`@`localhost`",
    ],
  },
  {
    image: "mariadb:11.8",
    rootEnv: "MARIADB_ROOT_PASSWORD",
    client: "mariadb",
    dump: "mariadb-dump",
    accountSql: mariadbAccountSql,
    grantSql: mariadbBackupSql,
    serverArgs: [] as string[],
    grants: [
      "GRANT SELECT, LOCK TABLES, SHOW VIEW, EVENT, TRIGGER, SHOW CREATE ROUTINE ON *.* TO `nightly`@`localhost`",
    ],
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
      const name = `tp-bk-login-${crypto.randomUUID().slice(0, 8)}`;
      const run = await docker([
        "run",
        "-d",
        "--rm",
        "--name",
        name,
        "-e",
        `${engine.rootEnv}=${ROOT_PASSWORD}`,
        engine.image,
        ...engine.serverArgs,
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
        // Over TCP: the image's first-start server listens on the socket
        // only and is restarted afterwards, so a socket answer can come from
        // the server that is about to go away.
        const probe = () =>
          docker([
            "exec",
            name,
            engine.client,
            "--protocol=TCP",
            "-h127.0.0.1",
            "-uroot",
            `-p${ROOT_PASSWORD}`,
            "-e",
            "SELECT 1",
          ]);
        let ready = false;
        for (let attempt = 0; attempt < 90 && !ready; attempt++) {
          ready = (await probe()).success;
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
            username: "nightly",
            hosts,
            grantSql: engine.grantSql,
            run: sql,
          });
        await apply();
        // A repeated apply is a no-op, not an error.
        await apply();

        // A database made with plain SQL after the grant is covered too.
        await sql(
          "CREATE DATABASE later_db; " +
            "CREATE TABLE later_db.notes (id INT PRIMARY KEY); " +
            "INSERT INTO later_db.notes VALUES (7);",
        );
        const dumpAs = (database: string) =>
          docker([
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
            database,
          ]);
        const dump = await dumpAs("shop");
        assertEquals(dump.success, true, dump.stderr);
        assertStringIncludes(dump.stdout, "INSERT INTO `orders` VALUES");
        // MariaDB writes one row per line; MySQL writes them on one line.
        assertStringIncludes(dump.stdout, "(2,20)");
        assertStringIncludes(dump.stdout, "VIEW `order_total`");
        assertStringIncludes(dump.stdout, "TRIGGER");
        assertStringIncludes(dump.stdout, "EVENT `nightly`");
        assertStringIncludes(dump.stdout, "PROCEDURE `order_count`");
        const later = await dumpAs("later_db");
        assertEquals(later.success, true, later.stderr);
        assertStringIncludes(later.stdout, "INSERT INTO `notes` VALUES");
        assertStringIncludes(later.stdout, "(7)");

        for (
          const statement of [
            "INSERT INTO shop.orders VALUES (3, 30)",
            "UPDATE later_db.notes SET id = 8",
            "DELETE FROM shop.orders",
            "CREATE TABLE shop.extra (id INT)",
            "DROP TABLE later_db.notes",
            "CREATE DATABASE made_by_backup",
            "CREATE USER other_login",
            "FLUSH PRIVILEGES",
          ]
        ) {
          const refused = await as("nightly", BACKUP_PASSWORD, statement);
          assertEquals(
            refused.success,
            false,
            `the backup login must not run: ${statement}`,
          );
          assertStringIncludes(refused.stderr.toLowerCase(), "denied");
        }

        // The documented scope includes the `mysql` schema: the account rows
        // a full restore needs.
        const accounts = await as(
          "nightly",
          BACKUP_PASSWORD,
          "SELECT host FROM mysql.user WHERE user = 'nightly' AND host = 'localhost'",
        );
        assertEquals(accounts.success, true, accounts.stderr);
        assertEquals(accounts.stdout.trim(), "localhost");

        // Exactly the intended rights, nothing an earlier step left behind.
        // MariaDB appends the password hash to its grant line.
        const grants = (await sql("SHOW GRANTS FOR nightly@localhost"))
          .trim()
          .split("\n")
          .map((line) => line.replace(/ IDENTIFIED BY PASSWORD '[^']*'$/, ""));
        assertEquals(grants, engine.grants);

        if (engine.image.startsWith("mysql:")) {
          // Without FLUSH_TABLES the dump stops at its global read lock.
          await sql("REVOKE FLUSH_TABLES ON *.* FROM nightly@localhost");
          const blocked = await dumpAs("shop");
          assertEquals(blocked.success, false, "dump without FLUSH_TABLES");
          assertStringIncludes(blocked.stderr, "(1227)");
        }
      } finally {
        await docker(["rm", "-f", name]);
      }
    },
  });
}
