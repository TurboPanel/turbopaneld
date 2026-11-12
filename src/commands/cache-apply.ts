/**
 * `cache.apply` (feature `project-cache-v1`): bring this host's project caches
 * for one environment in line with the complete list the control plane sends,
 * between deploys (a cache was added, changed or deleted). The same function
 * as the deploy path (`../deploy/cache/apply.ts`), under the same environment
 * lock, so it never runs beside a deploy or a destroy of that environment.
 *
 * A cache whose Hosting Account is not on this host yet is answered `pending`
 * (it starts with the next deploy). Data is deleted only for a removal that
 * says `deleteData`. This command never prunes a cache that is merely not
 * listed: the control plane names what to remove.
 */

import {
  type CacheApplyCommandResult,
  type CacheApplyPayload,
  parseCacheApplyPayload,
} from "../contracts/commands-contracts.ts";
import { applyEnvironmentCaches, type CacheIo } from "../deploy/cache/apply.ts";
import { installCacheRuntime } from "../deploy/cache/install-runtime.ts";
import { runPrivileged } from "../deploy/release/release-layout.ts";
import type { RunFn } from "../deploy/ensure-principal.ts";
import { resolveLayout } from "../paths/layout.ts";
import { logInfo } from "../util/logger.ts";
import { environmentLockKey, withKeyedLock } from "../util/keyed-lock.ts";

export type CacheApplyHandlerDeps = {
  /** Test seam: the privileged runner. */
  run?: RunFn;
  /** Test seam: the folders (default: this host's layout). */
  layout?: CacheIo["layout"];
  /** Test seam: the machine-touching parts of the apply. */
  io?: Partial<Omit<CacheIo, "run" | "layout">>;
};

export async function handleCacheApply(
  payload: CacheApplyPayload,
  daemonReceivedAt: string,
  deps?: CacheApplyHandlerDeps,
): Promise<CacheApplyCommandResult> {
  const parsed = parseCacheApplyPayload(payload);
  return await withKeyedLock(
    environmentLockKey(parsed.environmentId),
    async () => {
      const outcome = await applyEnvironmentCaches(
        {
          run: deps?.run ?? runPrivileged,
          layout: deps?.layout ?? resolveLayout(Deno.env.toObject()),
          ensureRuntime: (patch) => installCacheRuntime(patch),
          ...deps?.io,
        },
        parsed.environmentId,
        parsed.caches,
        { removed: parsed.removed, pruneUnlisted: false },
      );
      logInfo(
        "commands",
        `cache.apply completed env=${parsed.environmentId} caches=${outcome.results.length} received=${daemonReceivedAt}`,
      );
      return { caches: outcome.results };
    },
  );
}
