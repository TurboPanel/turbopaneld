/**
 * A database-level grant on a name holding `_` is a pattern on MySQL and
 * MariaDB. The panel writes the name escaped and, on the next apply, removes
 * the plain grant older versions left behind (panel-owned grants only).
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import type { ManagedApplyCredential } from "../../contracts/commands-contracts.ts";
import { escapeGrantSchemaPattern, hasGrantWildcard } from "./grant-pattern.ts";
import {
  grantDatabaseSql as mariadbGrant,
  revokePlainDatabaseGrantSql as mariadbRevoke,
} from "./mariadb-sql.ts";
import { mariadbManagedEngineRuntime } from "./mariadb.ts";
import {
  grantDatabaseSql as mysqlGrant,
  revokePlainDatabaseGrantSql as mysqlRevoke,
} from "./mysql-sql.ts";
import { mysqlManagedEngineRuntime } from "./mysql.ts";
import type {
  ManagedEngineContext,
  ManagedEngineExec,
  ManagedEngineRuntime,
} from "./types.ts";

const test = Deno.test.bind(Deno);

test("a name that no longer fits once escaped is refused with a clear error", () => {
  const fits = "a_".repeat(31) + "b"; // 63 characters, 31 underscores: 94 escaped
  for (const grant of [mysqlGrant, mariadbGrant]) {
    assertThrows(() => grant(fits, "u1", "owner"), Error, "too long");
    assert(grant("a".repeat(64), "u1", "owner").includes("`a"));
  }
});

test("escapeGrantSchemaPattern escapes the pattern characters only", () => {
  assertEquals(escapeGrantSchemaPattern("wp_site"), "wp\\_site");
  assertEquals(escapeGrantSchemaPattern("a%b\\c"), "a\\%b\\\\c");
  assertEquals(escapeGrantSchemaPattern("appdb"), "appdb");
  assertEquals(hasGrantWildcard("wp_site"), true);
  assertEquals(hasGrantWildcard("appdb"), false);
});

for (
  const [name, grant, revoke] of [
    ["mysql", mysqlGrant, mysqlRevoke],
    ["mariadb", mariadbGrant, mariadbRevoke],
  ] as const
) {
  test(`${name}: a grant on a name with _ is on the exact name`, () => {
    for (const privilege of ["owner", "read-write", "read-only"] as const) {
      const sql = grant("wp_site", "u1", privilege);
      assert(sql.includes("ON `wp\\_site`.* TO "), sql);
    }
    assert(grant("appdb", "u1", "owner").includes("ON `appdb`.* TO "));
  });

  test(`${name}: the plain-name revoke only acts on an existing plain grant`, () => {
    const sql = revoke("wp_site", "u1", "10.0.0.5");
    assert(sql.includes("FROM mysql.db WHERE Db = 'wp_site'"), sql);
    assert(sql.includes("User = 'u1' AND Host = '10.0.0.5'"), sql);
    assert(sql.includes("IF(@tp_plain_grant > 0"), sql);
    // The revoke targets the plain row, never the escaped one.
    assert(
      sql.includes(
        "REVOKE ALL PRIVILEGES ON `wp_site`.* FROM `u1`@\\'10.0.0.5\\'",
      ),
      sql,
    );
    assert(sql.includes("REVOKE GRANT OPTION ON `wp_site`.* FROM"), sql);
    // `ALL PRIVILEGES, GRANT OPTION ON db.*` does not parse.
    assert(!sql.includes("PRIVILEGES, GRANT OPTION"), sql);
    assert(!sql.includes("wp\\_site"), sql);
  });
}

async function applied(
  engine: ManagedEngineRuntime,
  credential: Partial<ManagedApplyCredential>,
): Promise<string> {
  const inputs: string[] = [];
  const exec: ManagedEngineExec = (_argv, input) => {
    inputs.push(input ?? "");
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  const ctx: ManagedEngineContext = {
    containerId: "c1",
    composeServiceName: "svc",
    rootUsername: "root",
    defaultDatabase: "appdb",
    clientSourceHosts: ["10.0.0.5"],
    exec,
  };
  await engine.applyCredentials(ctx, [
    {
      principalId: "p-1",
      username: "u1",
      role: "user",
      databases: ["wp_site", "appdb"],
      privileges: ["read-write"],
      password: "p1",
      ...credential,
    },
  ]);
  return inputs.join("\n");
}

for (
  const [name, engine] of [
    ["mysql", mysqlManagedEngineRuntime],
    ["mariadb", mariadbManagedEngineRuntime],
  ] as const
) {
  test(`${name}: apply grants the exact name, then removes the plain grant for each host`, async () => {
    const sql = await applied(engine, {});
    const grantAt = sql.indexOf("ON `wp\\_site`.* TO");
    const revokeAt = sql.indexOf("DEALLOCATE PREPARE tp_plain_revoke");
    assert(grantAt >= 0 && revokeAt > grantAt, sql);
    // One revoke per account host (managed network + the client host), only
    // for the database whose name is a pattern.
    assertEquals(sql.split("PREPARE tp_plain_revoke FROM").length - 1, 4);
    assertEquals(sql.includes("Db = 'appdb'"), false);
    // The last grant on wp_site comes before its first revoke.
    assert(
      sql.lastIndexOf("ON `wp\\_site`.* TO") <
        sql.indexOf("SET @tp_plain_grant"),
    );
  });

  test(`${name}: a login the owner manages by hand is never revoked or granted`, async () => {
    const sql = await applied(engine, { grantMode: "self" });
    assertEquals(sql.includes("tp_plain"), false);
    assertEquals(sql.includes("GRANT SELECT"), false);
  });

  test(`${name}: nothing to revoke when no privilege is recognised`, async () => {
    const sql = await applied(engine, { privileges: [] });
    assertEquals(sql.includes("tp_plain"), false);
  });
}

test("the Database admin login in self mode still gets its plain grant removed", async () => {
  const sql = await applied(mysqlManagedEngineRuntime, {
    grantMode: "self",
    privileges: ["admin"],
  });
  assert(sql.includes("ON `wp\\_site`.* TO"), sql);
  assert(sql.includes("REVOKE GRANT OPTION ON `wp_site`"), sql);
});
