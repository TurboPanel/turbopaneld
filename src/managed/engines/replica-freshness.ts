/**
 * Replica freshness for MySQL and MariaDB: what a replica has received and
 * applied, as GTID sets, so the control plane can tell a caught-up replica
 * from a lagging one when the primary's whole host is gone (the Postgres
 * equivalent compares received and replay LSN).
 *
 * Pure parsers over engine output. Every failure yields NO freshness fields,
 * never `fullyApplied: true`: a missing field is "unknown" and the control
 * plane refuses on unknown. `fullyApplied` only says the replica applied
 * everything it had received; it cannot know what it never received, which is
 * why the control plane also requires a recent streaming observation.
 */

/** GTID text longer than this is dropped (and the reading is unknown). */
export const GTID_MAX_LENGTH = 4096;
const GTID_TEXT_RE = /^[0-9A-Za-z:\-, ._]*$/;
const DEFAULT_RECEIPT_LIMIT_SECONDS = 5;

export type ReplicaFreshness = {
  receivedGtid?: string;
  executedGtid?: string;
  /** Absent when it cannot be proved either way. */
  fullyApplied?: boolean;
  /** Seconds since the IO thread was last known receiving; absent if not. */
  receiptAgeSeconds?: number;
  /** Daemon-internal: oldest receipt age that still counts as receiving. */
  receiptAgeLimitSeconds?: number;
};

/** Trimmed GTID text, or `undefined` when too long or not GTID-shaped. */
export function boundedGtid(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const text = raw.replaceAll(/[\r\n]/g, "").trim();
  if (text === "NULL") return "";
  if (text.length > GTID_MAX_LENGTH || !GTID_TEXT_RE.test(text)) {
    return undefined;
  }
  return text;
}

function nonNegativeSeconds(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "" || raw === "NULL") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeGtidList(text: string): string {
  return text.split(",").map((part) => part.trim()).filter(Boolean).sort((
    a,
    b,
  ) => a.localeCompare(b))
    .join(",");
}

/**
 * The GTID fields for a received/executed pair. Empty sets are left out
 * (unknown, never `""`); `fullyApplied` needs both sets, and `applied` says
 * whether the engine proved it (undefined: cannot tell).
 */
function gtidFields(
  received: string,
  executed: string,
  applied: boolean | undefined,
): ReplicaFreshness {
  const out: ReplicaFreshness = {};
  if (received !== "") out.receivedGtid = received;
  if (executed !== "") out.executedGtid = executed;
  if (received !== "" && executed !== "" && applied !== undefined) {
    out.fullyApplied = applied;
  }
  return out;
}

function mysqlReceipt(cols: string[]): ReplicaFreshness {
  if (cols[0].trim().toUpperCase() !== "ON") return {};
  const ages = [cols[4], cols[5]].map(nonNegativeSeconds).filter((age) =>
    age !== undefined
  );
  if (ages.length === 0) return {};
  const interval = nonNegativeSeconds(cols[6]);
  return {
    receiptAgeSeconds: Math.min(...ages),
    receiptAgeLimitSeconds: interval === undefined
      ? DEFAULT_RECEIPT_LIMIT_SECONDS
      : Math.max(DEFAULT_RECEIPT_LIMIT_SECONDS, Math.ceil(interval * 2) + 1),
  };
}

/**
 * MySQL: one tab-separated row (`mysql -N -B`) of `io_state`, received set,
 * executed set, `GTID_SUBSET(received, executed)`, seconds since the last
 * heartbeat, seconds since the last queued transaction, heartbeat interval
 * (see `replicaFreshnessSql` in `mysql-sql.ts`).
 */
export function parseMysqlFreshness(stdout: string): ReplicaFreshness {
  const lines = stdout.split("\n").filter((line) => line.trim() !== "");
  if (lines.length !== 1) return {};
  const cols = lines[0].replace(/\r$/, "").split("\t");
  if (cols.length !== 7) return {};
  const received = boundedGtid(cols[1]);
  const executed = boundedGtid(cols[2]);
  if (received === undefined || executed === undefined) return {};
  // Nothing received since this server started (the set resets on restart)
  // proves nothing about the source: unknown, not "applied".
  const applied = { "1": true, "0": false }[cols[3]];
  return { ...gtidFields(received, executed, applied), ...mysqlReceipt(cols) };
}

/**
 * MariaDB: vertical `SHOW SLAVE STATUS` followed by
 * `SELECT @@GLOBAL.gtid_slave_pos AS gtid_slave_pos`. Received is
 * `Gtid_IO_Pos`, applied is `gtid_slave_pos`; equal means fully applied.
 * Requires `Using_Gtid` of Slave_Pos or Current_Pos, else the GTID fields are
 * unknown. `Slave_IO_Running: Yes` is the only receiving signal MariaDB gives
 * (no heartbeat timestamp), so it counts as receipt now. It only shows the IO
 * thread is connected: it stays Yes until `slave_net_timeout` (~60 s) after
 * the source dies, so `ageMs` from it is NOT proof the source was alive; a
 * gate must also rely on `fullyApplied` and peer evidence.
 */
export function parseMariadbFreshness(verbose: string): ReplicaFreshness {
  const fields = new Map<string, string>();
  for (const line of verbose.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (key.length > 0) fields.set(key, line.slice(idx + 1).trim());
  }
  if (!fields.has("Gtid_IO_Pos") || !fields.has("gtid_slave_pos")) return {};
  const received = boundedGtid(fields.get("Gtid_IO_Pos"));
  const executed = boundedGtid(fields.get("gtid_slave_pos"));
  if (received === undefined || executed === undefined) return {};
  // With binlog-position replication both positions can be stale yet equal:
  // only GTID replication makes them a proof.
  const usingGtid = (fields.get("Using_Gtid") ?? "").toLowerCase();
  const gtid = usingGtid === "slave_pos" || usingGtid === "current_pos"
    ? gtidFields(
      received,
      executed,
      normalizeGtidList(received) === normalizeGtidList(executed),
    )
    : {};
  const io = (fields.get("Slave_IO_Running") ?? "").toLowerCase();
  return io === "yes" ? { ...gtid, receiptAgeSeconds: 0 } : gtid;
}
