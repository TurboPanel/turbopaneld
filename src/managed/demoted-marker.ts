/**
 * Durable "this member was fenced as a replaced primary" marker.
 *
 * A `managed.lifecycle` stop with `demoted: true` writes
 * `<stateDir>/managed/<managedId>/demoted.json` after the command is accepted.
 * The demoted-member guard then stops the engine if anyone starts it by hand.
 * The marker is cleared when this member is applied as a replica, promoted,
 * or destroyed — a destroyed member must never keep one.
 */

import { join } from "@std/path";
import type { ManagedEngineCode } from "../contracts/commands-contracts.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { logWarn, sanitizeForLog } from "../util/logger.ts";
import { managedDir, SAFE_MANAGED_ID_RE } from "./engine-paths.ts";
import {
  listManagedHaMembers,
  type ManagedHaMemberRecord,
} from "./ha-member.ts";
import { writeFileAtomic } from "./ha-intent.ts";

const MARKER_FILE = "demoted.json";

export type ManagedDemotedMarker = {
  memberId: string;
  demotedAt: string;
};

export function managedDemotedMarkerPath(
  layout: LayoutPaths,
  managedId: string,
): string {
  if (!SAFE_MANAGED_ID_RE.test(managedId)) {
    throw new Error("managedId contains unsupported characters");
  }
  return join(managedDir(layout, managedId), MARKER_FILE);
}

/** Write the marker (throws: a fence that cannot record it must not succeed). */
export async function writeManagedDemotedMarker(
  layout: LayoutPaths,
  managedId: string,
  memberId: string,
  demotedAt: string,
): Promise<void> {
  await Deno.mkdir(managedDir(layout, managedId), { recursive: true });
  const marker: ManagedDemotedMarker = { memberId, demotedAt };
  await writeFileAtomic(
    managedDemotedMarkerPath(layout, managedId),
    `${JSON.stringify(marker)}\n`,
  );
}

/** Remove the marker. Missing is success; other errors are logged, never thrown. */
export async function clearManagedDemotedMarker(
  layout: LayoutPaths,
  managedId: string,
): Promise<void> {
  try {
    await Deno.remove(managedDemotedMarkerPath(layout, managedId));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    logWarn(
      "managed",
      `demoted marker remove failed managedId=${managedId}:`,
      sanitizeForLog(err),
    );
  }
}

function parseMarker(text: string): ManagedDemotedMarker | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (
      typeof value.memberId !== "string" || typeof value.demotedAt !== "string"
    ) {
      return null;
    }
    return { memberId: value.memberId, demotedAt: value.demotedAt };
  } catch {
    return null;
  }
}

/**
 * True when this cluster has a live demoted marker on this host. Fails closed:
 * a marker that cannot be read or parsed counts as demoted. When `memberId` is
 * given and the marker names a different member, it does not match.
 */
export async function isManagedMemberDemoted(
  layout: LayoutPaths,
  managedId: string,
  memberId?: string,
): Promise<boolean> {
  let text: string;
  try {
    text = await Deno.readTextFile(managedDemotedMarkerPath(layout, managedId));
  } catch (err) {
    return !(err instanceof Deno.errors.NotFound);
  }
  const marker = parseMarker(text);
  if (!marker) return true;
  if (
    memberId === undefined ||
    memberId.length === 0 ||
    marker.memberId.length === 0
  ) {
    return true;
  }
  return marker.memberId === memberId;
}

/** Drop the marker after a replica apply that actually brought the member up. */
/** Every local cluster that currently carries a demoted marker file. */
export async function listDemotedManagedIds(
  layout: LayoutPaths,
): Promise<string[]> {
  const root = join(layout.stateDir, "managed");
  const ids: string[] = [];
  try {
    for await (const entry of Deno.readDir(root)) {
      if (!entry.isDirectory || !SAFE_MANAGED_ID_RE.test(entry.name)) continue;
      if (await isManagedMemberDemoted(layout, entry.name)) {
        ids.push(entry.name);
      }
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return ids;
    throw err;
  }
  return ids;
}

/**
 * Members to fence: HA records plus any demoted marker without a member record
 * (e.g. before the next apply refreshes `ha-member.json`).
 */
async function listDemotedHaMembers(
  layout: LayoutPaths,
  members: ManagedHaMemberRecord[],
): Promise<ManagedHaMemberRecord[]> {
  const demotedFlags = await Promise.all(
    members.map(async (member) => ({
      member,
      demoted: await isManagedMemberDemoted(
        layout,
        member.managedId,
        member.memberId,
      ),
    })),
  );
  return demotedFlags
    .filter((row) => row.demoted)
    .map((row) => row.member);
}

export async function listDemotedFenceTargets(
  layout: LayoutPaths,
): Promise<
  Array<{ managedId: string; memberId?: string; engine?: ManagedEngineCode }>
> {
  const byId = new Map<
    string,
    { managedId: string; memberId?: string; engine?: ManagedEngineCode }
  >();
  for (
    const member of await listDemotedHaMembers(
      layout,
      await listManagedHaMembers(layout),
    )
  ) {
    byId.set(member.managedId, member);
  }
  for (const managedId of await listDemotedManagedIds(layout)) {
    if (!byId.has(managedId)) {
      byId.set(managedId, { managedId });
    }
  }
  return [...byId.values()];
}

export async function maybeClearDemotedMarkerAfterApply(
  layout: LayoutPaths,
  payload: { managedId: string; memberRole: "primary" | "replica" },
  memberStatus: string | undefined,
): Promise<void> {
  if (payload.memberRole !== "replica") return;
  if (memberStatus !== "ready") return;
  await clearManagedDemotedMarker(layout, payload.managedId);
}
