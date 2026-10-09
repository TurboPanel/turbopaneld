/**
 * Durable planned-switchover state on a managed engine host.
 *
 * The quiesced marker is written on the old primary when the fence captures
 * GTID; it is cleared only after a successful abort reactivation. The promote
 * marker records promotion progress on the member that runs `managed.promote`.
 */

import { join } from "@std/path";
import type { LayoutPaths } from "../paths/layout.ts";
import { managedDir, SAFE_MANAGED_ID_RE } from "./engine-paths.ts";
import { writeFileAtomic } from "./ha-intent.ts";

const QUIESCED_FILE = "switchover-quiesced.json";
const PROMOTE_LOCAL_FILE = "switchover-promote-local.json";

export type SwitchoverQuiescedMarker = {
  primaryExecutedGtidSet: string;
  quiescedAt: string;
};

export type SwitchoverPromoteLocalPhase = "started" | "completed";

export type SwitchoverPromoteLocalMarker = {
  phase: SwitchoverPromoteLocalPhase;
  recordedAt: string;
};

function quiescedPath(layout: LayoutPaths, managedId: string): string {
  if (!SAFE_MANAGED_ID_RE.test(managedId)) {
    throw new Error("managedId contains unsupported characters");
  }
  return join(managedDir(layout, managedId), QUIESCED_FILE);
}

function promoteLocalPath(layout: LayoutPaths, managedId: string): string {
  if (!SAFE_MANAGED_ID_RE.test(managedId)) {
    throw new Error("managedId contains unsupported characters");
  }
  return join(managedDir(layout, managedId), PROMOTE_LOCAL_FILE);
}

export async function writeSwitchoverQuiescedMarker(
  layout: LayoutPaths,
  managedId: string,
  marker: SwitchoverQuiescedMarker,
): Promise<void> {
  await Deno.mkdir(managedDir(layout, managedId), { recursive: true });
  await writeFileAtomic(
    quiescedPath(layout, managedId),
    `${JSON.stringify(marker)}\n`,
  );
}

export async function readSwitchoverQuiescedMarker(
  layout: LayoutPaths,
  managedId: string,
): Promise<SwitchoverQuiescedMarker | null> {
  let text: string;
  try {
    text = await Deno.readTextFile(quiescedPath(layout, managedId));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (
      typeof value.primaryExecutedGtidSet !== "string" ||
      typeof value.quiescedAt !== "string"
    ) {
      return null;
    }
    return {
      primaryExecutedGtidSet: value.primaryExecutedGtidSet,
      quiescedAt: value.quiescedAt,
    };
  } catch {
    return null;
  }
}

export async function clearSwitchoverQuiescedMarker(
  layout: LayoutPaths,
  managedId: string,
): Promise<void> {
  try {
    await Deno.remove(quiescedPath(layout, managedId));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    throw err;
  }
}

export async function writeSwitchoverPromoteLocalMarker(
  layout: LayoutPaths,
  managedId: string,
  phase: SwitchoverPromoteLocalPhase,
  recordedAt: string,
): Promise<void> {
  await Deno.mkdir(managedDir(layout, managedId), { recursive: true });
  const marker: SwitchoverPromoteLocalMarker = { phase, recordedAt };
  await writeFileAtomic(
    promoteLocalPath(layout, managedId),
    `${JSON.stringify(marker)}\n`,
  );
}

export async function readSwitchoverPromoteLocalMarker(
  layout: LayoutPaths,
  managedId: string,
): Promise<SwitchoverPromoteLocalMarker | null> {
  let text: string;
  try {
    text = await Deno.readTextFile(promoteLocalPath(layout, managedId));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (value.phase !== "started" && value.phase !== "completed") return null;
    if (typeof value.recordedAt !== "string") return null;
    return { phase: value.phase, recordedAt: value.recordedAt };
  } catch {
    return null;
  }
}

export async function clearSwitchoverPromoteLocalMarker(
  layout: LayoutPaths,
  managedId: string,
): Promise<void> {
  try {
    await Deno.remove(promoteLocalPath(layout, managedId));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    throw err;
  }
}
