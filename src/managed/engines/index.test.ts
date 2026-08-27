import { assertEquals, assertThrows } from "@std/assert";
import { getManagedEngineRuntime } from "./index.ts";
import { mariadbManagedEngineRuntime } from "./mariadb.ts";
import { mysqlManagedEngineRuntime } from "./mysql.ts";
import { postgresManagedEngineRuntime } from "./postgres.ts";
import {
  ManagedBackupNotSupportedError,
  ManagedEngineNotSupportedError,
  ManagedReplicationNotSupportedError,
} from "./types.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("getManagedEngineRuntime returns the registered postgres/mysql/mariadb runtimes", () => {
  assertEquals(
    getManagedEngineRuntime("postgres"),
    postgresManagedEngineRuntime,
  );
  assertEquals(getManagedEngineRuntime("mysql"), mysqlManagedEngineRuntime);
  assertEquals(getManagedEngineRuntime("mariadb"), mariadbManagedEngineRuntime);
  assertEquals(getManagedEngineRuntime("postgres").engine, "postgres");
  assertEquals(
    getManagedEngineRuntime("mysql").backup?.artifactExtension,
    "sql",
  );
  assertEquals(
    getManagedEngineRuntime("mariadb").backup?.artifactExtension,
    "sql",
  );
});

test("getManagedEngineRuntime rejects catalog engines with no daemon runtime", () => {
  for (const engine of ["redis", "clickhouse"] as const) {
    const err = assertThrows(
      () => getManagedEngineRuntime(engine),
      ManagedEngineNotSupportedError,
      engine,
    );
    assertEquals(err.kind, "managed_engine_not_supported");
    assertEquals(err.engine, engine);
    assertEquals(err.name, "ManagedEngineNotSupportedError");
  }
});

test("managed capability errors carry a stable kind", () => {
  const backup = new ManagedBackupNotSupportedError("redis");
  assertEquals(backup.kind, "managed_backup_not_supported");
  assertEquals(backup.engine, "redis");
  assertEquals(backup.name, "ManagedBackupNotSupportedError");

  const replication = new ManagedReplicationNotSupportedError("clickhouse");
  assertEquals(replication.kind, "managed_replication_not_supported");
  assertEquals(replication.engine, "clickhouse");
  assertEquals(replication.name, "ManagedReplicationNotSupportedError");
});
