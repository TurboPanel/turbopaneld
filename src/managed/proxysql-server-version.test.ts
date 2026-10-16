/**
 * Host-free coverage for the server version ProxySQL reports to clients.
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildProxySqlAdminStatements,
  type ProxySqlClusterDesired,
  renderProxySqlConfig,
} from "./proxysql.ts";
import {
  proxySqlServerVersions,
  type ProxySqlVersionSource,
} from "./proxysql-server-version.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function pg(engineVersion?: string): ProxySqlVersionSource {
  return {
    family: "pgsql",
    engine: "postgres",
    ...(engineVersion ? { engineVersion } : {}),
  };
}

function my(engine: string, engineVersion?: string): ProxySqlVersionSource {
  return {
    family: "mysql",
    engine,
    ...(engineVersion ? { engineVersion } : {}),
  };
}

function cluster(
  overrides: Partial<ProxySqlClusterDesired>,
): ProxySqlClusterDesired {
  return {
    managedId: "m1",
    engine: "postgres",
    protocolPort: 15432,
    writerHostgroup: 0,
    readerHostgroup: 1,
    backends: [],
    users: [],
    ...overrides,
  };
}

test("one cluster per listener reports its own version", () => {
  assertEquals(proxySqlServerVersions([pg("18"), my("mysql", "9.7")]), {
    pgsql: "18.0",
    mysql: "9.7.0",
  });
  assertEquals(proxySqlServerVersions([my("mariadb", "11.8")]), {
    mysql: "11.8.0-MariaDB",
  });
});

test("several clusters on one listener report the newest series, compared as numbers", () => {
  assertEquals(proxySqlServerVersions([pg("9.6"), pg("18"), pg("16")]), {
    pgsql: "18.0",
  });
  assertEquals(
    proxySqlServerVersions([my("mysql", "8.4"), my("mysql", "9.7")]),
    {
      mysql: "9.7.0",
    },
  );
  assertEquals(proxySqlServerVersions([pg("9.6"), pg("10")]), {
    pgsql: "10.0",
  });
  // PostgreSQL has two parts, MySQL three, whatever was sent.
  assertEquals(proxySqlServerVersions([pg("16.4.1")]), { pgsql: "16.4" });
  assertEquals(proxySqlServerVersions([my("mysql", "9")]), { mysql: "9.0.0" });
  assertEquals(
    proxySqlServerVersions([my("mariadb", "11.8"), my("mariadb", "12.3")]),
    { mysql: "12.3.0-MariaDB" },
  );
});

test("MySQL wins the shared listener over MariaDB, whichever is newer", () => {
  assertEquals(
    proxySqlServerVersions([my("mariadb", "12.3"), my("mysql", "8.4")]),
    { mysql: "8.4.0" },
  );
});

test("clusters without a version (older control plane) count for nothing", () => {
  assertEquals(proxySqlServerVersions([pg(), my("mysql")]), {});
  assertEquals(proxySqlServerVersions([my("mysql"), my("mariadb", "11.8")]), {
    mysql: "11.8.0-MariaDB",
  });
  assertEquals(
    proxySqlServerVersions([{
      family: null,
      engine: "redis",
      engineVersion: "8",
    }]),
    {},
  );
});

test("admin statements set each listener's version, then reload TLS last", () => {
  const statements = buildProxySqlAdminStatements({
    bindAddresses: [],
    clusters: [
      cluster({ engineVersion: "18" }),
      cluster({
        managedId: "m2",
        engine: "mysql",
        family: "mysql",
        protocolPort: 13306,
        writerHostgroup: 2,
        readerHostgroup: 3,
        engineVersion: "9.7",
      }),
    ],
  });
  const mysqlAt = statements.indexOf("SET mysql-server_version='9.7.0'");
  const pgsqlAt = statements.indexOf("SET pgsql-server_version='18.0'");
  assert(mysqlAt >= 0 && pgsqlAt >= 0, statements.join("\n"));
  assertEquals(statements.slice(mysqlAt + 1, mysqlAt + 3), [
    "LOAD MYSQL VARIABLES TO RUNTIME",
    "SAVE MYSQL VARIABLES TO DISK",
  ]);
  assertEquals(statements.slice(pgsqlAt + 1, pgsqlAt + 3), [
    "LOAD PGSQL VARIABLES TO RUNTIME",
    "SAVE PGSQL VARIABLES TO DISK",
  ]);
  assertEquals(statements.at(-1), "PROXYSQL RELOAD TLS");
});

test("no engine version means no server_version statement", () => {
  const statements = buildProxySqlAdminStatements({
    bindAddresses: [],
    clusters: [cluster({})],
  });
  assertEquals(statements.some((s) => s.includes("server_version")), false);
});

test("the version never enters proxysql.cnf, so a version change restarts nothing", () => {
  const cnf = renderProxySqlConfig({
    bindAddresses: [],
    clusters: [cluster({ engineVersion: "18" })],
  });
  assertEquals(cnf.includes("server_version"), false);
});
