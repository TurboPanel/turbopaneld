/**
 * Hosting storage path resolution — admin override plus layout default.
 *
 * Operators point the hosting storage probe at a specific filesystem via
 * `<daemonStateDir>/metrics/hosting-path.json` (`{ "path": "/mnt/hosting" }`).
 * The control plane persists the selection on `server.metadata` and pushes it
 * here over the cell socket (`metrics-sensor-overrides-update`);
 * {@link writeHostingPathOverride} replaces the file atomically.
 * Absent/invalid state falls back to the layout's `principalHomeRoot`.
 */
import { dirname, join } from "@std/path";

import { resolveLayout } from "../../paths/layout.ts";

export const HOSTING_PATH_OVERRIDE_RELATIVE_PATH = "metrics/hosting-path.json";

/** Override file path under the daemon state dir. */
export function hostingPathOverridePath(daemonStateDir: string): string {
  return join(daemonStateDir, HOSTING_PATH_OVERRIDE_RELATIVE_PATH);
}

/**
 * Parse override-file JSON (`{ "path": "/abs/path" }`). Only one absolute
 * path with no whitespace/control characters is accepted; anything else
 * yields `undefined` so the layout default stays in charge — never fatal.
 */
export function parseHostingPathOverride(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const path = (parsed as Record<string, unknown>).path;
    if (typeof path !== "string") return undefined;
    const trimmed = path.trim();
    if (!trimmed.startsWith("/")) return undefined;
    if (/[\s\p{Cc}]/u.test(trimmed)) return undefined;
    return trimmed;
  } catch {
    return undefined;
  }
}

/** Read the operator-selected hosting path from daemon state; `undefined` when unset. */
export async function resolveAdminHostingPathOverride(
  daemonStateDir?: string,
): Promise<string | undefined> {
  try {
    const stateDir = daemonStateDir ??
      resolveLayout(Deno.env.toObject()).daemonStateDir;
    const text = await Deno.readTextFile(hostingPathOverridePath(stateDir));
    return parseHostingPathOverride(text);
  } catch {
    return undefined;
  }
}

/**
 * Persist the operator-selected hosting path to daemon state. Atomic write
 * (temp file + rename) so a concurrent probe never reads a torn file.
 */
export async function writeHostingPathOverride(
  path: string,
  daemonStateDir?: string,
): Promise<void> {
  const stateDir = daemonStateDir ??
    resolveLayout(Deno.env.toObject()).daemonStateDir;
  const filePath = hostingPathOverridePath(stateDir);
  await Deno.mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await Deno.writeTextFile(tmpPath, JSON.stringify({ path }));
  await Deno.rename(tmpPath, filePath);
}

/**
 * Remove the hosting path override so the layout default takes over. Only a
 * missing file is ignored (that already means "no override"); any other
 * removal failure is rethrown so the caller can report that the stale
 * override file is still on disk and the clear did not apply.
 */
export async function clearHostingPathOverride(
  daemonStateDir?: string,
): Promise<void> {
  const stateDir = daemonStateDir ??
    resolveLayout(Deno.env.toObject()).daemonStateDir;
  try {
    await Deno.remove(hostingPathOverridePath(stateDir));
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}

/**
 * Canonical hosting storage path: the admin override when set, else the
 * layout's tenant principal home root.
 */
export async function resolveHostingPath(
  env: Record<string, string | undefined> = Deno.env.toObject(),
  daemonStateDir?: string,
): Promise<string> {
  const override = await resolveAdminHostingPathOverride(daemonStateDir);
  if (override) return override;
  return resolveLayout(env).principalHomeRoot;
}
