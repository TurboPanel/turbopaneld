/**
 * TCP retransmission percent from `/proc/net/snmp`'s `Tcp:` block and
 * `/proc/net/netstat`'s `TcpExt:` block — both are two-line
 * (header, values) blocks where column order can vary by kernel build, so
 * every field is looked up by column name, never a fixed index.
 */
import type { CounterBaselineTracker } from "./baseline.ts";

/**
 * Extract one named column's value from a `label:`-prefixed two-line block
 * (header line then values line, both starting with `label:`). `null` when
 * the label or column isn't present.
 */
function parseTwoLineBlockColumn(
  text: string,
  label: string,
  column: string,
): number | null {
  const lines = text.split("\n");
  let headerFields: string[] | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(`${label}:`)) continue;
    const fields = trimmed.slice(label.length + 1).trim().split(/\s+/);
    if (headerFields === null) {
      headerFields = fields;
      continue;
    }
    const index = headerFields.indexOf(column);
    if (index < 0 || index >= fields.length) return null;
    const value = Number(fields[index]);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

/** `RetransSegs` from `/proc/net/snmp`'s `Tcp:` block. */
export function parseSnmpRetransSegs(text: string): number | null {
  return parseTwoLineBlockColumn(text, "Tcp", "RetransSegs");
}

/**
 * `TCPOrigDataSent` from `/proc/net/netstat`'s `TcpExt:` block. `null` when
 * the column doesn't exist (older kernels) — no fallback to `TcpOutSegs`;
 * an unavailable preferred counter means the metric is unavailable, not a
 * silently swapped denominator.
 */
export function parseNetstatTcpOrigDataSent(text: string): number | null {
  return parseTwoLineBlockColumn(text, "TcpExt", "TCPOrigDataSent");
}

function clampPercent(value: number): number {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

/**
 * Percent of data segments retransmitted this interval:
 * `retransDelta / (origSentDelta + retransDelta) * 100`. `null` when either
 * counter is unsupported/unreadable, on first observation, across a reset,
 * or when there's no transmitted data this interval (`0/0`).
 */
export function tcpRetransmitPercent(
  currRetrans: number | null,
  currOrigSent: number | null,
  tracker: CounterBaselineTracker,
  bootGeneration: number,
): number | null {
  if (currRetrans === null || currOrigSent === null) return null;

  const retransDelta = tracker.delta(
    "tcp:host:retransSegs",
    currRetrans,
    bootGeneration,
  );
  const origSentDelta = tracker.delta(
    "tcp:host:origDataSent",
    currOrigSent,
    bootGeneration,
  );
  if (retransDelta === null || origSentDelta === null) return null;

  const denominator = origSentDelta + retransDelta;
  if (denominator <= 0) return null;

  return clampPercent((retransDelta / denominator) * 100);
}
