/**
 * Refuse old-primary reactivation when promotion on the target may have started
 * or finished (split-brain guard).
 */

import type { ManagedLifecyclePayload } from "../contracts/commands-contracts.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { parseSwitchoverPromoteFailureCode } from "./engines/switchover-promote-error.ts";
import {
  readSwitchoverPromoteLocalMarker,
  readSwitchoverQuiescedMarker,
} from "./switchover-state-marker.ts";

export function switchoverAbortReactivateBlockedReason(
  payload: ManagedLifecyclePayload,
): string | null {
  if (payload.switchoverTargetPromoteCompleted === true) {
    return "switchover: target promotion already completed";
  }
  const targetError = payload.switchoverTargetPromoteError;
  if (targetError !== undefined && targetError.length > 0) {
    const code = parseSwitchoverPromoteFailureCode(targetError);
    if (code === "promote_started") {
      return "switchover: target promotion already started";
    }
  }
  if (payload.switchoverAbortPromoteSafe !== true) {
    return "switchover: control plane did not confirm the target never promoted";
  }
  return null;
}

export async function assertSwitchoverAbortReactivateAllowed(
  layout: LayoutPaths,
  payload: ManagedLifecyclePayload,
): Promise<void> {
  const blocked = switchoverAbortReactivateBlockedReason(payload);
  if (blocked) {
    throw new Error(blocked);
  }
  const quiesced = await readSwitchoverQuiescedMarker(
    layout,
    payload.managedId,
  );
  if (!quiesced) {
    throw new Error(
      "switchover: no quiesced marker — reactivation is only allowed after a GTID capture fence",
    );
  }
  const localPromote = await readSwitchoverPromoteLocalMarker(
    layout,
    payload.managedId,
  );
  if (
    localPromote?.phase === "started" || localPromote?.phase === "completed"
  ) {
    throw new Error(
      `switchover: local promotion ${localPromote.phase} — refusing old-primary reactivation`,
    );
  }
}
