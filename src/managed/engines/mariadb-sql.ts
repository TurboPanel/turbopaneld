/**
 * Pure MariaDB SQL builders for managed credential/database ops.
 *
 * Materially distinct from MySQL in replication vocabulary
 * (`MASTER_USE_GTID=slave_pos` / `gtid_slave_pos` vs `SOURCE_AUTO_POSITION=1`).
 */

const ACCOUNT_MAX_LENGTH = 32;
const SCHEMA_MAX_LENGTH = 64;
const IDENTIFIER_RE = /^[A-Za-z_]\w*$/;
// deno-lint-ignore no-control-regex -- intentional control-char reject list
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;

/**
 * Managed Docker network host for account scoping — 172.16.0.0/12 as MySQL-
 * family IP/netmask (not `172.%`, which would admit the entire 172.0.0.0/8 range).
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
    throw new Error(`invalid mariadb identifier: ${value}`);
  }
  return `\`${value.replaceAll("`", "``")}\``;
}

export function quoteAccount(value: string): string {
  return quoteIdentifier(value, ACCOUNT_MAX_LENGTH);
}

export function quoteLiteral(value: string): string {
  if (CONTROL_CHAR_RE.test(value)) {
    throw new Error("mariadb literal contains control characters");
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
 * plaintext replication login even if a standby omits `MASTER_SSL = 1`.
 * (MariaDB keeps `REQUIRE` on `GRANT` — the MySQL dialect must use
 * `ALTER USER`.)
 *
 * The account doubles as the standby **seed** login: `configureStandby`
 * dumps the primary (`mariadb-dump --all-databases --single-transaction
 * --gtid`), which needs SELECT/RELOAD (FLUSH TABLES)/PROCESS/LOCK TABLES/
 * SHOW VIEW/EVENT/TRIGGER on top of the replication grants.
 */
export function grantReplicationSql(
  username: string,
  host: string,
): string {
  return `GRANT SELECT, RELOAD, PROCESS, LOCK TABLES, SHOW VIEW, EVENT, ` +
    `TRIGGER, REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO ${
      accountAt(username, host)
    } REQUIRE SSL;`;
}

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
 * Platform `root@localhost` stays `unix_socket` for credential-free docker exec.
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
 * MariaDB ships `unix_socket` built-in — no INSTALL PLUGIN.
 */
export function ensureSocketAdminSql(osUser: string = "mysql"): string {
  const rootAccount = accountAt("root", "localhost");
  const osAccount = accountAt(osUser, "localhost");
  return [
    `CREATE USER IF NOT EXISTS ${rootAccount} IDENTIFIED VIA unix_socket;`,
    `ALTER USER ${rootAccount} IDENTIFIED VIA unix_socket;`,
    `GRANT ALL PRIVILEGES ON *.* TO ${rootAccount} WITH GRANT OPTION;`,
    `CREATE USER IF NOT EXISTS ${osAccount} IDENTIFIED VIA unix_socket;`,
    `ALTER USER ${osAccount} IDENTIFIED VIA unix_socket;`,
    `GRANT ALL PRIVILEGES ON *.* TO ${osAccount} WITH GRANT OPTION;`,
  ].join("\n");
}

/**
 * Standby seed window: the platform my.cnf boots standbys with
 * `read_only=ON`, which blocks the seed IMPORT for non-SUPER users;
 * `configureStandby` disables it for the seed and re-enforces it once
 * replication is configured. **MariaDB has no `super_read_only`** (that is
 * MySQL-only; MDEV-18441) — referencing it in my.cnf kills mariadbd at
 * startup ("unknown variable") and in SQL it errors.
 */
export function disableReadOnlySql(): string {
  return "SET GLOBAL read_only = OFF;";
}

export function enforceReadOnlySql(): string {
  return "SET GLOBAL read_only = ON;";
}

export function promoteSql(): string {
  return [
    "STOP SLAVE;",
    "RESET SLAVE ALL;",
    "SET GLOBAL read_only = OFF;",
  ].join("\n");
}

export function isWritableSql(): string {
  return "SELECT @@GLOBAL.read_only;";
}

export function showReplicaStatusSql(): string {
  return "SHOW SLAVE STATUS;";
}

/**
 * MariaDB 11 GTID: MASTER_USE_GTID=slave_pos with gtid_slave_pos rather than
 * MySQL SOURCE_AUTO_POSITION.
 */
export function changeReplicationSourceSql(spec: {
  host: string;
  port: number;
  username: string;
  password: string;
}): string {
  return [
    "CHANGE MASTER TO",
    `  MASTER_HOST = ${quoteLiteral(spec.host)},`,
    `  MASTER_PORT = ${spec.port},`,
    `  MASTER_USER = ${quoteLiteral(spec.username)},`,
    `  MASTER_PASSWORD = ${quoteLiteral(spec.password)},`,
    "  MASTER_USE_GTID = slave_pos,",
    "  MASTER_SSL = 1,",
    "  MASTER_SSL_CA = '/etc/mysql/tls/ca.crt',",
    "  MASTER_SSL_VERIFY_SERVER_CERT = 1;",
    "START SLAVE;",
  ].join("\n");
}

export function versionSql(): string {
  return "SELECT VERSION();";
}

export { ACCOUNT_MAX_LENGTH, SCHEMA_MAX_LENGTH };
