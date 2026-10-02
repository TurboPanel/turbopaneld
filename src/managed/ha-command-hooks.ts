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
  ManagedPromotePayload,
} from "../contracts/commands-contracts.ts";
import { logWarn, sanitizeForLog } from "../util/logger.ts";
import { type LayoutPaths, resolveLayout } from "../paths/layout.ts";
import {
  managedCommandIntent,
  type ManagedIntentKind,
  recordManagedIntent,
} from "./ha-intent.ts";
import {
  haMemberRecordFromApply,
  markManagedHaMemberPromoted,
  removeManagedHaMember,
  saveManagedHaMember,
} from "./ha-member.ts";

export type ManagedCommandIntentToken = {
  managedId: string;
  kind: ManagedIntentKind;
};

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
  await guarded("intent marker", async () => {
    await recordManagedIntent(
      hookLayout().stateDir,
      intent.managedId,
      intent.kind,
    );
  });
  return intent;
}

/** Refresh the marker when the handler returns, so its TTL starts now. */
export async function endManagedCommandIntent(
  token: ManagedCommandIntentToken | null,
): Promise<void> {
  if (!token) return;
  await guarded("intent marker refresh", async () => {
    await recordManagedIntent(
      hookLayout().stateDir,
      token.managedId,
      token.kind,
    );
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

export async function noteManagedDestroySucceeded(
  payload: ManagedDestroyPayload,
): Promise<void> {
  await guarded("ha-member remove", async () => {
    await removeManagedHaMember(hookLayout(), payload.managedId);
  });
}
