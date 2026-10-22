/**
 * A short bridge for the engine exit guard. When this host has just told the
 * control plane its managed primary is dead, the failover's first command (the
 * fence) has not reached this host yet, so no operator-intent marker exists
 * and the guard would start the old primary again and let it take writes
 * while it is fenced. This note covers only that gap.
 *
 * Once a failover command arrives, its intent marker (`ha-intent.ts`) holds the
 * guard for as long as the command runs. If nothing arrives (the control plane
 * refused, or it was a false alarm) the note expires after
 * {@link DEAD_PRIMARY_EVENT_HOLD_MS} and the guard restarts the engine as it
 * always did, so a crashed primary is back in about a minute at worst.
 *
 * Only the first event of an incident starts the hold: re-sends of the same
 * incident do not renew it. Memory only on purpose: after a daemon restart the
 * guard goes back to the behaviour before this note, which favours
 * availability.
 */

/** How long after the first event of an incident the guard keeps its hands off. */
export const DEAD_PRIMARY_EVENT_HOLD_MS = 25_000;
/** A note this old no longer counts as the same incident: a new event restarts the hold. */
export const DEAD_PRIMARY_INCIDENT_MS = 5 * 60_000;

const delivered = new Map<string, number>();

export function noteDeadPrimaryEventDelivered(
  managedId: string,
  nowMs: number = Date.now(),
): void {
  const at = delivered.get(managedId);
  if (at !== undefined && nowMs - at < DEAD_PRIMARY_INCIDENT_MS) return;
  delivered.set(managedId, nowMs);
}

export function isDeadPrimaryEventInFlight(
  managedId: string,
  nowMs: number = Date.now(),
  holdMs: number = DEAD_PRIMARY_EVENT_HOLD_MS,
): boolean {
  const at = delivered.get(managedId);
  return at !== undefined && nowMs - at < holdMs;
}

/** The incident is over (the engine runs again): the next event starts a fresh hold. */
export function clearDeadPrimaryEvent(managedId: string): void {
  delivered.delete(managedId);
}

/** Test seam: forget every note. */
export function resetDeadPrimaryEventsForTests(): void {
  delivered.clear();
}
