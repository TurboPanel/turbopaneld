/**
 * Durable "this member was destroyed" marker.
 *
 * `managed.destroy` writes it BEFORE tearing anything down; `managed.apply`
 * refuses to re-create a member that carries one. Without it, an apply that
 * was queued, retried or redelivered around the destroy would run right
 * after the teardown and rebuild the state directory, compose file and
 * engine container for a cluster the control plane has already deleted
 * (an orphan nobody tracks).
 *
 * The marker names the destroyed member, not just the cluster: a managed id
 * is shared by every member of a cluster, and a member that is removed and
 * later replaced by a NEW member (new member id) on the same host must still
 * be able to apply. A marker also stops counting after {@link DESTROYED_MARKER_TTL_MS}, well
 * past any command's life.
 *
 * Lives under `<stateDir>/managed-destroyed/<managedId>.json`, outside
 * `managed/<id>/` so removing the state directory does not take it with it.
 */

import { join } from "@std/path";
import { SAFE_MANAGED_ID_RE } from "./engine-paths.ts";
import { writeFileAtomic } from "./ha-intent.ts";

/** Marker lifetime (24 h): far longer than a queued command can live (10 min). */
export const DESTROYED_MARKER_TTL_MS = 24 * 60 * 60_000;

export type ManagedDestroyedMarker = {
  managedId: string;
  /** Destroyed member, or `null` when the destroy did not name one (whole cluster on this host). */
  memberId: string | null;
  destroyedAt: string;
};

/** An apply was refused because its member was destroyed. */
export class ManagedDestroyedError extends Error {
  constructor(managedId: string) {
    super(
      `managed engine ${managedId} was destroyed; refusing to re-create it`,
    );
    this.name = "ManagedDestroyedError";
  }
}

export function managedDestroyedMarkerPath(
  stateDir: string,
  managedId: string,
): string {
  if (!SAFE_MANAGED_ID_RE.test(managedId)) {
    throw new Error("managedId contains unsupported characters");
  }
  return join(stateDir, "managed-destroyed", `${managedId}.json`);
}

/** Write the marker (throws: a destroy that cannot record it must not proceed). */
export async function writeManagedDestroyedMarker(
  stateDir: string,
  managedId: string,
  memberId: string | undefined,
  destroyedAt: string,
): Promise<void> {
  const path = managedDestroyedMarkerPath(stateDir, managedId);
  await Deno.mkdir(join(stateDir, "managed-destroyed"), { recursive: true });
  const marker: ManagedDestroyedMarker = {
    managedId,
    memberId: memberId ?? null,
    destroyedAt,
  };
  await writeFileAtomic(path, `${JSON.stringify(marker)}\n`);
}

/**
 * True when `memberId` (of cluster `managedId`) was destroyed on this host
 * and the marker is still live. Fails closed: a marker that cannot be read
 * or parsed counts as destroyed.
 */
export async function isManagedMemberDestroyed(
  stateDir: string,
  managedId: string,
  memberId: string | undefined,
  nowMs: number = Date.now(),
): Promise<boolean> {
  let text: string;
  try {
    text = await Deno.readTextFile(
      managedDestroyedMarkerPath(stateDir, managedId),
    );
  } catch (err) {
    return !(err instanceof Deno.errors.NotFound);
  }
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const at = Date.parse(String(value.destroyedAt));
    if (Number.isNaN(at)) return true;
    if (nowMs - at >= DESTROYED_MARKER_TTL_MS) return false;
    const marked = value.memberId;
    if (marked === null || marked === undefined) return true;
    return memberId === undefined || marked === memberId;
  } catch {
    return true;
  }
}
