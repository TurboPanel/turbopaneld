import { join } from "@std/path";
import type { LayoutPaths } from "../paths/layout.ts";
import { resolveLayout } from "../paths/layout.ts";

function currentLayout(layout?: LayoutPaths): LayoutPaths {
  return layout ?? resolveLayout(Deno.env.toObject());
}

export type UpdateGuardArmed = {
  targetCommit: string;
  deadlineAt: string;
  armedAt: string;
  previousCommit?: string;
};

export type UpdateRollbackRecord = {
  fromCommit: string;
  toCommit: string;
  reason: string;
  at: string;
};

export function updateGuardPath(layout: LayoutPaths = currentLayout()): string {
  return join(layout.runDir, "update-guard.json");
}

export function updateGuardDisarmPath(
  layout?: LayoutPaths,
): string {
  return join(currentLayout(layout).stateDir, "update-guard-disarm.json");
}

export function updateRollbackPath(
  layout?: LayoutPaths,
): string {
  return join(currentLayout(layout).stateDir, "update-rollback.json");
}

export async function readUpdateGuardArmed(
  layout?: LayoutPaths,
): Promise<UpdateGuardArmed | null> {
  const resolved = currentLayout(layout);
  try {
    const raw = JSON.parse(
      await Deno.readTextFile(updateGuardPath(resolved)),
    ) as UpdateGuardArmed;
    if (!raw.targetCommit?.trim() || !raw.deadlineAt?.trim()) {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

export async function writeUpdateGuardDisarm(
  targetCommit: string,
  layout?: LayoutPaths,
): Promise<void> {
  const resolved = currentLayout(layout);
  const path = updateGuardDisarmPath(resolved);
  const body = JSON.stringify({
    targetCommit: targetCommit.trim(),
    at: new Date().toISOString(),
  });
  await Deno.mkdir(resolved.stateDir, { recursive: true });
  await Deno.writeTextFile(path, body);
}

export async function readUpdateRollback(
  layout?: LayoutPaths,
): Promise<UpdateRollbackRecord | null> {
  const resolved = currentLayout(layout);
  try {
    const raw = JSON.parse(
      await Deno.readTextFile(updateRollbackPath(resolved)),
    ) as UpdateRollbackRecord;
    if (!raw.toCommit?.trim()) return null;
    return raw;
  } catch {
    return null;
  }
}

export async function clearUpdateRollback(layout?: LayoutPaths): Promise<void> {
  const resolved = currentLayout(layout);
  try {
    await Deno.remove(updateRollbackPath(resolved));
  } catch {
    // Absent is fine.
  }
}

/**
 * After a self-update attach, disarm a stale guard for this build or report
 * rollback if the restored previous build came up.
 */
export async function handleSelfUpdateAttachOutcome(options: {
  currentCommit: string;
  layout?: LayoutPaths;
  reportStage: (
    stage: "verifying" | "done" | "rolled-back",
    detail?: { errorCode?: string; detail?: string },
  ) => void;
}): Promise<void> {
  const commit = options.currentCommit.trim();
  if (!commit) return;
  const layout = currentLayout(options.layout);

  const rollback = await readUpdateRollback(layout);
  if (rollback?.toCommit?.trim() === commit) {
    options.reportStage("rolled-back", {
      detail: rollback.reason,
      errorCode: "update_rollback",
    });
    await clearUpdateRollback(layout);
    return;
  }

  const armed = await readUpdateGuardArmed(layout);
  if (armed && armed.targetCommit.trim() === commit) {
    await writeUpdateGuardDisarm(commit, layout);
    options.reportStage("verifying");
    options.reportStage("done");
  }
}
