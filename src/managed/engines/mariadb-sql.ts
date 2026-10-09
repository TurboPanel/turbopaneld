/**
 * Pure MariaDB SQL builders for managed credential/database ops.
 *
 * Materially distinct from MySQL in replication vocabulary
 * (`MASTER_USE_GTID=slave_pos` / `gtid_slave_pos` vs `SOURCE_AUTO_POSITION=1`).
 */

import {
  type FollowSourceDialect,
  renderFollowSourceSql,
} from "./follow-source-sql.ts";

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
  const account = accountAt(username, host);
  return [
    `GRANT ALL PRIVILEGES ON *.* TO ${account} WITH GRANT OPTION;`,
    // MariaDB has no super_read_only. GRANT ALL includes READ_ONLY ADMIN
    // (the 10.11+ privilege that writes through @@read_only=ON; SUPER
    // does not). Network / ProxySQL-reachable accounts must never hold it;
    // unix_socket admins keep it via ensureSocketAdminSql.
    `REVOKE READ_ONLY ADMIN ON *.* FROM ${account};`,
  ].join("\n");
}

export function revokeReadOnlyAdminSql(username: string, host: string): string {
  return `REVOKE READ_ONLY ADMIN ON *.* FROM ${accountAt(username, host)};`;
}

/** Non-localhost accounts: the dump copies the primary's grant tables. */
export function listNonLocalAccountsSql(): string {
  return "SELECT User, Host FROM mysql.global_priv WHERE Host <> 'localhost' AND User <> '';";
}

export function parseGlobalPrivAccountRows(
  tsv: string,
): Array<{ username: string; host: string }> {
  const rows: Array<{ username: string; host: string }> = [];
  for (const line of tsv.split("\n")) {
    if (line.length === 0) continue;
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const username = line.slice(0, tab);
    const host = line.slice(tab + 1).replaceAll("\r", "");
    if (host.length === 0 || host === "localhost") continue;
    rows.push({ username, host });
  }
  return rows;
}

function isSafeAccountName(value: string): boolean {
  return value.length > 0 &&
    value.length <= ACCOUNT_MAX_LENGTH &&
    IDENTIFIER_RE.test(value);
}

/**
 * Replica-side strip after a seed dump. Skips names the identifier quoter
 * would reject (system accounts with a dot) so a hostile Host cannot break
 * configureStandby.
 */
export function revokeReadOnlyAdminFromNetworkAccountsSql(
  accounts: readonly { username: string; host: string }[],
): string {
  const lines: string[] = [];
  for (const account of accounts) {
    if (account.host === "localhost" || !isSafeAccountName(account.username)) {
      continue;
    }
    lines.push(revokeReadOnlyAdminSql(account.username, account.host));
  }
  if (lines.length === 0) return "";
  lines.push("FLUSH PRIVILEGES;");
  return lines.join("\n");
}

/**
 * Post-seed replica guard: socket admins keep ALL; strip READ_ONLY ADMIN from
 * every non-localhost account copied in the dump. Wrapped so none of it is
 * binary-logged (replica-only GTIDs).
 */
export function reassertReplicaPrivilegeGuardSql(
  accounts: readonly { username: string; host: string }[],
): string {
  const revokeSql = revokeReadOnlyAdminFromNetworkAccountsSql(accounts);
  const inner = revokeSql.length === 0
    ? ensureSocketAdminSql()
    : `${ensureSocketAdminSql()}\n${revokeSql}`;
  return withoutSessionBinlogSql(inner);
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
 * Session-only: keep replica-local statements out of the binary log so they
 * cannot mint a replica-UUID GTID the primary never executed.
 */
export function withoutSessionBinlogSql(sql: string): string {
  return [
    "SET SESSION sql_log_bin = 0;",
    sql.trim(),
    "SET SESSION sql_log_bin = 1;",
  ].join("\n");
}

/** Clears entrypoint-init GTID state on a freshly initdb'd standby. */
export function resetReplicaGtidStateSql(): string {
  return "RESET MASTER;";
}

/** Replica-local flush — must not be binary-logged. */
export function flushPrivilegesLocalSql(): string {
  return withoutSessionBinlogSql("FLUSH PRIVILEGES;");
}

/**
 * Standby seed window: the platform my.cnf boots standbys with
 * `read_only=ON`, which blocks the seed IMPORT for accounts without
 * READ_ONLY ADMIN; `configureStandby` disables it for the seed and
 * re-enforces it once replication is configured. **MariaDB has no
 * `super_read_only`** (that is MySQL-only; MDEV-18441) — referencing it in
 * my.cnf kills mariadbd at startup ("unknown variable") and in SQL it
 * errors. The unix_socket platform admin keeps READ_ONLY ADMIN so this
 * SET GLOBAL still works; network root does not.
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

/** Final GTID position on a quiesced MariaDB primary (includes replicated work). */
export function primaryFinalGtidSetSql(): string {
  return "SELECT @@GLOBAL.gtid_current_pos AS gtid_set;";
}

export function masterGtidWaitSql(
  gtidSet: string,
  timeoutSeconds: number,
): string {
  return `SELECT MASTER_GTID_WAIT(${
    quoteLiteral(gtidSet)
  }, ${timeoutSeconds});`;
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

/**
 * Re-point an already-configured replica after promotion. Host and port
 * only — user, password, SSL, and GTID stay as seeded.
 */
export const MARIADB_FOLLOW_SOURCE_DIALECT: FollowSourceDialect = {
  stop: "STOP SLAVE",
  change: "CHANGE MASTER TO",
  hostKey: "MASTER_HOST",
  portKey: "MASTER_PORT",
  start: "START SLAVE",
};

export function followReplicationSourceSql(spec: {
  host: string;
  port: number;
}): string {
  return renderFollowSourceSql(
    MARIADB_FOLLOW_SOURCE_DIALECT,
    spec,
    quoteLiteral,
  );
}

/**
 * Metrics census for the `-N -B -e` client: a `Threads_connected<TAB>n` row from
 * `SHOW GLOBAL STATUS` (portable across MySQL 8 and MariaDB, unlike the
 * `performance_schema` / `information_schema` status tables) followed by the
 * bare `@@max_connections` value.
 */
export function connectionCensusSql(): string {
  return "SHOW GLOBAL STATUS LIKE 'Threads_connected'; SELECT @@max_connections;";
}

export function versionSql(): string {
  return "SELECT VERSION();";
}

export { ACCOUNT_MAX_LENGTH, SCHEMA_MAX_LENGTH };
