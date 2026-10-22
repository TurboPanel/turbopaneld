/**
 * Organization-wide Orchestrator topology account SQL (MySQL + MariaDB).
 *
 * One login per organization, accepted by every MySQL and MariaDB member of
 * every HA cluster in it. Rows exist for `MANAGED_DOCKER_NETWORK_HOST`
 * (172.16.0.0/12 — an Orchestrator container dialing a member on its own
 * server), for `clientSourceHosts` (each member's private-listener address)
 * **and for the private ranges 10.0.0.0/8 and 192.168.0.0/16**. The extra row is needed because discovery and
 * recovery run on the organization's Raft **leader**, which can be any
 * Orchestrator server of the organization — not only a member of this
 * cluster — and its connection leaves that server from the server's own
 * address on the route to the member (not its Raft advertise address). A
 * cluster's apply cannot know that set, and it changes whenever leadership
 * moves or an Orchestrator server joins, so a host list built from the members
 * left the leader refused (`Error 1045 … @'<leader address>'`) and nothing
 * registered. Every row stays bound to TLS (`REQUIRE SSL`) and to the
 * derived per-organization password.
 *
 * **Binlogging is deliberately left on.** Orchestrator has to log in to every
 * member, and a standby boots `read_only=ON, super_read_only=ON`
 * (`mysql-family` my.cnf), so it cannot mint the account itself — error 1290.
 * The primary's statements therefore have to reach the standbys through the
 * binlog, which is how the monitor roles already get there. A
 * `SET SESSION sql_log_bin = 0` wrapper would strand the account on the
 * primary and leave Orchestrator with `Error 1045 Access denied` on every
 * replica. The errant-GTID hazard that wrapper guards against does not arise
 * on this path: `applyManagedEngineState` runs credential SQL on writable
 * primaries only and returns early for a standby, so a replica never issues
 * these statements.
 *
 * Nothing names an authentication plugin, so the server's default is used:
 * MySQL 8.4/9.x mint `caching_sha2_password` and nothing references the
 * `mysql_native_password` plugin those releases no longer ship; MariaDB 11.x
 * uses its own default.
 */

import {
  createOrAlterAccountSql,
  MANAGED_DOCKER_NETWORK_HOST,
  quoteAccount,
  quoteIdentifier,
  quoteLiteral,
} from "./mysql-sql.ts";

export type OrchestratorTopologySqlDialect = "mysql" | "mariadb";

/**
 * Schema Orchestrator reads its cluster hints from
 * (`meta.cluster_domain_name`). A **database**-level grant does not require
 * the schema to exist, unlike a table-level one, so this is safe on an engine
 * that never creates it.
 */
const ORCHESTRATOR_META_SCHEMA = "meta";

/**
 * Replication table Orchestrator reads the channel's own source settings
 * from. Version- and engine-specific, and a table-level grant on a table the
 * release does not ship fails outright — which is why this grant is issued
 * on its own and treated as advisory by the caller.
 */
const REPLICATION_TABLE: Record<OrchestratorTopologySqlDialect, string> = {
  mysql: "mysql.slave_master_info",
  mariadb: "mysql.gtid_slave_pos",
};

/**
 * Private-network rows for the topology account: the Raft leader that
 * discovers and recovers a cluster can be any Orchestrator server of the
 * organization, and a member cannot list those addresses (see the module
 * comment). Datacenter servers talk over private addresses, so the rows cover
 * 10.0.0.0/8 and 192.168.0.0/16 (172.16.0.0/12 is the Docker-network row
 * above) and never a public address. The login still needs TLS and the
 * derived per-organization password.
 */
export const ORCHESTRATOR_TOPOLOGY_PRIVATE_HOSTS: readonly string[] = [
  "10.0.0.0/255.0.0.0",
  "192.168.0.0/255.255.0.0",
];

/** Every host the topology account (and its grants) exists at. */
function topologyAccountHosts(extraHosts: readonly string[]): string[] {
  return [
    ...new Set([
      MANAGED_DOCKER_NETWORK_HOST,
      ...extraHosts,
      ...ORCHESTRATOR_TOPOLOGY_PRIVATE_HOSTS,
    ]),
  ];
}

function accountAt(username: string, host: string): string {
  return `${quoteAccount(username)}@${quoteLiteral(host)}`;
}

/**
 * `REQUIRE SSL` binds TLS to the account itself, as it does for replication
 * and for the same reason: the server then refuses a plaintext topology login
 * however Orchestrator was configured. MySQL 8+ dropped the `REQUIRE` clause
 * from `GRANT`, so that dialect needs an `ALTER USER`; MariaDB keeps it on
 * `GRANT` and `GRANT USAGE` is the no-privilege carrier for it.
 */
function bindRequireSsl(
  account: string,
  dialect: OrchestratorTopologySqlDialect,
): string {
  if (dialect === "mariadb") {
    return `GRANT USAGE ON *.* TO ${account} REQUIRE SSL;`;
  }
  return `ALTER USER ${account} REQUIRE SSL;`;
}

/**
 * The smallest privilege set Orchestrator's topology discovery and recovery
 * checks work with: `PROCESS` and `REPLICATION CLIENT` read
 * `SHOW PROCESSLIST` and replica status; MariaDB 10.5.9+ also needs
 * `REPLICA MONITOR` (`SLAVE MONITOR`) for `SHOW REPLICA STATUS`. `RELOAD` is the `FLUSH`
 * during a recovery, `SUPER` sets `read_only` on a demoted primary, and
 * `SELECT` on the meta schema carries the cluster hints. No `SELECT` on
 * `mysql.*` or on `performance_schema`: the replica status Orchestrator reads
 * comes from `SHOW REPLICA STATUS` under `REPLICATION CLIENT`, and a wider
 * grant would hand it the credential tables.
 */
function grantOrchestratorTopologyPrivileges(
  account: string,
  dialect: OrchestratorTopologySqlDialect,
): string[] {
  const globalPrivs = dialect === "mariadb"
    ? "SUPER, PROCESS, REPLICATION CLIENT, RELOAD, REPLICA MONITOR"
    : "SUPER, PROCESS, REPLICATION CLIENT, RELOAD";
  return [
    `GRANT ${globalPrivs} ON *.* TO ${account};`,
    `GRANT SELECT ON ${
      quoteIdentifier(ORCHESTRATOR_META_SCHEMA)
    }.* TO ${account};`,
  ];
}

/**
 * Idempotent create/alter + grants for the organization's Orchestrator
 * topology account at every monitor-account host plus the private ranges. Safe to re-run on
 * every apply: `CREATE USER IF NOT EXISTS` then `ALTER USER … IDENTIFIED BY`
 * re-asserts the derived password without a drop.
 */
export function ensureOrchestratorTopologyAccountSql(
  username: string,
  password: string,
  extraHosts: readonly string[] = [],
  dialect: OrchestratorTopologySqlDialect = "mysql",
): string {
  const hosts = topologyAccountHosts(extraHosts);
  const lines: string[] = [];
  for (const host of hosts) {
    const account = accountAt(username, host);
    lines.push(
      createOrAlterAccountSql(username, password, host),
      ...grantOrchestratorTopologyPrivileges(account, dialect),
      bindRequireSsl(account, dialect),
    );
  }
  lines.push("FLUSH PRIVILEGES;");
  return lines.join("\n");
}

/**
 * The engine-specific replication table grant, on its own because it is the
 * one statement that can fail on a release that does not ship that table.
 * Orchestrator degrades to a warning without it, so the caller logs a refusal
 * rather than failing the apply.
 */
export function grantOrchestratorReplicationTableSql(
  username: string,
  extraHosts: readonly string[] = [],
  dialect: OrchestratorTopologySqlDialect = "mysql",
): string {
  const hosts = topologyAccountHosts(extraHosts);
  return hosts
    .map((host) =>
      `GRANT SELECT ON ${REPLICATION_TABLE[dialect]} TO ${
        accountAt(username, host)
      };`
    )
    .join("\n");
}
