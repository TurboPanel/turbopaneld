import { DaemonSourceRootError, resolveDaemonRoot } from "./paths/layout.ts";

/** Accumulator for an in-flight dev-sync transfer (base64 chunks by index). */
export interface DevSyncState {
  chunks: string[];
  totalChunks: number;
}

export function newDevSyncState(totalChunks: number): DevSyncState {
  return { chunks: new Array<string>(totalChunks).fill(""), totalChunks };
}

export const COLOCATED_DEV_SYNC_REFUSED_REASON =
  "dev-sync refused on co-located development daemon — edit the local checkout directly";

/**
 * Refusal reason for managed / compiled / JS-fallback installs. Source-sync
 * replaces an editable checkout in place; a managed install has no such tree.
 *
 * The stable "managed install" phrase is matched by the instance
 * (`turbopanel/src/developer/dev-sync.ts`, `MANAGED_DAEMON_DEV_SYNC_MARKER`) to
 * classify a target daemon as skipped rather than failed — keep them in sync.
 */
export const MANAGED_DEV_SYNC_REFUSED_REASON =
  "dev-sync refused on this managed install — no editable daemon source checkout to replace (source-sync targets co-located development checkouts only)";

function isColocatedDevDaemonHost(): boolean {
  const flag = Deno.env.get("TURBOPANEL_DEV_INSTANCE")?.trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

/** Discriminated result of resolving the dev-sync source checkout root. */
export type DevSyncSourceRoot =
  | { ok: true; root: string }
  | { ok: false; reason: string };

/**
 * Resolve the editable daemon source checkout that dev-sync replaces in place.
 *
 * Refuses (a) the co-located development daemon (edit the checkout directly) and
 * (b) managed / compiled / JS-fallback installs, which have no source tree —
 * {@link resolveDaemonRoot} with `requireCheckout` throws
 * {@link DaemonSourceRootError} for those roots instead of falling back to the
 * bundled entrypoint location.
 */
export function resolveDevSyncSourceRoot(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): DevSyncSourceRoot {
  if (isColocatedDevDaemonHost()) {
    return { ok: false, reason: COLOCATED_DEV_SYNC_REFUSED_REASON };
  }
  try {
    return {
      ok: true,
      root: resolveDaemonRoot(env, { requireCheckout: true }),
    };
  } catch (err) {
    if (err instanceof DaemonSourceRootError) {
      return { ok: false, reason: MANAGED_DEV_SYNC_REFUSED_REASON };
    }
    throw err;
  }
}
