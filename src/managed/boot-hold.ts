/**
 * Boot hold: a primary that comes back from a power cut stays stopped until
 * the control plane says it is still the primary.
 *
 * While the host was off the control plane may have promoted a replica
 * (`turbopanel/src/features/managed/ha-host-loss-sweep.ts`). Docker restarts
 * engines with `restart: unless-stopped` before this daemon runs, so a stale
 * primary can be accepting writes again within seconds of boot. When
 * `host-boot.ts` says the host went down uncleanly, the daemon therefore:
 *
 * 1. writes a HELD `stop` intent marker (`ha-intent.ts`), so the dead-primary
 *    probe treats the stopped engine as intended, never as a crash;
 * 2. writes `<stateDir>/managed/<id>/boot-hold.json`;
 * 3. stops the cluster's compose project.
 *
 * Only primaries with at least one peer are held: a standalone database has
 * nobody to be superseded by. The hold lasts until the control plane answers
 * the `boot-hold` event (`instance/boot-hold-reporter.ts`): a `managed.
 * lifecycle start` releases it (the primary is still the primary), a role
 * change leaves it stopped (it needs a resync). A control plane that does not
 * advertise `managed-ha-boot-hold-v1` can never answer, so the reporter
 * releases the hold itself and starts the engine, as before this feature.
 *
 * If the control plane is unreachable the hold stays: that fails closed,
 * which is the point (an old primary that may hold diverged writes must not
 * serve again unchecked).
 */

import { join } from "@std/path";
import type { LayoutPaths } from "../paths/layout.ts";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { logInfo, logWarn, sanitizeForLog } from "../util/logger.ts";
import { forEachSequential } from "../util/sequential.ts";
import {
  managedComposeProject,
  managedDir,
  SAFE_MANAGED_ID_RE,
} from "./engine-paths.ts";
import {
  clearManagedIntent,
  isHeldIntent,
  lookupManagedIntent,
  recordManagedIntent,
  writeFileAtomic,
} from "./ha-intent.ts";
import {
  listManagedHaMembers,
  type ManagedHaMemberRecord,
} from "./ha-member.ts";
import type { HostBootKind } from "./host-boot.ts";

export const BOOT_HOLD_DETECTOR = "boot-hold";
const HOLD_FILE = "boot-hold.json";

export type BootHoldRecord = {
  managedId: string;
  memberId: string;
  engine: string;
  /** Wall time the hold was taken (informational only). */
  heldAt: string;
  /** False until `compose stop` has succeeded; the reporter retries it. */
  engineStopped: boolean;
};

export type DockerRunFn = (args: string[]) => Promise<DockerCliResult>;

export type BootHoldDeps = {
  layout: LayoutPaths;
  run: DockerRunFn;
  /** Test seam — defaults to {@link listManagedHaMembers}. */
  listMembers?: () => Promise<ManagedHaMemberRecord[]>;
  nowIso?: () => string;
};

export function bootHoldPath(layout: LayoutPaths, managedId: string): string {
  return join(managedDir(layout, managedId), HOLD_FILE);
}

/** A primary with at least one other member: someone may have replaced it. */
export function isHoldablePrimary(record: ManagedHaMemberRecord): boolean {
  return record.role === "primary" &&
    (record.peerCount ?? record.replicaPeerCount) > 0;
}

function parseHold(text: string, managedId: string): BootHoldRecord | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (
      value.managedId !== managedId || typeof value.memberId !== "string" ||
      typeof value.engine !== "string" || typeof value.heldAt !== "string" ||
      typeof value.engineStopped !== "boolean"
    ) {
      return null;
    }
    return value as BootHoldRecord;
  } catch {
    return null;
  }
}

async function readHold(
  layout: LayoutPaths,
  managedId: string,
): Promise<BootHoldRecord | null> {
  try {
    return parseHold(
      await Deno.readTextFile(bootHoldPath(layout, managedId)),
      managedId,
    );
  } catch {
    return null;
  }
}

async function writeHold(
  layout: LayoutPaths,
  record: BootHoldRecord,
): Promise<void> {
  await writeFileAtomic(
    bootHoldPath(layout, record.managedId),
    `${JSON.stringify(record)}\n`,
  );
}

async function stopEngine(
  run: DockerRunFn,
  managedId: string,
): Promise<boolean> {
  try {
    const result = await run([
      "compose",
      "-p",
      managedComposeProject(managedId),
      "stop",
    ]);
    if (!result.success) {
      logWarn(
        "managed",
        `boot hold: compose stop failed managedId=${managedId}:`,
        sanitizeForLog(result.stderr || result.stdout),
      );
    }
    return result.success;
  } catch (err) {
    logWarn(
      "managed",
      `boot hold: compose stop threw managedId=${managedId}:`,
      sanitizeForLog(err),
    );
    return false;
  }
}

/**
 * Hold every primary on this host after an unclean boot OR a planned reboot
 * that took longer than the control plane's window (P0-1 fix: a long clean
 * reboot could trigger promotion before this daemon starts, so the old primary
 * must be held until the control plane confirms it is still the primary).
 *
 * Any other boot kind does nothing. Never throws: a failure to hold one
 * cluster is logged and the rest are still held. Returns true only if all
 * clusters' hold files and markers were written (the boot record persists
 * only on success).
 */
export async function applyBootHold(
  kind: HostBootKind,
  deps: BootHoldDeps,
): Promise<boolean> {
  if (kind !== "unclean" && kind !== "clean-reboot") return true;
  const members = await (deps.listMembers ??
    (() => listManagedHaMembers(deps.layout)))();
  let holdFailed = false;
  const held: BootHoldRecord[] = [];
  await forEachSequential(members.filter(isHoldablePrimary), async (member) => {
    try {
      held.push(await holdOne(member, deps));
    } catch (err) {
      holdFailed = true;
      logWarn(
        "managed",
        `boot hold failed managedId=${member.managedId}:`,
        sanitizeForLog(err),
      );
    }
  });
  return !holdFailed;
}

async function holdOne(
  member: ManagedHaMemberRecord,
  deps: BootHoldDeps,
): Promise<BootHoldRecord> {
  const existing = await readHold(deps.layout, member.managedId);
  const record: BootHoldRecord = existing ?? {
    managedId: member.managedId,
    memberId: member.memberId,
    engine: member.engine,
    heldAt: (deps.nowIso ?? (() => new Date().toISOString()))(),
    engineStopped: false,
  };
  // Marker first: the dead-primary probe must never read the stop as a crash.
  await recordManagedIntent(deps.layout.stateDir, member.managedId, "stop", {
    mode: "held",
  });
  await Deno.mkdir(managedDir(deps.layout, member.managedId), {
    recursive: true,
  });
  await writeHold(deps.layout, record);
  logWarn(
    "managed",
    `host restarted without a clean shutdown: holding primary managedId=${member.managedId} member=${member.memberId} until the control plane confirms it is still the primary`,
  );
  const stopped = await stopEngine(deps.run, member.managedId);
  const final = { ...record, engineStopped: record.engineStopped || stopped };
  if (final.engineStopped !== record.engineStopped) {
    await writeHold(deps.layout, final);
  }
  return final;
}

/**
 * Holds still waiting on the control plane. A hold whose held `stop` marker
 * is gone was released by a successful start, restart, apply, promote or
 * destroy: the file is removed and it is not returned.
 */
export async function listActiveBootHolds(
  layout: LayoutPaths,
): Promise<BootHoldRecord[]> {
  const ids: string[] = [];
  try {
    for await (const entry of Deno.readDir(join(layout.stateDir, "managed"))) {
      if (entry.isDirectory && SAFE_MANAGED_ID_RE.test(entry.name)) {
        ids.push(entry.name);
      }
    }
  } catch {
    return [];
  }
  const active: BootHoldRecord[] = [];
  await forEachSequential(ids, async (id) => {
    const record = await readHold(layout, id);
    if (!record) return;
    const lookup = await lookupManagedIntent(layout.stateDir, id);
    const stillHeldStop = isHeldIntent(lookup) && lookup.status === "found" &&
      lookup.intent.kind === "stop";
    if (!stillHeldStop) {
      await Deno.remove(bootHoldPath(layout, id)).catch(() => undefined);
      logInfo(
        "managed",
        `boot hold released by a later command managedId=${id}`,
      );
      return;
    }
    active.push(record);
  });
  return active;
}

/** Retry the stop for a hold whose first `compose stop` failed. */
export async function ensureHoldStopped(
  record: BootHoldRecord,
  deps: Pick<BootHoldDeps, "layout" | "run">,
): Promise<BootHoldRecord> {
  if (record.engineStopped) return record;
  if (!(await stopEngine(deps.run, record.managedId))) return record;
  const next = { ...record, engineStopped: true };
  try {
    await writeHold(deps.layout, next);
  } catch (err) {
    // The engine is stopped; only the note about it was lost. Report on.
    logWarn(
      "managed",
      `boot hold: could not record the stop managedId=${record.managedId}:`,
      sanitizeForLog(err),
    );
  }
  return next;
}

/**
 * Release a hold ourselves (the control plane cannot answer): clear the held
 * marker, remove the file, start the engine again.
 */
export async function releaseBootHoldLocally(
  record: BootHoldRecord,
  deps: Pick<BootHoldDeps, "layout" | "run">,
  reason: string,
): Promise<void> {
  await clearManagedIntent(deps.layout.stateDir, record.managedId, reason);
  await Deno.remove(bootHoldPath(deps.layout, record.managedId)).catch(() =>
    undefined
  );
  const started = await deps.run([
    "compose",
    "-p",
    managedComposeProject(record.managedId),
    "start",
  ]);
  if (!started.success) {
    logWarn(
      "managed",
      `boot hold release: compose start failed managedId=${record.managedId}:`,
      sanitizeForLog(started.stderr || started.stdout),
    );
  }
}

/**
 * Retry `ensureHoldStopped` for every active hold with a local timer,
 * independent of the control-plane socket. Runs every 5-10 seconds until
 * every hold has `engineStopped: true` or is released by a command.
 *
 * P1-2 fix: a failed `compose stop` retries even when the control plane is
 * unreachable, so a stale primary does not keep serving the hold window.
 * The socket-based reporter would retry only when connected.
 */
export class BootHoldLocalRetry {
  #timer: ReturnType<typeof setInterval> | undefined;
  #ticking = false;

  constructor(
    readonly layout: LayoutPaths,
    readonly run: DockerRunFn,
  ) {}

  start(): void {
    this.stop();
    this.#timer = setInterval(() => {
      void this.tick();
    }, 5_000); // 5s cadence
    void this.tick();
  }

  stop(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      const holds = await listActiveBootHolds(this.layout);
      const unstopped = holds.filter((h) => !h.engineStopped);
      if (unstopped.length === 0) {
        // No more holds to retry; stop the timer.
        this.stop();
        return;
      }
      await forEachSequential(unstopped, (hold) =>
        ensureHoldStopped(hold, { layout: this.layout, run: this.run })
      );
    } catch (err) {
      logWarn(
        "managed",
        `boot hold local retry failed:`,
        sanitizeForLog(err),
      );
    } finally {
      this.#ticking = false;
    }
  }
}
