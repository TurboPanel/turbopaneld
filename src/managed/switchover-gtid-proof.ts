/**
 * Shared GTID catch-up proof before promotion (direct promote and Orchestrator recover).
 */

import type { ManagedEngineCode } from "../contracts/commands-contracts.ts";
import {
  type LocalEngineContextDeps,
  resolveLocalReplicationEngine,
} from "./local-engine-context.ts";
import { masterGtidWaitSql } from "./engines/mariadb-sql.ts";
import { waitForExecutedGtidSetSql } from "./engines/mysql-sql.ts";
import { replicationGtidReceivedSql } from "./engines/switchover-gtid-sql.ts";
import {
  filterGtidSetForSwitchoverWait,
  SWITCHOVER_GTID_WAIT_DEFAULT_SECONDS,
  waitForRequiredGtidSet,
} from "./engines/switchover-gtid.ts";

export type SwitchoverGtidProofParams = {
  managedId: string;
  engine?: ManagedEngineCode;
  requiredExecutedGtidSet: string;
  gtidWaitTimeoutSeconds?: number;
};

export async function proveSwitchoverGtidBeforePromote(
  params: SwitchoverGtidProofParams,
  deps?: LocalEngineContextDeps,
): Promise<void> {
  const engineCode = params.engine ?? "postgres";
  if (engineCode !== "mysql" && engineCode !== "mariadb") {
    throw new Error("switchover: GTID proof is only for MySQL-family engines");
  }
  const { engine, ctx } = await resolveLocalReplicationEngine(
    params.managedId,
    params.engine,
    "managed.promote",
    deps,
  );
  const replication = engine.replication;
  const runQuery = replication?.runAdminScalarQuery;
  if (!runQuery) {
    throw new Error("switchover: GTID proof is not supported for this engine");
  }
  const timeout = params.gtidWaitTimeoutSeconds ??
    SWITCHOVER_GTID_WAIT_DEFAULT_SECONDS;
  const received = (await runQuery(
    ctx,
    replicationGtidReceivedSql(engineCode),
  )).trim();
  const waitSet = filterGtidSetForSwitchoverWait(
    params.requiredExecutedGtidSet,
    received,
  );
  const family = engineCode === "mariadb" ? "mariadb" : "mysql";
  const waitSql = family === "mariadb"
    ? masterGtidWaitSql
    : waitForExecutedGtidSetSql;
  await waitForRequiredGtidSet(
    (sql) => runQuery(ctx, sql),
    waitSql,
    waitSet,
    timeout,
    family,
  );
}
