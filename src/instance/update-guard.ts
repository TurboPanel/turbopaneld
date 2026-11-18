import { join } from "@std/path";
import {
  ensureDaemonDir,
  removeDaemonFile,
  writeDaemonFile,
} from "../permissions/daemon-files.ts";
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

/**
 * The build an automatic rollback just left. The control plane keeps asking
 * for it, so the daemon refuses it (and says why) until another build is asked
 * for. Lives beside update-rollback.json, which is cleared once reported.
 */
export type UpdateSkipRecord = {
  commit: string;
  reason: string;
  at: string;
};

export function updateSkipPath(layout?: LayoutPaths): string {
  return join(currentLayout(layout).stateDir, "update-skip-target.json");
}

export async function readUpdateSkip(
  layout?: LayoutPaths,
): Promise<UpdateSkipRecord | null> {
  try {
    const raw = JSON.parse(
      await Deno.readTextFile(updateSkipPath(layout)),
    ) as UpdateSkipRecord;
    if (!raw.commit?.trim()) return null;
    return raw;
  } catch {
    return null;
  }
}

export async function writeUpdateSkip(
  record: UpdateSkipRecord,
  layout?: LayoutPaths,
): Promise<void> {
  const resolved = currentLayout(layout);
  await ensureDaemonDir(resolved.stateDir);
  await writeDaemonFile(
    updateSkipPath(resolved),
    JSON.stringify(record),
    0o640,
  );
}

export async function clearUpdateSkip(layout?: LayoutPaths): Promise<void> {
  try {
    await removeDaemonFile(updateSkipPath(layout));
  } catch {
    // Absent is fine.
  }
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
  await ensureDaemonDir(resolved.stateDir);
  await writeDaemonFile(path, body, 0o640);
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
    await removeDaemonFile(updateRollbackPath(resolved));
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
    if (rollback.fromCommit?.trim()) {
      await writeUpdateSkip({
        commit: rollback.fromCommit.trim(),
        reason: rollback.reason,
        at: rollback.at,
      }, layout);
    }
    await clearUpdateRollback(layout);
    return;
  }

  const armed = await readUpdateGuardArmed(layout);
  if (armed?.targetCommit.trim() === commit) {
    await writeUpdateGuardDisarm(commit, layout);
    options.reportStage("verifying");
    options.reportStage("done");
  }
}
