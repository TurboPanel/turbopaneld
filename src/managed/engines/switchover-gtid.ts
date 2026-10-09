/**
 * GTID catch-up proof for planned MySQL-family switchover.
 *
 * The old primary is quiesced (read-only + ProxySQL drain) and its final GTID
 * position is captured before stop. The promotion target must prove it applied
 * that set before it is promoted.
 */

import { boundedGtid, GTID_MAX_LENGTH } from "./replica-freshness.ts";
import { switchoverPromoteErrorMessage } from "./switchover-promote-error.ts";

/** Default wait; keep >=30s under managed command budgets that cap near 120s. */
export const SWITCHOVER_GTID_WAIT_DEFAULT_SECONDS = 90;

export type GtidWaitEngineFamily = "mysql" | "mariadb";

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
  return `the promotion target did not apply the old primary GTID position within ${timeoutSeconds}s`;
}

export function gtidWaitFailedMessage(detail?: string): string {
  if (detail && detail.length > 0) {
    return `switchover GTID wait failed: ${detail}`;
  }
  return "switchover GTID wait failed";
}

export function gtidSetTooLongForWire(length: number): boolean {
  return length > GTID_MAX_LENGTH;
}

function gtidComponents(set: string): string[] {
  return set.split(",").map((part) => part.trim()).filter(Boolean);
}

function domainId(component: string): string {
  return component.split("-")[0] ?? "";
}

/**
 * Drop server-local errant domains from the wait set (for example provisioning
 * artifacts) while keeping the replication domain the target receives.
 */
export function filterGtidSetForSwitchoverWait(
  required: string,
  targetReceived: string,
): string {
  const requiredParts = gtidComponents(required);
  if (requiredParts.length === 0) return required;
  const receivedDomainIds = new Set(
    gtidComponents(targetReceived).map(domainId),
  );
  const kept = requiredParts.filter((part) => {
    const domain = domainId(part);
    if (domain === "0") return true;
    return receivedDomainIds.has(domain);
  });
  if (kept.length > 0) return kept.join(",");
  const replicationOnly = requiredParts.filter((part) =>
    domainId(part) === "0"
  );
  return replicationOnly.length > 0 ? replicationOnly.join(",") : required;
}

export async function quiesceAndReadPrimaryGtid(
  enforceReadOnly: () => Promise<void>,
  readGtidSet: () => Promise<string>,
  restoreWritable?: () => Promise<void>,
): Promise<string> {
  await enforceReadOnly();
  try {
    const gtid = boundedGtid((await readGtidSet()).trim());
    if (!gtid) {
      throw new Error("switchover: could not read primary GTID position");
    }
    return gtid;
  } catch (error) {
    if (restoreWritable) {
      try {
        await restoreWritable();
      } catch {
        // Best effort: the control plane may still reactivate the primary.
      }
    }
    throw error;
  }
}

function interpretGtidWaitResult(
  code: string | null,
  timeoutSeconds: number,
  family: GtidWaitEngineFamily,
): void {
  if (code === "0") return;
  const timedOut = code === "1" || (family === "mariadb" && code === "-1");
  if (timedOut) {
    throw new Error(
      switchoverPromoteErrorMessage(
        "gtid_wait_timeout",
        gtidWaitTimedOutMessage(timeoutSeconds),
      ),
    );
  }
  if (code === null) {
    throw new Error(
      switchoverPromoteErrorMessage(
        "gtid_wait_error",
        gtidWaitFailedMessage(),
      ),
    );
  }
  throw new Error(
    switchoverPromoteErrorMessage(
      "gtid_wait_error",
      gtidWaitFailedMessage(`unexpected wait result ${code}`),
    ),
  );
}

export async function waitForRequiredGtidSet(
  runScalarQuery: (sql: string) => Promise<string>,
  waitSql: (gtidSet: string, timeoutSeconds: number) => string,
  requiredExecutedGtidSet: string,
  gtidWaitTimeoutSeconds: number,
  family: GtidWaitEngineFamily,
): Promise<void> {
  const gtidSet = assertBoundedSwitchoverGtidSet(requiredExecutedGtidSet);
  const timeout = Math.max(1, Math.floor(gtidWaitTimeoutSeconds));
  const out = await runScalarQuery(waitSql(gtidSet, timeout));
  interpretGtidWaitResult(parseGtidWaitScalar(out), timeout, family);
}
