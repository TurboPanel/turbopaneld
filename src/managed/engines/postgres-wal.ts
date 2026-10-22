/**
 * Postgres final write position of a cleanly stopped primary.
 *
 * A planned switchover must prove the new primary replayed everything the old
 * one wrote. `pg_controldata` does not hold the end of the WAL: "Latest
 * checkpoint location" (and its REDO location) is where the shutdown
 * checkpoint record STARTS, while a caught-up standby reports
 * `pg_last_wal_replay_lsn()` = where that record ENDS. So the end is worked
 * out here: the record's length comes from `pg_waldump`, and the end walks
 * past a WAL page boundary (page header 24 bytes, 40 at a segment start) and
 * rounds up to 8 bytes, exactly like the standby's replay position.
 *
 * Measured on postgres:18 (18.6), one standby streaming under write load,
 * clean stop: checkpoint location 0/7257FC0, record 114 bytes crossing the
 * 0/7258000 page boundary, computed end 0/7258050, standby replay 0/7258050.
 *
 * Every function fails closed: an unreadable or unexpected input returns
 * `null` and the caller reports no position.
 */

const MAX_ALIGN = 8n;
const PAGE_HEADER = 24n;
const LONG_PAGE_HEADER = 40n;
const LSN_PATTERN = /^([0-9A-Fa-f]{1,8})\/([0-9A-Fa-f]{1,8})$/;
const WALDUMP_RECORD =
  /len \(rec\/tot\):\s*\d+\/\s*(\d+),.*?lsn: ([0-9A-Fa-f]+\/[0-9A-Fa-f]+),.*?desc: (\S+)/;

export function parseLsn(value: string): bigint | null {
  const match = LSN_PATTERN.exec(value.trim());
  if (!match) return null;
  return (BigInt(`0x${match[1]}`) << 32n) | BigInt(`0x${match[2]}`);
}

export function formatLsn(value: bigint): string {
  const high = (value >> 32n).toString(16).toUpperCase();
  const low = (value & 0xffffffffn).toString(16).toUpperCase();
  return `${high}/${low}`;
}

export type WalGeometry = { blockSize: number; segmentSize: number };

/**
 * Where a WAL record of `totalLength` bytes starting at `start` ends: the
 * position a standby reports after replaying it.
 */
export function walRecordEnd(
  start: bigint,
  totalLength: number,
  geometry: WalGeometry,
): bigint {
  const block = BigInt(geometry.blockSize);
  const segment = BigInt(geometry.segmentSize);
  let position = start;
  let remaining = BigInt(totalLength);
  for (;;) {
    const room = block - (position % block);
    if (remaining <= room) {
      position += remaining;
      break;
    }
    remaining -= room;
    position += room;
    position += position % segment === 0n ? LONG_PAGE_HEADER : PAGE_HEADER;
  }
  const rest = position % MAX_ALIGN;
  return rest === 0n ? position : position + (MAX_ALIGN - rest);
}

export type PostgresControlData = {
  state: string;
  checkpointLsn: bigint;
  redoLsn: bigint;
  timeline: number;
  geometry: WalGeometry;
};

function controlValue(text: string, key: string): string | null {
  for (const line of text.split("\n")) {
    if (line.startsWith(`${key}:`)) return line.slice(key.length + 1).trim();
  }
  return null;
}

function positiveInt(value: string | null): number | null {
  if (value === null || !/^\d{1,10}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Parse `pg_controldata` output taken with `LC_ALL=C`. */
export function parseControlData(text: string): PostgresControlData | null {
  const state = controlValue(text, "Database cluster state");
  const checkpoint = controlValue(text, "Latest checkpoint location");
  const redo = controlValue(text, "Latest checkpoint's REDO location");
  const timeline = positiveInt(
    controlValue(text, "Latest checkpoint's TimeLineID"),
  );
  const blockSize = positiveInt(controlValue(text, "Database block size"));
  const segmentSize = positiveInt(controlValue(text, "Bytes per WAL segment"));
  if (state === null || checkpoint === null || redo === null) return null;
  if (timeline === null || blockSize === null || segmentSize === null) {
    return null;
  }
  const checkpointLsn = parseLsn(checkpoint);
  const redoLsn = parseLsn(redo);
  if (checkpointLsn === null || redoLsn === null) return null;
  return {
    state,
    checkpointLsn,
    redoLsn,
    timeline,
    geometry: { blockSize, segmentSize },
  };
}

/**
 * The total length of the shutdown checkpoint record `pg_waldump` printed at
 * `checkpoint`, or null when the first record is anything else.
 */
export function parseWaldumpShutdownRecord(
  output: string,
  checkpoint: bigint,
): number | null {
  for (const line of output.split("\n")) {
    const match = WALDUMP_RECORD.exec(line);
    if (!match) continue;
    if (match[3] !== "CHECKPOINT_SHUTDOWN") return null;
    if (parseLsn(match[2]) !== checkpoint) return null;
    const total = Number(match[1]);
    return Number.isSafeInteger(total) && total > 0 ? total : null;
  }
  return null;
}

export type FinalWalPosition = { lsn: string; timeline: number };

/**
 * The final write position of a primary that shut down cleanly, from the
 * `pg_controldata` and `pg_waldump` output of its stopped data directory.
 * Null unless the cluster state is exactly `shut down`, the checkpoint and its
 * REDO location agree (a shutdown checkpoint), and the record at that
 * location is the shutdown checkpoint.
 */
export function finalWalPositionFromOutput(
  controlData: string,
  waldump: string,
): FinalWalPosition | null {
  const control = parseControlData(controlData);
  if (control === null || control.state !== "shut down") return null;
  if (control.checkpointLsn !== control.redoLsn) return null;
  const total = parseWaldumpShutdownRecord(waldump, control.checkpointLsn);
  if (total === null) return null;
  const end = walRecordEnd(control.checkpointLsn, total, control.geometry);
  return { lsn: formatLsn(end), timeline: control.timeline };
}

/** Shell script run in the engine image: prints both outputs, `@@@` apart. */
export const FINAL_POSITION_SCRIPT = [
  'D="$1"',
  'out=$(pg_controldata "$D") || exit 1',
  "printf '%s\\n' \"$out\"",
  "echo '@@@'",
  "l=$(printf '%s\\n' \"$out\" | sed -n 's/^Latest checkpoint location: *//p')",
  'pg_waldump -p "$D/pg_wal" -s "$l" -n 1 2>/dev/null || true',
].join("\n");

export const FINAL_POSITION_SEPARATOR = "@@@";
