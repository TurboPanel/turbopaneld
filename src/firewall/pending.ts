/**
 * Commit-confirm for the host firewall: rules are loaded but are not durable
 * until somebody who can reach the host from outside says so.
 *
 * **Why not "roll back if the daemon loses the control plane".** Outbound is an
 * invariant `ACCEPT` and `ESTABLISHED,RELATED` is always accepted, so no
 * ruleset can break a remote daemon's own connection: that test could never
 * fail. What a bad ruleset cuts is a human's SSH, the co-located panel's own
 * port, public tenant ports — and, if it were persisted, the same again after
 * a reboot. So the net is a **root-owned systemd timer**
 * (`turbopanel-firewall-guard.timer`, script `tp-firewall-guard`) that is
 * independent of this daemon: it restores the last *confirmed* rules when the
 * window runs out unless the pending marker is gone.
 *
 * **State, all of it small and boring:**
 *  - `<runDir>/firewall-pending.json` — the marker ({@link PendingFirewallMarker}).
 *    Present means "loaded, not yet confirmed". `runDir` is tmpfs, so a reboot
 *    forgets it, and the boot unit only ever loads the *confirmed* documents.
 *  - `<configDir>/firewall.pending.v4|.v6` — the rendered documents waiting to
 *    be promoted. Never read by the boot unit.
 *  - `<configDir>/firewall.v4|.v6` — the confirmed (durable) documents, written
 *    only by {@link confirmPendingFirewall}. The guard restores these.
 *  - `<stateDir>/firewall-rollback.json` — written by the guard when it rolled
 *    a ruleset back, so a late confirm can say so ({@link FirewallRollbackRecord}).
 *
 * **Fail safe in the one direction that matters.** The guard is armed *before*
 * any rule is loaded; if it cannot be armed nothing is loaded
 * ({@link FirewallGuardUnavailableError}). Every failure path after that moves
 * the host toward fewer restrictions, never more.
 */

import { join } from "@std/path";
import type { LayoutPaths } from "../paths/layout.ts";
import { logWarn, sanitizeForLog } from "../util/logger.ts";
import { type FirewallRunFn, runFirewallHost } from "./run.ts";

/** How long a loaded ruleset waits for a confirm before the guard undoes it. */
export const FIREWALL_CONFIRM_WINDOW_SECONDS = 120;

export const FIREWALL_GUARD_TIMER = "turbopanel-firewall-guard.timer";
export const FIREWALL_GUARD_SERVICE = "turbopanel-firewall-guard.service";

export const FIREWALL_PENDING_V4_FILENAME = "firewall.pending.v4";
export const FIREWALL_PENDING_V6_FILENAME = "firewall.pending.v6";
export const FIREWALL_PENDING_MARKER_FILENAME = "firewall-pending.json";
export const FIREWALL_ROLLBACK_RECORD_FILENAME = "firewall-rollback.json";

/** What a confirm does to the durable IPv6 document. */
export type PendingV6Intent = "replace" | "forget" | "keep";

export type PendingFirewallMarker = {
  version: 1;
  /** sha256 hex of the rendered documents; what `server.firewall.confirm` names. */
  digest: string;
  generation: number;
  armedAt: string;
  deadlineAt: string;
  windowSeconds: number;
  v6: PendingV6Intent;
};

/** Written by `tp-firewall-guard` when the window ran out. */
export type FirewallRollbackRecord = {
  digest: string;
  at: string;
  /** `durable`: the last confirmed rules are back. `none`: there were none, so the chains are gone. `open`: a restore failed and the chains were removed. */
  restored: "durable" | "none" | "open";
};

export type FirewallPendingOptions = {
  run?: FirewallRunFn;
  layout: LayoutPaths;
  now?: () => Date;
};

/** The guard timer could not be armed, so no rule was loaded. */
export class FirewallGuardUnavailableError extends Error {
  constructor(detail: string) {
    super(
      `firewall rollback guard could not be armed, so no rules were loaded: ${detail}`,
    );
    this.name = "FirewallGuardUnavailableError";
  }
}

export function pendingMarkerPath(layout: LayoutPaths): string {
  return join(layout.runDir, FIREWALL_PENDING_MARKER_FILENAME);
}

export function pendingDocumentPath(
  layout: LayoutPaths,
  family: 4 | 6,
): string {
  return join(
    layout.configDir,
    family === 4 ? FIREWALL_PENDING_V4_FILENAME : FIREWALL_PENDING_V6_FILENAME,
  );
}

export function rollbackRecordPath(layout: LayoutPaths): string {
  return join(layout.stateDir, FIREWALL_ROLLBACK_RECORD_FILENAME);
}

/** Write `text` to `path` by rename, so a reader never sees half a file. */
export async function writeFileAtomic(
  path: string,
  text: string,
  mode: number,
): Promise<void> {
  const tmp = `${path}.tmp-${crypto.randomUUID().slice(0, 8)}`;
  try {
    await Deno.writeTextFile(tmp, text, { mode });
    await Deno.rename(tmp, path);
  } catch (err) {
    await removeIfPresent(tmp);
    throw err;
  }
}

export async function removeIfPresent(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}

async function readTextIfPresent(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

function isMarker(value: unknown): value is PendingFirewallMarker {
  if (typeof value !== "object" || value === null) return false;
  const marker = value as Record<string, unknown>;
  return marker.version === 1 &&
    typeof marker.digest === "string" &&
    typeof marker.generation === "number" &&
    typeof marker.armedAt === "string" &&
    typeof marker.deadlineAt === "string" &&
    !Number.isNaN(Date.parse(marker.deadlineAt)) &&
    typeof marker.windowSeconds === "number" &&
    (marker.v6 === "replace" || marker.v6 === "forget" || marker.v6 === "keep");
}

/** The pending marker, or null when nothing is pending (or it is unreadable). */
export async function readPendingMarker(
  layout: LayoutPaths,
): Promise<PendingFirewallMarker | null> {
  const text = await readTextIfPresent(pendingMarkerPath(layout));
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isMarker(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function readRollbackRecord(
  layout: LayoutPaths,
): Promise<FirewallRollbackRecord | null> {
  try {
    const text = await readTextIfPresent(rollbackRecordPath(layout));
    if (text === null) return null;
    const parsed = JSON.parse(text) as Partial<FirewallRollbackRecord>;
    if (
      typeof parsed.digest !== "string" || typeof parsed.at !== "string" ||
      (parsed.restored !== "durable" && parsed.restored !== "none" &&
        parsed.restored !== "open")
    ) {
      return null;
    }
    return { digest: parsed.digest, at: parsed.at, restored: parsed.restored };
  } catch {
    return null;
  }
}

async function armGuardTimer(run: FirewallRunFn): Promise<void> {
  // `restart`, not `start`: a second apply inside the window must move the
  // deadline, and `start` on an active timer does nothing.
  const result = await run("systemctl", ["restart", FIREWALL_GUARD_TIMER], {
    timeoutMs: 15_000,
  });
  if (!result.success) {
    throw new FirewallGuardUnavailableError(
      sanitizeForLog(result.stderr || result.stdout || `exit ${result.code}`),
    );
  }
}

/** Best effort: a timer that is already stopped is the desired state. */
export async function disarmGuardTimer(run: FirewallRunFn): Promise<void> {
  const result = await run("systemctl", ["stop", FIREWALL_GUARD_TIMER], {
    timeoutMs: 15_000,
  });
  if (!result.success) {
    logWarn(
      "firewall",
      `could not stop ${FIREWALL_GUARD_TIMER}: ${
        sanitizeForLog(result.stderr || result.stdout || `exit ${result.code}`)
      }`,
    );
  }
}

export type PendingFirewallInput = {
  digest: string;
  generation: number;
  v4: string;
};

export type ArmedPendingFirewall = {
  deadlineAt: string;
  windowSeconds: number;
};

/**
 * Stage a ruleset: write its v4 document and the marker, then arm the guard.
 * Call this **before** loading any rule. Throws
 * {@link FirewallGuardUnavailableError} (after clearing what it wrote) when the
 * guard cannot be armed, and the caller then loads nothing.
 */
export async function armPendingFirewall(
  input: PendingFirewallInput,
  options: FirewallPendingOptions,
): Promise<ArmedPendingFirewall> {
  const run = options.run ?? runFirewallHost;
  const now = (options.now ?? (() => new Date()))();
  const windowSeconds = FIREWALL_CONFIRM_WINDOW_SECONDS;
  const marker: PendingFirewallMarker = {
    version: 1,
    digest: input.digest,
    generation: input.generation,
    armedAt: now.toISOString(),
    deadlineAt: new Date(now.getTime() + windowSeconds * 1000).toISOString(),
    windowSeconds,
    // Until the IPv6 outcome is known, a confirm leaves the durable v6 alone.
    v6: "keep",
  };
  await Deno.mkdir(options.layout.configDir, { recursive: true });
  await Deno.mkdir(options.layout.runDir, { recursive: true });
  // A new apply supersedes any earlier rollback story and any old v6 document.
  await removeIfPresent(rollbackRecordPath(options.layout));
  await removeIfPresent(pendingDocumentPath(options.layout, 6));
  await writeFileAtomic(
    pendingDocumentPath(options.layout, 4),
    input.v4,
    0o644,
  );
  await writeFileAtomic(
    pendingMarkerPath(options.layout),
    JSON.stringify(marker),
    0o644,
  );
  try {
    await armGuardTimer(run);
  } catch (err) {
    await clearPendingFirewall(options.layout);
    throw err;
  }
  return { deadlineAt: marker.deadlineAt, windowSeconds };
}

/**
 * Record what a confirm should do to the durable IPv6 document, once the v6
 * apply has an outcome. `replace` writes the pending v6 document; the other two
 * need no file.
 */
export async function recordPendingV6(
  layout: LayoutPaths,
  intent: PendingV6Intent,
  v6Document: string | null,
): Promise<void> {
  const marker = await readPendingMarker(layout);
  if (marker === null) return;
  if (intent === "replace" && v6Document !== null) {
    await writeFileAtomic(pendingDocumentPath(layout, 6), v6Document, 0o644);
  } else {
    await removeIfPresent(pendingDocumentPath(layout, 6));
  }
  await writeFileAtomic(
    pendingMarkerPath(layout),
    JSON.stringify({ ...marker, v6: intent }),
    0o644,
  );
}

/** Forget a staged ruleset: marker and pending documents. Never throws on absence. */
export async function clearPendingFirewall(layout: LayoutPaths): Promise<void> {
  await removeIfPresent(pendingMarkerPath(layout));
  await removeIfPresent(pendingDocumentPath(layout, 4));
  await removeIfPresent(pendingDocumentPath(layout, 6));
}

export async function readPendingDocument(
  layout: LayoutPaths,
  family: 4 | 6,
): Promise<string | null> {
  return await readTextIfPresent(pendingDocumentPath(layout, family));
}
