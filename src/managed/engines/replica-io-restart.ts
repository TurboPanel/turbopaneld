/**
 * Decide whether a MySQL-family replica whose IO thread has given up should
 * be started again. A thread that exhausted SOURCE_RETRY_COUNT /
 * MASTER_RETRY_COUNT stays stopped even after the primary returns; health
 * polls can restart it only for connection errors, never applier/GTID errors.
 */

export type ReplicaIoThreadState = "yes" | "connecting" | "no";

export type ReplicaIoRestartObservation = {
  ioRunning: ReplicaIoThreadState;
  sqlRunning: boolean;
  lastIoErrno: number;
  lastSqlErrno: number;
  lastIoError: string;
  lastSqlError: string;
  primaryReachable: boolean;
};

/** Client "cannot reach the source" numbers — never data or GTID. */
const CONNECTION_ERRNOS = new Set([
  1042, // can't get hostname
  1043, // bad handshake
  1129, // host is blocked
  1152, // aborted connection
  1184, // aborted connection
  2002, // cannot connect through socket
  2003, // cannot connect to server
  2005, // unknown host
  2006, // server has gone away
  2013, // lost connection
]);

/** Purged binlog / GTID / position errors — restarting will not heal these. */
const DATA_OR_GTID_ERRNOS = new Set([
  1236, // could not find log event (purged / wrong position)
  1593, // fatal error in replication
  1782, // @@GLOBAL.gtid_purged cannot be changed
  1794, // replica is not configured or failed to initialize
  1872, // replica failed to initialize GTID
  13114, // GTID consistency
]);

const CONNECTION_ERROR_RE =
  /can't connect|cannot connect|connection refused|connection timed out|lost connection|server has gone away|unknown host|name or service not known|no route to host|host is blocked|aborted connection/i;

const DATA_OR_GTID_ERROR_RE =
  /gtid|purged|could not parse|duplicate entry|could not execute|error in replication|wrong position|could not find first log|sql_slave_skip|relay log/i;

function parseThreadState(value: string | undefined): ReplicaIoThreadState {
  const normalized = (value ?? "No").trim().toLowerCase();
  if (normalized === "yes") return "yes";
  if (normalized === "connecting") return "connecting";
  return "no";
}

function parseErrno(value: string | undefined): number {
  const n = Number((value ?? "0").trim());
  return Number.isFinite(n) ? n : 0;
}

function fieldMap(verbose: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of verbose.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key.length > 0) fields.set(key, value);
  }
  return fields;
}

function firstField(
  fields: Map<string, string>,
  names: readonly string[],
): string {
  for (const name of names) {
    const value = fields.get(name);
    if (value !== undefined) return value;
  }
  return "";
}

export function parseReplicaIoStatus(verbose: string): {
  ioRunning: ReplicaIoThreadState;
  sqlRunning: boolean;
  lastIoErrno: number;
  lastSqlErrno: number;
  lastIoError: string;
  lastSqlError: string;
  sourceHost: string;
  sourcePort: number;
} {
  const fields = fieldMap(verbose);
  const portRaw = firstField(fields, ["Source_Port", "Master_Port"]);
  const port = Number(portRaw);
  return {
    ioRunning: parseThreadState(
      firstField(fields, ["Replica_IO_Running", "Slave_IO_Running"]),
    ),
    sqlRunning: parseThreadState(
      firstField(fields, ["Replica_SQL_Running", "Slave_SQL_Running"]),
    ) === "yes",
    lastIoErrno: parseErrno(
      firstField(fields, ["Last_IO_Errno", "Last_IO_Error_Number"]),
    ),
    lastSqlErrno: parseErrno(
      firstField(fields, ["Last_SQL_Errno", "Last_SQL_Error_Number"]),
    ),
    lastIoError: firstField(fields, ["Last_IO_Error"]),
    lastSqlError: firstField(fields, ["Last_SQL_Error"]),
    sourceHost: firstField(fields, ["Source_Host", "Master_Host"]),
    sourcePort: Number.isFinite(port) && port > 0 ? port : 0,
  };
}

export function isReplicationConnectionError(
  errno: number,
  message: string,
): boolean {
  if (DATA_OR_GTID_ERRNOS.has(errno)) return false;
  if (CONNECTION_ERRNOS.has(errno)) return true;
  if (errno !== 0) return false;
  if (DATA_OR_GTID_ERROR_RE.test(message)) return false;
  return CONNECTION_ERROR_RE.test(message);
}

export function isReplicationApplierError(
  sqlErrno: number,
  sqlError: string,
): boolean {
  if (sqlErrno !== 0) return true;
  return DATA_OR_GTID_ERROR_RE.test(sqlError);
}

/**
 * Restart IO/SQL only when a thread is actually stopped (not still
 * `Connecting`), the last error is a source connection failure, the SQL
 * applier is clean, and a TCP probe already reached the primary.
 */
export function shouldRestartReplicaThreads(
  obs: ReplicaIoRestartObservation,
): boolean {
  if (!obs.primaryReachable) return false;
  if (isReplicationApplierError(obs.lastSqlErrno, obs.lastSqlError)) {
    return false;
  }
  const ioStopped = obs.ioRunning === "no";
  const sqlStopped = !obs.sqlRunning;
  if (!ioStopped && !sqlStopped) return false;
  if (DATA_OR_GTID_ERRNOS.has(obs.lastIoErrno)) return false;
  if (DATA_OR_GTID_ERROR_RE.test(obs.lastIoError)) return false;
  return isReplicationConnectionError(obs.lastIoErrno, obs.lastIoError);
}

export function replicaPrimaryPingArgv(
  pingBin: "mysqladmin" | "mariadb-admin",
  host: string,
  port: number,
  username: string,
): string[] {
  return [
    pingBin,
    "ping",
    "--protocol=tcp",
    "--host",
    host,
    "--port",
    String(port),
    "--connect-timeout",
    "3",
    "-u",
    username,
  ];
}

/** TCP listener up, including access-denied (the replica uses a different login). */
export function replicaPrimaryLooksReachable(result: {
  success: boolean;
  stdout: string;
  stderr: string;
}): boolean {
  if (result.success) return true;
  const text = `${result.stderr}\n${result.stdout}`;
  return text.includes("1045") || text.toLowerCase().includes("access denied");
}

export async function healStoppedReplicaIo(options: {
  verbose: string;
  startSql: string;
  runSql: (sql: string) => Promise<void>;
  pingPrimary: (host: string, port: number) => Promise<boolean>;
}): Promise<boolean> {
  const status = parseReplicaIoStatus(options.verbose);
  if (status.sourceHost.length === 0 || status.sourcePort <= 0) return false;
  const sketch: Omit<ReplicaIoRestartObservation, "primaryReachable"> = {
    ioRunning: status.ioRunning,
    sqlRunning: status.sqlRunning,
    lastIoErrno: status.lastIoErrno,
    lastSqlErrno: status.lastSqlErrno,
    lastIoError: status.lastIoError,
    lastSqlError: status.lastSqlError,
  };
  if (
    !shouldRestartReplicaThreads({ ...sketch, primaryReachable: true })
  ) {
    return false;
  }
  const reachable = await options.pingPrimary(
    status.sourceHost,
    status.sourcePort,
  );
  if (!reachable) return false;
  try {
    await options.runSql(options.startSql);
    return true;
  } catch {
    return false;
  }
}
