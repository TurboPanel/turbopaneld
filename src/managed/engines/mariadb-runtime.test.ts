/**
 * Host-free unit coverage for MariaDB standby health parsing and seed script.
 */

import { assertEquals } from "@std/assert";
import {
  buildMariadbStandbySeedScript,
  parseShowSlaveStatus,
  resolveMariadbPrimaryConnectHost,
} from "./mariadb.ts";
import { changeReplicationSourceSql } from "./mariadb-sql.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const HEALTHY_VERTICAL = `
*************************** 1. row ***************************
               Slave_IO_Running: Yes
              Slave_SQL_Running: Yes
        Seconds_Behind_Master: 7
`;

const UNHEALTHY_VERTICAL = `
*************************** 1. row ***************************
               Slave_IO_Running: Connecting
              Slave_SQL_Running: Yes
        Seconds_Behind_Master: NULL
`;

test("parseShowSlaveStatus reports streaming + lag from vertical SHOW SLAVE STATUS", () => {
  const healthy = parseShowSlaveStatus(HEALTHY_VERTICAL);
  assertEquals(healthy.state, "streaming");
  assertEquals(healthy.lagSeconds, 7);

  const reconnecting = parseShowSlaveStatus(UNHEALTHY_VERTICAL);
  assertEquals(reconnecting.state, "reconnecting");
  assertEquals(reconnecting.lagSeconds, undefined);
});

test("resolveMariadbPrimaryConnectHost prefers hostaddr for remote private listener", () => {
  assertEquals(
    resolveMariadbPrimaryConnectHost({
      host: "managed-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      hostaddr: "203.0.113.60",
    }),
    "203.0.113.60",
  );
  const sql = changeReplicationSourceSql({
    host: resolveMariadbPrimaryConnectHost({
      host: "managed-id",
      hostaddr: "203.0.113.60",
    }),
    port: 13306,
    username: "tp_repl",
    password: "s3cret",
  });
  assertEquals(sql.includes("MASTER_HOST = '203.0.113.60'"), true);
  assertEquals(sql.includes("MASTER_SSL_VERIFY_SERVER_CERT = 1"), true);
});

test("buildMariadbStandbySeedScript registers trap before writing credentials", () => {
  const script = buildMariadbStandbySeedScript();
  const trapIdx = script.indexOf("trap ");
  const catIdx = script.indexOf('cat > "$tmp"');
  assertEquals(trapIdx !== -1 && catIdx !== -1 && trapIdx < catIdx, true);
  assertEquals(script.includes("mariadb-dump --defaults-extra-file="), true);
});
