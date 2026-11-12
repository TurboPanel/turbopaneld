/**
 * Logins whose open connections still have to be ended after a revoke:
 * `<stateDir>/managed/<managedId>/pending-session-end.json`, a JSON array of
 * login names (0600, written atomically). The file goes with the managed
 * folder when the cluster is destroyed. Engine side: `ManagedEngineContext.sessionEnds`.
 */

import { join } from "node:path";
import type { LayoutPaths } from "../paths/layout.ts";
import { managedDir, SAFE_MANAGED_ID_RE } from "./engine-paths.ts";
import { writeFileAtomic } from "./ha-intent.ts";
import type { ManagedEngineContext } from "./engines/types.ts";

const MARKER_FILE = "pending-session-end.json";

export function sessionEndMarkerPath(
  layout: LayoutPaths,
  managedId: string,
): string {
  if (!SAFE_MANAGED_ID_RE.test(managedId)) {
    throw new Error("managedId contains unsupported characters");
  }
  return join(managedDir(layout, managedId), MARKER_FILE);
}

async function readNames(path: string): Promise<string[]> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A file that does not parse owes nothing: failing every apply of the
    // cluster over it would be worse than one missed kill.
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((value): value is string => typeof value === "string");
}

async function writeNames(path: string, names: readonly string[]) {
  if (names.length === 0) {
    try {
      await Deno.remove(path);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
    return;
  }
  await Deno.mkdir(join(path, ".."), { recursive: true });
  await writeFileAtomic(path, `${JSON.stringify(names)}\n`);
}

/** The context hook backed by the marker file of one cluster. */
export function sessionEndsFor(
  layout: LayoutPaths,
  managedId: string,
): NonNullable<ManagedEngineContext["sessionEnds"]> {
  const path = sessionEndMarkerPath(layout, managedId);
  return {
    pending: () => readNames(path),
    add: async (username) => {
      const names = await readNames(path);
      if (!names.includes(username)) {
        await writeNames(path, [...names, username]);
      }
    },
    done: async (username) => {
      const names = await readNames(path);
      if (names.includes(username)) {
        await writeNames(path, names.filter((name) => name !== username));
      }
    },
  };
}
