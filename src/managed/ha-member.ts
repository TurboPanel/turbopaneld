/**
 * Per-host record of the managed member this daemon runs for each cluster.
 *
 * Written after a successful `managed.apply` (from the payload's own member
 * identity, role and peers), flipped to `primary` after a successful
 * `managed.promote`, and removed with the state dir on `managed.destroy`.
 * The dead-primary probe reads it to know which local containers are
 * primaries worth watching. A cluster applied by an older daemon has no
 * record until its next apply, so the probe stays off for it — the safe
 * default.
 *
 * Lives at `<stateDir>/managed/<managedId>/ha-member.json` (mode 0600).
 */

import { join } from "@std/path";
import type {
  ManagedApplyPayload,
  ManagedEngineCode,
} from "../contracts/commands-contracts.ts";
import { logWarn, sanitizeForLog } from "../util/logger.ts";
import { managedDir, SAFE_MANAGED_ID_RE } from "./engine-paths.ts";
import { writeFileAtomic } from "./ha-intent.ts";
import type { LayoutPaths } from "../paths/layout.ts";

export type ManagedHaMemberRecord = {
  managedId: string;
  memberId: string;
  engine: ManagedEngineCode;
  role: "primary" | "replica";
  containerName: string;
  /** Peers that are replicas (never this member). */
  replicaPeerCount: number;
  updatedAt: string;
};

const RECORD_FILE = "ha-member.json";

export function managedHaMemberPath(
  layout: LayoutPaths,
  managedId: string,
): string {
  return join(managedDir(layout, managedId), RECORD_FILE);
}

export function haMemberRecordFromApply(
  payload: ManagedApplyPayload,
  now: string,
): ManagedHaMemberRecord {
  return {
    managedId: payload.managedId,
    memberId: payload.memberId,
    engine: payload.engine,
    role: payload.memberRole,
    containerName: payload.containerName,
    replicaPeerCount:
      payload.peers.filter((peer) =>
        peer.role === "replica" && peer.memberId !== payload.memberId
      ).length,
    updatedAt: now,
  };
}

async function writeRecord(
  layout: LayoutPaths,
  record: ManagedHaMemberRecord,
): Promise<void> {
  await writeFileAtomic(
    managedHaMemberPath(layout, record.managedId),
    `${JSON.stringify(record)}\n`,
  );
}

/** Best effort: the probe treats a missing record as "do not watch". */
export async function saveManagedHaMember(
  layout: LayoutPaths,
  record: ManagedHaMemberRecord,
): Promise<void> {
  try {
    await writeRecord(layout, record);
  } catch (err) {
    logWarn(
      "managed",
      `ha-member record write failed managedId=${record.managedId}:`,
      sanitizeForLog(err),
    );
  }
}

function parseRecord(text: string): ManagedHaMemberRecord | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (
      typeof value.managedId !== "string" ||
      !SAFE_MANAGED_ID_RE.test(value.managedId) ||
      typeof value.memberId !== "string" ||
      typeof value.engine !== "string" ||
      (value.role !== "primary" && value.role !== "replica") ||
      typeof value.containerName !== "string" ||
      typeof value.replicaPeerCount !== "number" ||
      typeof value.updatedAt !== "string"
    ) {
      return null;
    }
    return value as ManagedHaMemberRecord;
  } catch {
    return null;
  }
}

export async function readManagedHaMember(
  layout: LayoutPaths,
  managedId: string,
): Promise<ManagedHaMemberRecord | null> {
  try {
    const record = parseRecord(
      await Deno.readTextFile(managedHaMemberPath(layout, managedId)),
    );
    return record?.managedId === managedId ? record : null;
  } catch {
    return null;
  }
}

/** After `managed.promote` succeeded: this member is now the primary. */
export async function markManagedHaMemberPromoted(
  layout: LayoutPaths,
  managedId: string,
  memberId: string,
  now: string,
): Promise<void> {
  const record = await readManagedHaMember(layout, managedId);
  if (record?.memberId !== memberId) return;
  await saveManagedHaMember(layout, {
    ...record,
    role: "primary",
    updatedAt: now,
  });
}

export async function removeManagedHaMember(
  layout: LayoutPaths,
  managedId: string,
): Promise<void> {
  try {
    await Deno.remove(managedHaMemberPath(layout, managedId));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    logWarn(
      "managed",
      `ha-member record remove failed managedId=${managedId}:`,
      sanitizeForLog(err),
    );
  }
}

/** Every record on this host (unreadable entries are skipped). */
export async function listManagedHaMembers(
  layout: LayoutPaths,
): Promise<ManagedHaMemberRecord[]> {
  const ids: string[] = [];
  try {
    for await (const entry of Deno.readDir(join(layout.stateDir, "managed"))) {
      if (entry.isDirectory && SAFE_MANAGED_ID_RE.test(entry.name)) {
        ids.push(entry.name);
      }
    }
  } catch {
    return [];
  }
  const records = await Promise.all(
    ids.map((id) => readManagedHaMember(layout, id)),
  );
  return records.filter((record): record is ManagedHaMemberRecord =>
    record !== null
  );
}
