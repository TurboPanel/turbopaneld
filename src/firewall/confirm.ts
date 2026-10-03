/**
 * Confirm a pending firewall ruleset: promote the pending documents to the
 * durable ones and disarm the rollback guard. See `./pending.ts` for the model.
 *
 * Idempotent by construction: once confirmed there is no marker, so a second
 * confirm reports `nothing_pending`. A confirm that arrives after the window is
 * never honoured (`expired`): the guard is about to restore the last confirmed
 * rules, and promoting a ruleset the guard is also undoing would race it.
 *
 * Also the `turbopaneld firewall confirm` verb, for an operator who has proven
 * from outside that the host is reachable.
 */

import { ensureDaemonDir } from "../permissions/daemon-files.ts";
import { join } from "@std/path";
import { type LayoutPaths, resolveLayout } from "../paths/layout.ts";
import { logInfo } from "../util/logger.ts";
import { FIREWALL_V4_FILENAME, FIREWALL_V6_FILENAME } from "./apply.ts";
import {
  clearPendingFirewall,
  disarmGuardTimer,
  FIREWALL_GUARD_SERVICE,
  type FirewallPendingOptions,
  readPendingDocument,
  readPendingMarker,
  readRollbackRecord,
  removeIfPresent,
  rollbackRecordPath,
  writeFileAtomic,
} from "./pending.ts";
import { foldManagedPublicChainBestEffort } from "./fold.ts";
import { runFirewallHost } from "./run.ts";

export type FirewallConfirmState =
  | "confirmed"
  | "nothing_pending"
  | "digest_mismatch"
  | "expired"
  | "rolled_back";

export type FirewallConfirmOutcome = {
  state: FirewallConfirmState;
  /** The digest the caller named. */
  digest: string;
  /** On `digest_mismatch`, the digest actually pending. */
  pendingDigest?: string;
  summary: string;
};

export type FirewallConfirmOptions = Partial<FirewallPendingOptions>;

async function promoteDurable(
  layout: LayoutPaths,
  v6: "replace" | "forget" | "keep",
  v4Document: string,
): Promise<void> {
  await ensureDaemonDir(layout.configDir, 0o755);
  await writeFileAtomic(
    join(layout.configDir, FIREWALL_V4_FILENAME),
    v4Document,
    0o644,
  );
  const v6Path = join(layout.configDir, FIREWALL_V6_FILENAME);
  if (v6 === "keep") return;
  if (v6 === "forget") {
    await removeIfPresent(v6Path);
    return;
  }
  const v6Document = await readPendingDocument(layout, 6);
  if (v6Document === null) {
    throw new Error("pending IPv6 document is missing; not promoting");
  }
  await writeFileAtomic(v6Path, v6Document, 0o644);
}

async function noPendingOutcome(
  layout: LayoutPaths,
  digest: string,
): Promise<FirewallConfirmOutcome> {
  const rollback = await readRollbackRecord(layout);
  if (rollback !== null && rollback.digest === digest) {
    return {
      state: "rolled_back",
      digest,
      summary:
        `the ruleset was not confirmed in time and the host restored its last confirmed rules at ${rollback.at}`,
    };
  }
  return {
    state: "nothing_pending",
    digest,
    summary: "no unconfirmed ruleset is pending on this host",
  };
}

/**
 * Promote the pending ruleset named by `digest`, when it is still inside its
 * window. Throws when the pending documents are missing or unreadable: the
 * guard then rolls the ruleset back at the deadline, which is the safe outcome.
 */
export async function confirmPendingFirewall(
  digest: string,
  options: FirewallConfirmOptions = {},
): Promise<FirewallConfirmOutcome> {
  const run = options.run ?? runFirewallHost;
  const layout = options.layout ?? resolveLayout(Deno.env.toObject());
  const now = (options.now ?? (() => new Date()))();

  const marker = await readPendingMarker(layout);
  if (marker === null) return await noPendingOutcome(layout, digest);
  if (marker.digest !== digest) {
    return {
      state: "digest_mismatch",
      digest,
      pendingDigest: marker.digest,
      summary:
        "a different ruleset is pending on this host; it was not confirmed",
    };
  }
  if (now.getTime() >= Date.parse(marker.deadlineAt)) {
    // The guard rolls back on its own; ask it to do so now rather than at its
    // next tick. Best effort: it fires from its timer regardless.
    await run("systemctl", ["start", "--no-block", FIREWALL_GUARD_SERVICE], {
      timeoutMs: 15_000,
    });
    return {
      state: "expired",
      digest,
      summary:
        `the confirm window ended at ${marker.deadlineAt}; the host is restoring its last confirmed rules`,
    };
  }

  const v4Document = await readPendingDocument(layout, 4);
  if (v4Document === null) {
    throw new Error("pending IPv4 document is missing; not promoting");
  }
  // Durable first, marker last: a crash in between leaves a marker whose
  // rollback target is already the promoted ruleset, which is harmless.
  await promoteDurable(layout, marker.v6, v4Document);
  await clearPendingFirewall(layout);
  await disarmGuardTimer(run);
  // An earlier rollback is history once a ruleset is confirmed.
  await removeIfPresent(rollbackRecordPath(layout));
  // Stage 6: the ruleset is confirmed, so the legacy managed public chain can
  // go if (and only if) it now covers every listener that chain restricted.
  await foldManagedPublicChainBestEffort({ run, layout });
  logInfo(
    "firewall",
    `firewall ruleset ${digest.slice(0, 12)} confirmed and made durable`,
  );
  return {
    state: "confirmed",
    digest,
    summary: "the pending ruleset is now durable and survives a reboot",
  };
}
