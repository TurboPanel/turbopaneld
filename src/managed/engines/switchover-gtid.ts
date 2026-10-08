/**
 * GTID catch-up proof for planned MySQL-family switchover.
 *
 * The old primary is quiesced (read-only + ProxySQL drain) and its final GTID
 * position is captured before stop. The promotion target must prove it applied
 * that set before it is promoted.
 */

import { boundedGtid, GTID_MAX_LENGTH } from "./replica-freshness.ts";

export const SWITCHOVER_GTID_WAIT_DEFAULT_SECONDS = 120;

export function parseGtidWaitScalar(stdout: string): string | null {
  const line = stdout.trim().split(/\s+/)[0];
  if (line === undefined || line.length === 0) return null;
  if (line === "NULL") return null;
  return line;
}

export function assertBoundedSwitchoverGtidSet(raw: string): string {
  const gtid = boundedGtid(raw.trim());
  if (!gtid) {
    throw new Error("switchover: invalid required GTID set");
  }
  return gtid;
}

export function gtidWaitTimedOutMessage(timeoutSeconds: number): string {
  return `switchover gtid wait timed out after ${timeoutSeconds}s`;
}

export function gtidWaitFailedMessage(): string {
  return "switchover gtid wait failed";
}

export function gtidSetTooLongForWire(length: number): boolean {
  return length > GTID_MAX_LENGTH;
}

export async function waitForRequiredGtidSet(
  runScalarQuery: (sql: string) => Promise<string>,
  waitSql: (gtidSet: string, timeoutSeconds: number) => string,
  requiredExecutedGtidSet: string,
  gtidWaitTimeoutSeconds: number,
): Promise<void> {
  const gtidSet = assertBoundedSwitchoverGtidSet(requiredExecutedGtidSet);
  const timeout = Math.max(1, Math.floor(gtidWaitTimeoutSeconds));
  const out = await runScalarQuery(waitSql(gtidSet, timeout));
  const code = parseGtidWaitScalar(out);
  if (code === "0") return;
  if (code === "1") {
    throw new Error(gtidWaitTimedOutMessage(timeout));
  }
  throw new Error(gtidWaitFailedMessage());
}
