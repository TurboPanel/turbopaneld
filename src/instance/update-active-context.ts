import { join } from "@std/path";
import { type LayoutPaths, resolveLayout } from "../paths/layout.ts";

export type ActiveUpgradeContext = {
  progressId: string;
  upgradeId?: string;
  /** Commit the in-flight self-update was armed for. */
  targetCommit?: string;
};

function currentLayout(layout?: LayoutPaths): LayoutPaths {
  return layout ?? resolveLayout(Deno.env.toObject());
}

const CONTEXT_FILE = "active-upgrade.json";

function contextPath(layout: LayoutPaths): string {
  return join(layout.stateDir, "update", CONTEXT_FILE);
}

export async function writeActiveUpgradeContext(
  context: ActiveUpgradeContext,
  layout?: LayoutPaths,
): Promise<void> {
  const resolved = currentLayout(layout);
  const path = contextPath(resolved);
  await Deno.mkdir(join(resolved.stateDir, "update"), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(context));
}

export async function readActiveUpgradeContext(
  layout?: LayoutPaths,
): Promise<ActiveUpgradeContext | null> {
  const resolved = currentLayout(layout);
  try {
    const raw = JSON.parse(
      await Deno.readTextFile(contextPath(resolved)),
    ) as ActiveUpgradeContext;
    if (!raw.progressId?.trim()) return null;
    return raw;
  } catch {
    return null;
  }
}

export async function clearActiveUpgradeContext(
  layout?: LayoutPaths,
): Promise<void> {
  const resolved = currentLayout(layout);
  try {
    await Deno.remove(contextPath(resolved));
  } catch {
    // Absent is fine.
  }
}
