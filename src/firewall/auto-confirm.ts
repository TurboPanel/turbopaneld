/**
 * The daemon confirms its own firewall change (`fw-auto-confirm`).
 *
 * Once a ruleset is live and pending, the daemon makes one fresh authenticated
 * round trip to the control plane (`GET /api/daemon/v1/ping`, through the
 * normal daemon token). If that answers, the daemon runs the same confirm the
 * `server.firewall.confirm` command runs, which makes the rules durable and
 * cancels the rollback timer. If the round trip fails, times out or there is
 * no control-plane client, it does nothing: the root guard rolls the ruleset
 * back at the deadline.
 *
 * The control plane runs no test and no outside probe, and no human clicks
 * anything. Be plain about what this proves: outbound traffic is never
 * filtered, so it shows the daemon, its token and the control plane are all
 * fine after the rules loaded. It cannot show inbound access (SSH, public
 * ports) still works.
 */

import { logInfo, logWarn, sanitizeForLog } from "../util/logger.ts";
import {
  confirmPendingFirewall,
  type FirewallConfirmOptions,
} from "./confirm.ts";

/** Time for the freshly loaded rules to settle before the check. */
export const AUTO_CONFIRM_SETTLE_MS = 2_000;
/** The check gives up after this long; the confirm window is 120 s. */
export const AUTO_CONFIRM_CHECK_TIMEOUT_MS = 20_000;

export type FirewallAutoConfirmResult = {
  /** True when the pending ruleset is now confirmed (by this call). */
  confirmed: boolean;
  /** Why, in plain words; goes into the reconcile result. */
  reason: string;
};

export type FirewallAutoConfirmOptions = FirewallConfirmOptions & {
  /** Resolves when an authenticated round trip to the control plane worked; rejects otherwise. Absent: no check, no confirm. */
  verifyControlPlane?: () => Promise<void>;
  settleMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function withTimeout(
  work: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`no answer within ${timeoutMs} ms`)),
      timeoutMs,
    );
  });
  try {
    await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function autoConfirmFirewall(
  digest: string,
  options: FirewallAutoConfirmOptions = {},
): Promise<FirewallAutoConfirmResult> {
  const verify = options.verifyControlPlane;
  if (!verify) {
    return {
      confirmed: false,
      reason:
        "the daemon has no control-plane connection to check with; the ruleset rolls back unless confirmed",
    };
  }
  const sleep = options.sleep ?? defaultSleep;
  await sleep(options.settleMs ?? AUTO_CONFIRM_SETTLE_MS);
  try {
    await withTimeout(
      verify(),
      options.timeoutMs ?? AUTO_CONFIRM_CHECK_TIMEOUT_MS,
    );
  } catch (err) {
    const detail = sanitizeForLog(err);
    logWarn(
      "firewall",
      `control-plane check after the firewall change failed, leaving the rollback timer armed: ${detail}`,
    );
    return {
      confirmed: false,
      reason:
        `the daemon could not reach the control plane after the change (${detail}); the host rolls back at the deadline`,
    };
  }
  try {
    const outcome = await confirmPendingFirewall(digest, options);
    if (outcome.state === "confirmed") {
      logInfo("firewall", "firewall change auto-confirmed by the daemon");
      return {
        confirmed: true,
        reason:
          "the daemon reached the control plane after the rules went live and confirmed the change itself",
      };
    }
    return {
      confirmed: false,
      reason:
        `the control-plane check passed but the confirm answered ${outcome.state}: ${outcome.summary}`,
    };
  } catch (err) {
    return {
      confirmed: false,
      reason: `the control-plane check passed but the confirm failed (${
        sanitizeForLog(err)
      }); the host rolls back at the deadline`,
    };
  }
}
