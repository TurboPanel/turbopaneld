/**
 * Planned Postgres switchover on the old primary's host: report its final
 * write position after the clean stop, remember which switchover it was for,
 * and refuse a forced re-seed (a wipe of this data directory) that does not
 * belong to that switchover.
 *
 * The record is written by the fence stop (`switchoverRecoveryId`,
 * `primaryEpoch`) and read by the forced `managed.apply` that carries
 * `switchoverReseed`. The refusal runs before anything is touched. An
 * operator Resync carries no `switchoverReseed` and is never checked here.
 */

import { join } from "@std/path";
import type {
  ManagedApplyPayload,
  ManagedLifecyclePayload,
} from "../contracts/commands-contracts.ts";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { logWarn, sanitizeForLog } from "../util/logger.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { readManagedComposeDataTarget } from "./compose.ts";
import { getManagedEngineRuntime } from "./engines/index.ts";
import {
  managedComposePath,
  managedDir,
  SAFE_MANAGED_ID_RE,
} from "./engine-paths.ts";
import { writeFileAtomic } from "./ha-intent.ts";
import { isManagedMemberDemoted } from "./demoted-marker.ts";

const RECORD_FILE = "switchover-final-position.json";

type RunDockerFn = (args: string[]) => Promise<DockerCliResult>;

export type SwitchoverFinalPositionRecord = {
  recoveryId: string;
  /** Primary epoch when the switchover began (before its promote). */
  epoch: number;
  lsn: string;
  timeline: number;
  recordedAt: string;
};

function recordPath(layout: LayoutPaths, managedId: string): string {
  if (!SAFE_MANAGED_ID_RE.test(managedId)) {
    throw new Error("managedId contains unsupported characters");
  }
  return join(managedDir(layout, managedId), RECORD_FILE);
}

export async function writeSwitchoverFinalPositionRecord(
  layout: LayoutPaths,
  managedId: string,
  record: SwitchoverFinalPositionRecord,
): Promise<void> {
  await Deno.mkdir(managedDir(layout, managedId), { recursive: true });
  await writeFileAtomic(
    recordPath(layout, managedId),
    `${JSON.stringify(record)}\n`,
  );
}

function recordFromJson(value: unknown): SwitchoverFinalPositionRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.recoveryId !== "string" || typeof v.lsn !== "string" ||
    typeof v.recordedAt !== "string" ||
    typeof v.epoch !== "number" || !Number.isInteger(v.epoch) ||
    typeof v.timeline !== "number" || !Number.isInteger(v.timeline)
  ) {
    return null;
  }
  return {
    recoveryId: v.recoveryId,
    epoch: v.epoch,
    lsn: v.lsn,
    timeline: v.timeline,
    recordedAt: v.recordedAt,
  };
}

export async function readSwitchoverFinalPositionRecord(
  layout: LayoutPaths,
  managedId: string,
): Promise<SwitchoverFinalPositionRecord | null> {
  let text: string;
  try {
    text = await Deno.readTextFile(recordPath(layout, managedId));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
  try {
    return recordFromJson(JSON.parse(text));
  } catch {
    return null;
  }
}

export async function clearSwitchoverFinalPositionRecord(
  layout: LayoutPaths,
  managedId: string,
): Promise<void> {
  try {
    await Deno.remove(recordPath(layout, managedId));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    throw err;
  }
}

export type FinalPositionReport = {
  oldPrimaryFinalLsn: string;
  oldPrimaryFinalTimeline: number;
};

/**
 * After the engine was stopped by a Postgres fence stop that asked for the
 * final position: read it from the stopped data volume and record it. Never
 * throws and never fails the stop; `undefined` = no position to report (the
 * control plane then does not re-seed).
 */
export async function captureFinalPositionAfterStop(
  payload: ManagedLifecyclePayload,
  layout: LayoutPaths,
  run: RunDockerFn,
  now: () => string = () => new Date().toISOString(),
): Promise<FinalPositionReport | undefined> {
  if (payload.action !== "stop") return undefined;
  if (payload.switchoverRecoveryId === undefined) return undefined;
  if (payload.primaryEpoch === undefined) return undefined;
  if ((payload.engine ?? "postgres") !== "postgres") return undefined;
  try {
    const runtime = getManagedEngineRuntime("postgres");
    const read = runtime.replication?.readStoppedPrimaryFinalPosition;
    if (read === undefined) return undefined;
    const target = readManagedComposeDataTarget(
      await Deno.readTextFile(managedComposePath(layout, payload.managedId)),
    );
    const position = await read({
      image: target.image,
      volumes: target.volumes,
      containerUser: runtime.containerUser,
      runDocker: (argv) => run(argv),
    });
    if (position === null) {
      logWarn(
        "managed",
        "switchover final position: engine did not shut down cleanly or the position is unreadable",
      );
      return undefined;
    }
    await writeSwitchoverFinalPositionRecord(layout, payload.managedId, {
      recoveryId: payload.switchoverRecoveryId,
      epoch: payload.primaryEpoch,
      lsn: position.lsn,
      timeline: position.timeline,
      recordedAt: now(),
    });
    return {
      oldPrimaryFinalLsn: position.lsn,
      oldPrimaryFinalTimeline: position.timeline,
    };
  } catch (err) {
    logWarn(
      "managed",
      "switchover final position failed:",
      sanitizeForLog(err),
    );
    return undefined;
  }
}

function refusal(reason: string): Error {
  return new Error(
    `managed.apply switchover re-seed refused: ${reason}; the data directory was not touched`,
  );
}

/**
 * Throws before any wipe when a forced re-seed does not belong to the
 * switchover this host fenced: no record, another recovery, a primary that
 * changed since (the epoch must be exactly one past the epoch recorded at the
 * fence stop: one promote), or a member that is no longer a fenced former
 * primary. A payload without `switchoverReseed` is never checked.
 */
export async function assertSwitchoverReseedAllowed(
  layout: LayoutPaths,
  payload: ManagedApplyPayload,
): Promise<void> {
  const reseed = payload.switchoverReseed;
  if (reseed === undefined || payload.forceResync !== true) return;
  if (reseed.sourceMemberId !== payload.memberId) {
    throw refusal("the re-seed is for another member");
  }
  const record = await readSwitchoverFinalPositionRecord(
    layout,
    payload.managedId,
  );
  if (record === null) {
    throw refusal("this host holds no final position of a switchover stop");
  }
  if (record.recoveryId !== reseed.recoveryId) {
    throw refusal("it belongs to another switchover (stale recovery)");
  }
  if (reseed.epoch !== record.epoch + 1) {
    throw refusal("the primary changed since it was queued (stale epoch)");
  }
  if (!(await isManagedMemberDemoted(layout, payload.managedId))) {
    throw refusal("this member is no longer a fenced former primary");
  }
}
