/**
 * Router hooks that keep the dead-primary probe's inputs truthful:
 * intent markers around every engine-touching managed command
 * (`ha-intent.ts`) and the per-host member record (`ha-member.ts`).
 *
 * Called from `../commands/command-router.ts` only. Never throws — the
 * command's own outcome must not depend on probe bookkeeping.
 */

import type {
  ManagedApplyPayload,
  ManagedDestroyPayload,
  ManagedHaFailoverPayload,
  ManagedPromotePayload,
} from "../contracts/commands-contracts.ts";
import { logWarn, sanitizeForLog } from "../util/logger.ts";
import { type LayoutPaths, resolveLayout } from "../paths/layout.ts";
import {
  beginManagedIntent,
  endManagedIntent,
  managedCommandIntent,
  type ManagedIntentToken,
} from "./ha-intent.ts";
import {
  haMemberRecordFromApply,
  markManagedHaMemberPromoted,
  removeManagedHaMember,
  saveManagedHaMember,
} from "./ha-member.ts";

export type ManagedCommandIntentToken = ManagedIntentToken;

let layoutOverride: LayoutPaths | null = null;

/** Test seam: pin the layout the hooks write under. */
export function setManagedCommandHooksLayoutForTests(
  layout: LayoutPaths | null,
): void {
  layoutOverride = layout;
}

function hookLayout(): LayoutPaths {
  return layoutOverride ?? resolveLayout(Deno.env.toObject());
}

async function guarded(label: string, work: () => Promise<void>) {
  try {
    await work();
  } catch (err) {
    logWarn("managed", `${label} failed:`, sanitizeForLog(err));
  }
}

/** Record the marker BEFORE the handler runs. */
export async function beginManagedCommandIntent(
  commandType: string,
  payload: unknown,
): Promise<ManagedCommandIntentToken | null> {
  const intent = managedCommandIntent(commandType, payload);
  if (!intent) return null;
  let token: ManagedCommandIntentToken = { ...intent, ownId: null };
  await guarded("intent marker", async () => {
    token = await beginManagedIntent(
      hookLayout().stateDir,
      intent.managedId,
      intent.kind,
    );
  });
  return token;
}

/** After the handler returned (or threw): see `endManagedIntent`. */
export async function endManagedCommandIntent(
  token: ManagedCommandIntentToken | null,
  succeeded: boolean,
  options?: { keepHeld?: boolean },
): Promise<void> {
  if (!token) return;
  await guarded("intent marker refresh", async () => {
    await endManagedIntent(hookLayout().stateDir, token, succeeded, options);
  });
}

export async function noteManagedApplySucceeded(
  payload: ManagedApplyPayload,
): Promise<void> {
  await guarded("ha-member record", async () => {
    await saveManagedHaMember(
      hookLayout(),
      haMemberRecordFromApply(payload, new Date().toISOString()),
    );
  });
}

export async function noteManagedPromoteSucceeded(
  payload: ManagedPromotePayload,
): Promise<void> {
  await guarded("ha-member promote", async () => {
    await markManagedHaMemberPromoted(
      hookLayout(),
      payload.managedId,
      payload.memberId,
      new Date().toISOString(),
    );
  });
}

/**
 * After `managed.ha.failover` `recover` succeeded (Orchestrator recover-to or
 * its internal `managed.promote` fallback): the target member on this host
 * is now the primary and must be watched. `repoint` leaves the local member
 * a replica following the new primary.
 */
export async function noteManagedFailoverSucceeded(
  payload: ManagedHaFailoverPayload,
): Promise<void> {
  if (payload.phase !== "recover") return;
  await guarded("ha-member failover", async () => {
    await markManagedHaMemberPromoted(
      hookLayout(),
      payload.managedId,
      payload.targetMemberId,
      new Date().toISOString(),
    );
  });
}

export async function noteManagedDestroySucceeded(
  payload: ManagedDestroyPayload,
): Promise<boolean> {
  let recordGone = false;
  await guarded("ha-member remove", async () => {
    recordGone = await removeManagedHaMember(hookLayout(), payload.managedId);
  });
  return recordGone;
}
