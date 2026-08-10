/**
 * Host-free unit coverage for MySQL standby health parsing and seed script.
 */

import { assertEquals } from "@std/assert";
import {
  buildMysqlStandbySeedScript,
  parseShowReplicaStatus,
  resolveMysqlPrimaryConnectHost,
} from "./mysql.ts";
import { changeReplicationSourceSql } from "./mysql-sql.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const HEALTHY_VERTICAL = `
*************************** 1. row ***************************
             Replica_IO_Running: Yes
            Replica_SQL_Running: Yes
          Seconds_Behind_Source: 3
`;

const UNHEALTHY_VERTICAL = `
*************************** 1. row ***************************
             Replica_IO_Running: No
            Replica_SQL_Running: No
          Seconds_Behind_Source: NULL
`;

test("parseShowReplicaStatus reports streaming + lag from vertical SHOW REPLICA STATUS", () => {
  const healthy = parseShowReplicaStatus(HEALTHY_VERTICAL);
  assertEquals(healthy.state, "streaming");
  assertEquals(healthy.lagSeconds, 3);

  const stopped = parseShowReplicaStatus(UNHEALTHY_VERTICAL);
  assertEquals(stopped.state, "stopped");
  assertEquals(stopped.lagSeconds, undefined);
});

test("resolveMysqlPrimaryConnectHost prefers hostaddr for remote private listener", () => {
  assertEquals(
    resolveMysqlPrimaryConnectHost({
      host: "managed-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      hostaddr: "203.0.113.50",
    }),
    "203.0.113.50",
  );
  assertEquals(
    resolveMysqlPrimaryConnectHost({ host: "svc-1" }),
    "svc-1",
  );

  const sql = changeReplicationSourceSql({
    host: resolveMysqlPrimaryConnectHost({
      host: "managed-id",
      hostaddr: "203.0.113.50",
    }),
    port: 45001,
    username: "tp_repl",
    password: "s3cret",
  });
  assertEquals(sql.includes("SOURCE_HOST = '203.0.113.50'"), true);
  assertEquals(sql.includes("SOURCE_SSL_VERIFY_SERVER_CERT = 1"), true);
});

test("buildMysqlStandbySeedScript registers trap before writing credentials", () => {
  const script = buildMysqlStandbySeedScript();
  const trapIdx = script.indexOf("trap ");
  const catIdx = script.indexOf('cat > "$tmp"');
  assertEquals(trapIdx !== -1, true);
  assertEquals(catIdx !== -1, true);
  assertEquals(trapIdx < catIdx, true);
  assertEquals(script.includes("pipefail"), true);
  assertEquals(script.includes("mysqldump --defaults-extra-file="), true);
});
