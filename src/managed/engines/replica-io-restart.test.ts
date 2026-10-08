import { assertEquals } from "@std/assert";
import {
  healStoppedReplicaIo,
  isReplicationApplierError,
  isReplicationConnectionError,
  parseReplicaIoStatus,
  replicaPrimaryLooksReachable,
  replicaPrimaryPingArgv,
  shouldRestartReplicaThreads,
} from "./replica-io-restart.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const CONNECTION_VERTICAL = `
*************************** 1. row ***************************
             Replica_IO_Running: No
            Replica_SQL_Running: Yes
                 Source_Host: 203.0.113.10
                 Source_Port: 3306
                Last_IO_Errno: 2003
                Last_IO_Error: error connecting to master 'repl@203.0.113.10:3306' - retry-time: 10 retries: 10 last_io_error: Can't connect to server
               Last_SQL_Errno: 0
               Last_SQL_Error:
`;

test("parseReplicaIoStatus maps MySQL and MariaDB field aliases", () => {
  const mysql = parseReplicaIoStatus(CONNECTION_VERTICAL);
  assertEquals(mysql.ioRunning, "no");
  assertEquals(mysql.sqlRunning, true);
  assertEquals(mysql.lastIoErrno, 2003);
  assertEquals(mysql.sourceHost, "203.0.113.10");
  assertEquals(mysql.sourcePort, 3306);

  const mariadb = parseReplicaIoStatus(`
             Slave_IO_Running: Connecting
            Slave_SQL_Running: Yes
                 Master_Host: db-1
                 Master_Port: 45001
                Last_IO_Errno: 2003
                Last_IO_Error: Can't connect
               Last_SQL_Errno: 0
               Last_SQL_Error:
`);
  assertEquals(mariadb.ioRunning, "connecting");
  assertEquals(mariadb.sqlRunning, true);
  assertEquals(mariadb.sourceHost, "db-1");
  assertEquals(mariadb.sourcePort, 45001);
});

test("shouldRestartReplicaThreads restarts only a stopped connection error", () => {
  const connection = {
    ioRunning: "no" as const,
    sqlRunning: true,
    lastIoErrno: 2003,
    lastSqlErrno: 0,
    lastIoError: "Can't connect to server on '203.0.113.10'",
    lastSqlError: "",
  };
  assertEquals(
    shouldRestartReplicaThreads({ ...connection, primaryReachable: true }),
    true,
  );
  assertEquals(
    shouldRestartReplicaThreads({ ...connection, primaryReachable: false }),
    false,
  );
  assertEquals(
    shouldRestartReplicaThreads({
      ...connection,
      ioRunning: "connecting",
      primaryReachable: true,
    }),
    false,
  );
  assertEquals(
    shouldRestartReplicaThreads({
      ...connection,
      ioRunning: "yes",
      sqlRunning: true,
      primaryReachable: true,
    }),
    false,
  );
  assertEquals(
    shouldRestartReplicaThreads({
      ...connection,
      lastIoErrno: 0,
      lastIoError: "error connecting to master: Connection refused",
      primaryReachable: true,
    }),
    true,
  );
});

test("shouldRestartReplicaThreads never restarts through applier or GTID errors", () => {
  assertEquals(
    shouldRestartReplicaThreads({
      ioRunning: "no",
      sqlRunning: false,
      lastIoErrno: 2003,
      lastSqlErrno: 1062,
      lastIoError: "Can't connect",
      lastSqlError: "Duplicate entry '1' for key 'PRIMARY'",
      primaryReachable: true,
    }),
    false,
  );
  assertEquals(
    shouldRestartReplicaThreads({
      ioRunning: "no",
      sqlRunning: true,
      lastIoErrno: 1236,
      lastSqlErrno: 0,
      lastIoError: "Got fatal error 1236 from source when reading data",
      lastSqlError: "",
      primaryReachable: true,
    }),
    false,
  );
  assertEquals(
    shouldRestartReplicaThreads({
      ioRunning: "no",
      sqlRunning: true,
      lastIoErrno: 0,
      lastSqlErrno: 0,
      lastIoError: "",
      lastSqlError: "",
      primaryReachable: true,
    }),
    false,
  );
  assertEquals(isReplicationConnectionError(2003, ""), true);
  assertEquals(isReplicationConnectionError(1236, "purged"), false);
  assertEquals(isReplicationApplierError(1062, ""), true);
  assertEquals(isReplicationApplierError(0, ""), false);
});

test("healStoppedReplicaIo starts replica SQL only when the primary pings", async () => {
  const started: string[] = [];
  let pings = 0;
  const restarted = await healStoppedReplicaIo({
    verbose: CONNECTION_VERTICAL,
    startSql: "START REPLICA;",
    runSql: (sql) => {
      started.push(sql);
      return Promise.resolve();
    },
    pingPrimary: () => {
      pings += 1;
      return Promise.resolve(true);
    },
  });
  assertEquals(restarted, true);
  assertEquals(pings, 1);
  assertEquals(started, ["START REPLICA;"]);

  const skipped = await healStoppedReplicaIo({
    verbose: CONNECTION_VERTICAL,
    startSql: "START REPLICA;",
    runSql: () => Promise.reject(new TypeError("should not start")),
    pingPrimary: () => Promise.resolve(false),
  });
  assertEquals(skipped, false);
});

test("replicaPrimaryPingArgv and access-denied still count as reachable", () => {
  assertEquals(
    replicaPrimaryPingArgv("mysqladmin", "203.0.113.10", 3306, "root"),
    [
      "mysqladmin",
      "ping",
      "--protocol=tcp",
      "--host",
      "203.0.113.10",
      "--port",
      "3306",
      "--connect-timeout",
      "3",
      "-u",
      "root",
    ],
  );
  assertEquals(
    replicaPrimaryLooksReachable({
      success: false,
      stdout: "",
      stderr:
        "ERROR 1045 (28000): Access denied for user 'root'@'203.0.113.10'",
    }),
    true,
  );
  assertEquals(
    replicaPrimaryLooksReachable({
      success: false,
      stdout: "",
      stderr: "Can't connect to server on '203.0.113.10' (111)",
    }),
    false,
  );
});
