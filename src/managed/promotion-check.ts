/**
 * Read-only check that the local member of a managed cluster really is a
 * primary after an automatic failover: no longer a replica, and (MySQL family)
 * every read-only flag off. Orchestrator's recover call can answer OK without
 * promoting anyone, so the failover handler checks the engine itself.
 */

import type { ManagedEngineCode } from "../contracts/commands-contracts.ts";
import { isWritableSql as mariadbIsWritableSql } from "./engines/mariadb-sql.ts";
import { isWritableSql as mysqlIsWritableSql } from "./engines/mysql-sql.ts";
import { parseSqlBool } from "./engines/sql-bool.ts";
import {
  type LocalEngineContextDeps,
  resolveLocalReplicationEngine,
} from "./local-engine-context.ts";

export type PromotionCheck =
  | { promoted: true }
  | { promoted: false; reason: string };

/**
 * Decide from the engine's answers. `readOnlyRow` is the raw output of the
 * engine's `isWritableSql()` (MySQL: read_only and super_read_only; MariaDB:
 * read_only), or `undefined` for engines that have no such flag. Every flag
 * must read strictly off; a value we cannot parse counts as still read-only.
 */
export function decidePromotion(
  stillReplica: boolean,
  readOnlyRow: string | undefined,
): PromotionCheck {
  if (stillReplica) {
    return { promoted: false, reason: "still a replica" };
  }
  if (readOnlyRow === undefined) return { promoted: true };
  const cells = readOnlyRow.trim().split(/\s+/).filter((c) => c.length > 0);
  if (cells.length === 0 || cells.some((c) => parseSqlBool(c) !== false)) {
    return {
      promoted: false,
      reason: `still read-only (${readOnlyRow.trim() || "no answer"})`,
    };
  }
  return { promoted: true };
}

function readOnlySqlFor(engine: ManagedEngineCode | undefined) {
  if (engine === "mysql") return mysqlIsWritableSql();
  if (engine === "mariadb") return mariadbIsWritableSql();
  return undefined;
}

export async function checkLocalMemberPromoted(
  params: { managedId: string; engine?: ManagedEngineCode },
  deps?: LocalEngineContextDeps,
): Promise<PromotionCheck> {
  const { engine, ctx } = await resolveLocalReplicationEngine(
    params.managedId,
    params.engine,
    "managed.ha.failover",
    deps,
  );
  const replication = engine.replication!;
  const stillReplica = await replication.isStandby(ctx);
  const sql = readOnlySqlFor(params.engine);
  if (sql === undefined || stillReplica) {
    return decidePromotion(stillReplica, undefined);
  }
  if (!replication.runAdminScalarQuery) {
    return { promoted: false, reason: "read-only state cannot be read" };
  }
  const row = await replication.runAdminScalarQuery(ctx, sql);
  return decidePromotion(false, row);
}
