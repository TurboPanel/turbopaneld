/**
 * Pure MySQL SQL builders for managed credential/database ops.
 *
 * No string interpolation of unquoted identifiers. Callers feed the result to
 * `mysql` via stdin. Unlike Postgres, string literals process backslash
 * escapes — {@link quoteLiteral} must escape `\` as well as `'`.
 */

const ACCOUNT_MAX_LENGTH = 32;
const SCHEMA_MAX_LENGTH = 64;
const IDENTIFIER_RE = /^[A-Za-z_]\w*$/;
// deno-lint-ignore no-control-regex -- intentional control-char reject list
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;

/**
 * Managed Docker network host for account scoping — 172.16.0.0/12 as MySQL
 * IP/netmask (not `172.%`, which would admit the entire 172.0.0.0/8 range).
 */
export const MANAGED_DOCKER_NETWORK_HOST = "172.16.0.0/255.240.0.0";

export type ManagedDatabasePrivilege = "owner" | "read-write" | "read-only";

export function quoteIdentifier(
  value: string,
  maxLength: number = SCHEMA_MAX_LENGTH,
): string {
  if (
    value.length === 0 ||
    value.length > maxLength ||
    !IDENTIFIER_RE.test(value)
  ) {
    throw new Error(`invalid mysql identifier: ${value}`);
  }
  return `\`${value.replaceAll("`", "``")}\``;
}

export function quoteAccount(value: string): string {
  return quoteIdentifier(value, ACCOUNT_MAX_LENGTH);
}

/**
 * Quote a MySQL string literal. Escapes backslashes first, then single
 * quotes. Rejects control characters.
 */
export function quoteLiteral(value: string): string {
  if (CONTROL_CHAR_RE.test(value)) {
    throw new Error("mysql literal contains control characters");
  }
  return `'${
    value
      .replaceAll("\\", String.raw`\\`)
      .replaceAll("'", String.raw`\'`)
  }'`;
}

function accountAt(username: string, host: string): string {
  return `${quoteAccount(username)}@${quoteLiteral(host)}`;
}

/** Create/alter account with password at a single host. */
export function createOrAlterAccountSql(
  username: string,
  password: string,
  host: string,
): string {
  const account = accountAt(username, host);
  const lit = quoteLiteral(password);
  return [
    `CREATE USER IF NOT EXISTS ${account} IDENTIFIED BY ${lit};`,
    `ALTER USER ${account} IDENTIFIED BY ${lit};`,
  ].join("\n");
}

/**
 * ProxySQL backend monitor account on the managed Docker network host.
 * USAGE + PROCESS + REPLICATION CLIENT cover connect / read_only probes.
 */
export function ensureProxySqlMonitorAccountSql(
  username: string,
  password: string,
  extraHosts: readonly string[] = [],
): string {
  const lit = quoteLiteral(password);
  const hosts = [...new Set([MANAGED_DOCKER_NETWORK_HOST, ...extraHosts])];
  const lines: string[] = [];
  for (const host of hosts) {
    const account = accountAt(username, host);
    lines.push(
      `CREATE USER IF NOT EXISTS ${account} IDENTIFIED BY ${lit};`,
      `ALTER USER ${account} IDENTIFIED BY ${lit};`,
      `GRANT USAGE, PROCESS, REPLICATION CLIENT ON *.* TO ${account};`,
    );
  }
  return lines.join("\n");
}

/**
 * Drop an account across host variants. Drops managed-network + localhost
 * plus any explicit peer hosts.
 */
export function dropAccountSql(
  username: string,
  hosts: string[] = [MANAGED_DOCKER_NETWORK_HOST, "localhost"],
): string {
  const unique = [...new Set(hosts)];
  return unique
    .map((host) => `DROP USER IF EXISTS ${accountAt(username, host)};`)
    .join("\n");
}

export function createDatabaseSql(name: string): string {
  const db = quoteIdentifier(name);
  return `CREATE DATABASE IF NOT EXISTS ${db} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`;
}

export function dropDatabaseSql(name: string): string {
  const db = quoteIdentifier(name);
  return `DROP DATABASE IF EXISTS ${db};`;
}

export function grantDatabaseSql(
  database: string,
  username: string,
  privilege: ManagedDatabasePrivilege,
  host: string = MANAGED_DOCKER_NETWORK_HOST,
): string {
  const db = quoteIdentifier(database);
  const account = accountAt(username, host);
  switch (privilege) {
    case "owner":
      return `GRANT ALL PRIVILEGES ON ${db}.* TO ${account} WITH GRANT OPTION;`;
    case "read-write":
      return (
        `GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, INDEX, ALTER, ` +
        `CREATE TEMPORARY TABLES, LOCK TABLES, EXECUTE, CREATE VIEW, SHOW VIEW, ` +
        `CREATE ROUTINE, ALTER ROUTINE, EVENT, TRIGGER ON ${db}.* TO ${account};`
      );
    case "read-only":
      return `GRANT SELECT, SHOW VIEW ON ${db}.* TO ${account};`;
    default: {
      const _exhaustive: never = privilege;
      throw new Error(`unsupported privilege: ${_exhaustive}`);
    }
  }
}

export function grantRootSql(
  username: string,
  host: string = MANAGED_DOCKER_NETWORK_HOST,
): string {
  return `GRANT ALL PRIVILEGES ON *.* TO ${
    accountAt(username, host)
  } WITH GRANT OPTION;`;
}

/**
 * `REQUIRE SSL` binds TLS to the account itself, so the server rejects a
 * plaintext replication login even if a standby omits `SOURCE_SSL = 1`.
 * MySQL 8+ removed the `REQUIRE` clause from `GRANT` (MariaDB keeps it) —
 * the TLS binding must be an `ALTER USER`.
 *
 * The account doubles as the standby **seed** login: `configureStandby`
 * dumps the primary with `mysqldump --all-databases --single-transaction
 * --set-gtid-purged=ON`, which needs SELECT/RELOAD (FLUSH TABLES)/PROCESS/
 * LOCK TABLES/SHOW VIEW/EVENT/TRIGGER on top of the replication grants.
 */
export function grantReplicationSql(
  username: string,
  host: string,
): string {
  const account = accountAt(username, host);
  return [
    `GRANT SELECT, RELOAD, PROCESS, LOCK TABLES, SHOW VIEW, EVENT, TRIGGER, ` +
    `REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO ${account};`,
    `ALTER USER ${account} REQUIRE SSL;`,
  ].join("\n");
}

/** Create/alter the replication account once per peer host. */
export function ensureReplicationAccountSql(
  username: string,
  password: string,
  peerAddresses: string[],
): string {
  const lines: string[] = [];
  for (const peer of peerAddresses) {
    lines.push(
      createOrAlterAccountSql(username, password, peer),
      grantReplicationSql(username, peer),
    );
  }
  if (peerAddresses.length === 0) {
    // Fall back to managed-network host pattern when peers are co-resident.
    lines.push(
      createOrAlterAccountSql(username, password, MANAGED_DOCKER_NETWORK_HOST),
      grantReplicationSql(username, MANAGED_DOCKER_NETWORK_HOST),
    );
  }
  lines.push("FLUSH PRIVILEGES;");
  return lines.join("\n");
}

export function createClientAccountSql(
  username: string,
  password: string,
  extraHosts: readonly string[] = [],
): string {
  const hosts = [
    ...new Set([MANAGED_DOCKER_NETWORK_HOST, "localhost", ...extraHosts]),
  ];
  return hosts
    .map((host) => createOrAlterAccountSql(username, password, host))
    .join("\n");
}

/**
 * Password account on the managed Docker network only — never `localhost`.
 * Platform `root@localhost` stays `auth_socket` for credential-free docker exec.
 */
export function createNetworkAccountSql(
  username: string,
  password: string,
  extraHosts: readonly string[] = [],
): string {
  const hosts = [...new Set([MANAGED_DOCKER_NETWORK_HOST, ...extraHosts])];
  return hosts
    .map((host) => createOrAlterAccountSql(username, password, host))
    .join("\n");
}

/**
 * Repair / ensure socket-auth platform admins after a password bootstrap.
 * Safe to re-run; does not embed credentials. The daemon installs
 * `auth_socket` first — MySQL has no `INSTALL PLUGIN IF NOT EXISTS`.
 */
export function ensureSocketAdminSql(osUser: string = "mysql"): string {
  const rootAccount = accountAt("root", "localhost");
  const osAccount = accountAt(osUser, "localhost");
  return [
    `CREATE USER IF NOT EXISTS ${rootAccount} IDENTIFIED WITH auth_socket;`,
    `ALTER USER ${rootAccount} IDENTIFIED WITH auth_socket;`,
    `GRANT ALL PRIVILEGES ON *.* TO ${rootAccount} WITH GRANT OPTION;`,
    `CREATE USER IF NOT EXISTS ${osAccount} IDENTIFIED WITH auth_socket;`,
    `ALTER USER ${osAccount} IDENTIFIED WITH auth_socket;`,
    `GRANT ALL PRIVILEGES ON *.* TO ${osAccount} WITH GRANT OPTION;`,
  ].join("\n");
}

/** MySQL 8+/9 `INSTALL PLUGIN` — no `IF NOT EXISTS` (that is MariaDB-only). */
export function installAuthSocketPluginSql(): string {
  return "INSTALL PLUGIN auth_socket SONAME 'auth_socket.so';";
}

export function authSocketPluginPresentSql(): string {
  return "SELECT PLUGIN_NAME FROM INFORMATION_SCHEMA.PLUGINS WHERE PLUGIN_NAME = 'auth_socket'";
}

/**
 * Standby seed window: the platform my.cnf boots standbys with
 * `read_only=ON, super_read_only=ON`, which blocks the seed IMPORT (even for
 * root over the socket, error 1290). `configureStandby` disables both for
 * the seed and re-enforces them once replication is configured.
 */
export function disableReadOnlySql(): string {
  return [
    "SET GLOBAL super_read_only = OFF;",
    "SET GLOBAL read_only = OFF;",
  ].join("\n");
}

export function enforceReadOnlySql(): string {
  return [
    "SET GLOBAL read_only = ON;",
    "SET GLOBAL super_read_only = ON;",
  ].join("\n");
}

export function promoteSql(): string {
  return [
    "STOP REPLICA;",
    "RESET REPLICA ALL;",
    "SET GLOBAL super_read_only = OFF;",
    "SET GLOBAL read_only = OFF;",
  ].join("\n");
}

export function isWritableSql(): string {
  return "SELECT @@GLOBAL.read_only, @@GLOBAL.super_read_only;";
}

/**
 * MySQL 8+ replica status. Streaming requires both IO and SQL threads running —
 * recovery alone (similar to Postgres) is not enough to look promote-ready.
 */
export function standbyReplicationStatusSql(): string {
  return [
    "SELECT",
    "  CASE",
    "    WHEN Replica_IO_Running = 'Yes' AND Replica_SQL_Running = 'Yes' THEN 'streaming'",
    "    WHEN Replica_IO_Running = 'Yes' OR Replica_SQL_Running = 'Yes' THEN 'reconnecting'",
    "    ELSE 'stopped'",
    "  END AS state,",
    "  Seconds_Behind_Source AS lag_seconds",
    "FROM (SELECT",
    "  COALESCE(",
    "    (SELECT SERVICE_STATE FROM performance_schema.replication_connection_status LIMIT 1),",
    "    'NO'",
    "  ) AS Replica_IO_Running,",
    "  COALESCE(",
    "    (SELECT SERVICE_STATE FROM performance_schema.replication_applier_status_by_coordinator LIMIT 1),",
    "    'NO'",
    "  ) AS Replica_SQL_Running,",
    "  (SELECT TIMESTAMPDIFF(SECOND, LAST_APPLIED_TRANSACTION_END_APPLY_TIMESTAMP, NOW())",
    "     FROM performance_schema.replication_applier_status_by_worker",
    "     WHERE LAST_APPLIED_TRANSACTION_END_APPLY_TIMESTAMP IS NOT NULL",
    "     ORDER BY LAST_APPLIED_TRANSACTION_END_APPLY_TIMESTAMP DESC LIMIT 1",
    "  ) AS Seconds_Behind_Source",
    ") AS status;",
  ].join("\n");
}

export function showReplicaStatusSql(): string {
  // Tabular status — consumer maps IO/SQL running fields (MySQL 8 performance_schema
  // is preferred when present; SHOW REPLICA STATUS remains the portable fallback).
  return "SHOW REPLICA STATUS;";
}

export function changeReplicationSourceSql(spec: {
  host: string;
  port: number;
  username: string;
  password: string;
}): string {
  return [
    "CHANGE REPLICATION SOURCE TO",
    `  SOURCE_HOST = ${quoteLiteral(spec.host)},`,
    `  SOURCE_PORT = ${spec.port},`,
    `  SOURCE_USER = ${quoteLiteral(spec.username)},`,
    `  SOURCE_PASSWORD = ${quoteLiteral(spec.password)},`,
    "  SOURCE_AUTO_POSITION = 1,",
    "  SOURCE_SSL = 1,",
    "  SOURCE_SSL_CA = '/etc/mysql/tls/ca.crt',",
    "  SOURCE_SSL_VERIFY_SERVER_CERT = 1;",
    "START REPLICA;",
  ].join("\n");
}

export function versionSql(): string {
  return "SELECT VERSION();";
}

export { ACCOUNT_MAX_LENGTH, SCHEMA_MAX_LENGTH };
