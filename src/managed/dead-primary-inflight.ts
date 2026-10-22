/**
 * Remembers that this host just told the control plane its managed primary is
 * dead. For a short while after that, a failover for the cluster is about to
 * start, and the engine exit guard must not bring the old primary back: it
 * would take writes again while the failover fences and promotes (the writes
 * are drained, but they race the fence).
 *
 * Memory only. The window is short on purpose: if no failover command has
 * arrived by then (refused, or the control plane did not answer), the guard
 * goes back to restarting the engine.
 */

/** How long after a delivered event the guard keeps its hands off the primary. */
export const DEAD_PRIMARY_EVENT_HOLD_MS = 90_000;

const delivered = new Map<string, number>();

export function noteDeadPrimaryEventDelivered(
  managedId: string,
  nowMs: number = Date.now(),
): void {
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

/** Test seam: forget every note. */
export function resetDeadPrimaryEventsForTests(): void {
  delivered.clear();
}
