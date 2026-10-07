/**
 * Holds that keep a deploy's software on the host while an unused-software
 * removal runs, and the one removal at a time this process allows.
 *
 * Install is lazy (a PHP series or a web engine lands on the first deploy that
 * needs it) and removal is its counterpart. A deploy installs minutes before
 * its site config exists (the release builds in between), so it holds every
 * key it needs for its whole length, and a removal skips anything held. Keys
 * say what kind of thing they name: `php:8.4`, `engine:nginx`.
 */

import { logInfo, logWarn } from "../../util/logger.ts";

/** Hold key of a PHP series (`php:8.4`). */
export function phpSeriesHoldKey(series: string): string {
  return `php:${series}`;
}

/** Hold key of a web engine (`engine:nginx`). */
export function engineHoldKey(engine: string): string {
  return `engine:${engine}`;
}

const held = new Map<string, number>();
let pruning: Promise<void> | null = null;
/** The keys the running removal is taking away. */
let pruningKeys: ReadonlySet<string> = new Set();

/** Wait until no running removal takes any of `keys` away. */
async function waitForRemovalOf(keys: readonly string[]): Promise<void> {
  const running = pruning;
  if (running === null || !keys.some((key) => pruningKeys.has(key))) return;
  await running;
  // Another removal may have started meanwhile: check again.
  await waitForRemovalOf(keys);
}

/**
 * Keep `keys` from being removed until the returned function is called. A
 * deploy takes this before it installs anything. Waits out a removal already
 * running, so a deploy that wants something a removal is taking away installs
 * it again afterwards rather than finding it half gone. A removal of other
 * keys is no reason to wait.
 */
export async function holdPruneKeys(
  keys: readonly string[],
): Promise<() => void> {
  await waitForRemovalOf(keys);
  for (const key of keys) held.set(key, (held.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const key of keys) {
      const left = (held.get(key) ?? 1) - 1;
      if (left > 0) held.set(key, left);
      else held.delete(key);
    }
  };
}

/** One kind of removable software, as {@link pruneUnheld} sees it. */
export type PruneUnheldDeps<T extends string> = Readonly<{
  /** What the log lines call it ("PHP series", "web engines"). */
  label: string;
  /** Hold key of one item. */
  keyOf: (item: T) => string;
  /**
   * The installed items nothing on the host uses, or `null` when something
   * that could use one could not be read: nothing is removed then.
   */
  findUnused: () => Promise<readonly T[] | null>;
  /** Removes the given items from the host (privileged). */
  remove: (items: T[]) => Promise<void>;
}>;

/**
 * Remove every unused item no deploy holds. Returns the items it removed.
 * Never throws for a failed removal: that is logged and the items stay for
 * the next try. A removal already running (of any kind) makes this a no-op.
 */
export async function pruneUnheld<T extends string>(
  deps: PruneUnheldDeps<T>,
): Promise<T[]> {
  if (pruning !== null) return [];
  const unused = await deps.findUnused();
  if (unused === null) return [];
  // From here to `pruning = …` nothing awaits: a deploy either holds a key
  // before this check (and is skipped) or waits for the removal to finish.
  const free = unused.filter((item) => !held.has(deps.keyOf(item)));
  if (free.length === 0 || pruning !== null) return [];
  pruningKeys = new Set(free.map(deps.keyOf));
  const work = (async (): Promise<boolean> => {
    try {
      await deps.remove(free);
      logInfo("deploy", `unused ${deps.label} removed: ${free.join(",")}`);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logWarn(
        "deploy",
        `unused ${deps.label} kept (${free.join(",")}): ${message}`,
      );
      return false;
    } finally {
      pruning = null;
      pruningKeys = new Set();
    }
  })();
  pruning = work.then(() => undefined);
  return await work ? free : [];
}

/** Test seam: forget holds and a running removal between cases. */
export function resetPruneHoldsForTests(): void {
  held.clear();
  pruning = null;
  pruningKeys = new Set();
}
