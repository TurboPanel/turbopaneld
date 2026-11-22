/**
 * The migration login (`owner`) against real MySQL and MariaDB servers when
 * Docker is available: it can create tables, indexes, views and triggers in
 * its database (one name holds an underscore, which a grant reads as a
 * pattern unless escaped), and not in another database. A session opened
 * while the login held read-write rights keeps them until it is ended, so the
 * apply ends it when the rights change; a pooled proxy connection would
 * otherwise answer `CREATE TABLE` with error 1142 after the login became owner.
 * Containers are removed afterwards.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { docker, dockerReachable } from "../../testing/docker-run.ts";
import {
  endSessionsWhenRightsChange,
  grantDatabasePrivileges,
  revokeUnlistedGrants,
} from "./grant-databases.ts";
import * as mariadbSql from "./mariadb-sql.ts";
import * as mysqlSql from "./mysql-sql.ts";

const test = Deno.test.bind(Deno);

const ROOT_PASSWORD = ["root", "owner", "fixture"].join("-");
const LOGIN_PASSWORD = ["owner", "fixture", "pw"].join("-");

const ENGINES = [
  {
    image: "mysql:8.4",
    rootEnv: "MYSQL_ROOT_PASSWORD",
    client: "mysql",
    dialect: mysqlSql,
    // MySQL with binary logging on refuses a trigger from a login without
    // SUPER (error 1419), whatever its database rights.
    trigger: "",
  },
  {
    image: "mariadb:11.8",
    rootEnv: "MARIADB_ROOT_PASSWORD",
    client: "mariadb",
    dialect: mariadbSql,
    trigger: "CREATE TRIGGER migrations_bi BEFORE INSERT ON migrations " +
      "FOR EACH ROW SET NEW.batch = 1; ",
  },
];

const DOCKER_AVAILABLE = await dockerReachable();
if (!DOCKER_AVAILABLE) {
  console.warn(
    "SKIPPED owner-grants.docker.test.ts: Docker is not reachable, so the real MySQL/MariaDB checks did not run.",
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

for (const engine of ENGINES) {
  test({
    name:
      `the owner login creates tables in its database and ends stale sessions on ${engine.image}`,
    ignore: !DOCKER_AVAILABLE,
    fn: async () => {
      const name = `tp-owner-grants-${crypto.randomUUID().slice(0, 8)}`;
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
      const exec = (user: string, password: string, statement: string) =>
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
        const result = await exec("root", ROOT_PASSWORD, statement);
        if (!result.success) throw new Error(result.stderr);
        return result.stdout;
      };
      const d = engine.dialect;
      // Over the local socket, so the `localhost` account is the one used.
      const hosts = ["localhost"];
      const apply = (privilege: string, listed: string[]) =>
        endSessionsWhenRightsChange({
          username: "mig",
          snapshotSql: d.snapshotGrantsSql,
          listConnectionsSql: d.listConnectionsSql,
          query: sql,
          run: sql,
        }, async () => {
          await grantDatabasePrivileges({
            databases: listed,
            privileges: [privilege],
            username: "mig",
            hosts,
            grantSql: d.grantDatabaseSql,
            revokePlainSql: d.revokePlainDatabaseGrantSql,
            run: sql,
          });
          await revokeUnlistedGrants({
            username: "mig",
            listed,
            listRowsSql: d.listGrantRowsSql,
            revokeRowsSql: d.revokeRowsSql,
            listConnectionsSql: d.listConnectionsSql,
            query: sql,
            run: sql,
          });
          await sql("FLUSH PRIVILEGES;");
        });
      try {
        let ready = false;
        for (let attempt = 0; attempt < 90 && !ready; attempt++) {
          ready = (await docker([
            "exec",
            name,
            engine.client,
            "--protocol=TCP",
            "-h127.0.0.1",
            "-uroot",
            `-p${ROOT_PASSWORD}`,
            "-e",
            "SELECT 1",
          ])).success;
          if (!ready) await sleep(1000);
        }
        if (!ready) throw new Error("engine did not become ready");
        // `wp_site` is what `wpXsite` would match as a pattern.
        await sql(
          [
            d.createDatabaseSql("wp_site"),
            d.createDatabaseSql("wpXsite"),
            d.createClientAccountSql("mig", LOGIN_PASSWORD, hosts),
          ].join("\n"),
        );

        // First apply as read-write: a session opened now stays open.
        await apply("read-write", ["wp_site"]);
        const stale = docker([
          "exec",
          name,
          engine.client,
          "-umig",
          `-p${LOGIN_PASSWORD}`,
          "wp_site",
          "-e",
          "SELECT 1; DO SLEEP(6); CREATE TABLE migrations (id INT);",
        ]);
        await sleep(2000);

        // The same login becomes owner: the open session is ended, so it
        // never gets to run (or fail) the CREATE with its old rights.
        await apply("owner", ["wp_site"]);
        const old = await stale;
        assertEquals(old.success, false);
        assertEquals(old.stderr.includes("1142"), false, old.stderr);

        // A new session has the full set in its own database.
        const create = await exec(
          "mig",
          LOGIN_PASSWORD,
          "USE wp_site; CREATE TABLE migrations (id INT PRIMARY KEY, batch INT); " +
            "CREATE INDEX migrations_batch ON migrations (batch); " +
            "CREATE VIEW migration_batches AS SELECT batch FROM migrations; " +
            engine.trigger +
            "ALTER TABLE migrations ADD COLUMN migration VARCHAR(20); " +
            "DROP VIEW migration_batches; DROP TABLE migrations;",
        );
        assertEquals(create.success, true, create.stderr);

        // Not in a database whose name only matches the pattern, and no
        // grant option.
        const other = await exec(
          "mig",
          LOGIN_PASSWORD,
          "CREATE TABLE wpXsite.t (id INT)",
        );
        assertEquals(other.success, false);
        assertStringIncludes(other.stderr.toLowerCase(), "denied");
        // One exact (escaped) row per account host and nothing on the
        // pattern's other match.
        const rows = await sql(
          "SELECT COUNT(*), MIN(Create_priv), MAX(Grant_priv) FROM mysql.db " +
            "WHERE User = 'mig' AND Db = 'wp\\\\_site'",
        );
        assertEquals(rows.trim(), "2\tY\tN");
        const all = await sql(
          "SELECT COUNT(*) FROM mysql.db WHERE User = 'mig'",
        );
        assertEquals(all.trim(), "2");
      } finally {
        await docker(["rm", "-f", "-v", name]);
      }
    },
  });
}
