import type { ManagedEngineCode } from "../../contracts/commands-contracts.ts";

/** GTID set the replica received from its upstream (for errant-domain filtering). */
export function replicationGtidReceivedSql(engine: ManagedEngineCode): string {
  if (engine === "mariadb") {
    return "SELECT @@GLOBAL.gtid_slave_pos;";
  }
  if (engine === "mysql") {
    return [
      "SELECT REPLACE(COALESCE(RECEIVED_TRANSACTION_SET, ''), CHAR(10), '')",
      "FROM performance_schema.replication_connection_status",
      "WHERE CHANNEL_NAME = '' LIMIT 1;",
    ].join(" ");
  }
  throw new Error(
    "switchover: GTID received position is only for MySQL-family engines",
  );
}
