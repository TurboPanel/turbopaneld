/**
 * Periodic `compose start` for a managed member whose engine container is
 * down but should be running (not demoted, not needs_resync, no held stop).
 *
 * Docker's `restart: unless-stopped` revives a `docker kill`, but
 * `compose stop` (operator stop, boot hold, demoted fence) leaves the project
 * stopped until something starts it again. This guard is that backstop.
 */

import type { EnvironmentDeployContainer } from "../contracts/commands-contracts.ts";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { logInfo, logWarn, sanitizeForLog } from "../util/logger.ts";
import { forEachSequential } from "../util/sequential.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { collectManagedContainers } from "./containers.ts";
import { isManagedMemberDestroyed } from "./destroyed-marker.ts";
import { isManagedMemberDemoted } from "./demoted-marker.ts";
import { managedComposeProject, managedDir } from "./engine-paths.ts";
import {
  HOST_WIDE_INTENT_ID,
  type IntentLookup,
  isHeldIntent,
  isIntentLookupActive,
  lookupManagedIntent,
} from "./ha-intent.ts";
import {
  listManagedHaMembers,
  type ManagedHaMemberRecord,
} from "./ha-member.ts";
import { replicaStandbyDataAllowsEngineStart } from "./replica-start-guard.ts";
import { tryWithManagedLifecycleLock } from "./target-lock.ts";
import { isBootHoldUnsettled } from "./boot-hold.ts";

export const ENGINE_EXIT_GUARD_INTERVAL_MS = 60_000;
export const ENGINE_EXIT_GUARD_MIN_START_GAP_MS = 60_000;
/** The wait between starts doubles after each try, up to this ceiling. */
export const ENGINE_EXIT_GUARD_MAX_START_GAP_MS = 15 * 60_000;
/** Starts tried without ever seeing the engine up before the guard gives up. */
export const ENGINE_EXIT_GUARD_MAX_ATTEMPTS = 6;

export type DockerRunFn = (args: string[]) => Promise<DockerCliResult>;

export type ManagedEngineExitGuardDeps = {
  layout: LayoutPaths;
  run: DockerRunFn;
  listMembers?: () => Promise<ManagedHaMemberRecord[]>;
  intervalMs?: number;
  minStartGapMs?: number;
  nowMs?: () => number;
  /**
   * True while the boot hold has not finished (members not yet listed): no
   * engine may be started until the hold has been applied.
   */
  startPaused?: () => boolean;
};

type StartAttempts = { count: number; lastMs: number; gaveUp: boolean };

function engineContainersDown(
  containers: EnvironmentDeployContainer[],
): boolean {
  if (containers.length === 0) return true;
  const states = containers.map((c) => c.status.toLowerCase());
  return states.every((s) => s === "exited" || s === "dead" || s === "stopped");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    return stat.isDirectory || stat.isFile;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

/** Held stop/destroy, unreadable marker, or any active operator intent. */
function intentLookupBlocksEngineStart(
  lookup: IntentLookup,
  nowMs: number,
): boolean {
  if (lookup.status === "unreadable") return true;
  if (lookup.status !== "found") return false;
  if (
    isHeldIntent(lookup) &&
    (lookup.intent.kind === "stop" || lookup.intent.kind === "destroy")
  ) {
    return true;
  }
  return isIntentLookupActive(lookup, nowMs);
}

async function intentBlocksEngineStart(
  stateDir: string,
  managedId: string,
  nowMs: number,
): Promise<boolean> {
  const [cluster, host] = await Promise.all([
    lookupManagedIntent(stateDir, managedId),
    lookupManagedIntent(stateDir, HOST_WIDE_INTENT_ID),
  ]);
  return intentLookupBlocksEngineStart(cluster, nowMs) ||
    intentLookupBlocksEngineStart(host, nowMs);
}

async function composeStartStoppedEngine(
  run: DockerRunFn,
  project: string,
  managedId: string,
  member: ManagedHaMemberRecord,
): Promise<void> {
  logInfo(
    "managed",
    `engine exit guard: starting stopped engine managedId=${managedId} member=${member.memberId} role=${member.role}`,
  );
  const result = await run(["compose", "-p", project, "start"]);
  if (!result.success) {
    logWarn(
      "managed",
      `engine exit guard: compose start failed managedId=${managedId}:`,
      sanitizeForLog(result.stderr || result.stdout),
    );
  }
}

export class ManagedEngineExitGuard {
  #timer: ReturnType<typeof setInterval> | undefined;
  #ticking = false;
  readonly #layout: LayoutPaths;
  readonly #run: DockerRunFn;
  readonly #listMembers: () => Promise<ManagedHaMemberRecord[]>;
  readonly #intervalMs: number;
  readonly #minStartGapMs: number;
  readonly #nowMs: () => number;
  readonly #startPaused: () => boolean;
  readonly #attempts = new Map<string, StartAttempts>();
  readonly #loggedSkip = new Set<string>();

  constructor(deps: ManagedEngineExitGuardDeps) {
    this.#layout = deps.layout;
    this.#run = deps.run;
    this.#listMembers = deps.listMembers ??
      (() => listManagedHaMembers(deps.layout));
    this.#intervalMs = deps.intervalMs ?? ENGINE_EXIT_GUARD_INTERVAL_MS;
    this.#minStartGapMs = deps.minStartGapMs ??
      ENGINE_EXIT_GUARD_MIN_START_GAP_MS;
    this.#nowMs = deps.nowMs ?? (() => Date.now());
    this.#startPaused = deps.startPaused ?? (() => false);
  }

  start(): void {
    this.stop();
    this.#timer = setInterval(() => {
      void this.tick();
    }, this.#intervalMs);
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
    if (this.#startPaused()) return;
    this.#ticking = true;
    try {
      const members = await this.#listMembers();
      await forEachSequential(members, (member) => this.#healOne(member));
    } catch (err) {
      logWarn(
        "managed",
        "engine exit guard failed:",
        sanitizeForLog(err),
      );
    } finally {
      this.#ticking = false;
    }
  }

  async #healOne(member: ManagedHaMemberRecord): Promise<void> {
    const acquired = await tryWithManagedLifecycleLock(
      this.#layout,
      member.managedId,
      () => this.#maybeStart(member),
    );
    if (!acquired) return;
  }

  /** Demoted, destroyed, held, mid-command or boot-held: leave it stopped. */
  async #meantToStayStopped(
    member: ManagedHaMemberRecord,
    now: number,
  ): Promise<boolean> {
    const { managedId } = member;
    if (isBootHoldUnsettled(managedId)) return true;
    if (await isManagedMemberDemoted(this.#layout, managedId)) {
      this.#loggedSkip.delete(managedId);
      return true;
    }
    if (
      await isManagedMemberDestroyed(
        this.#layout.stateDir,
        managedId,
        member.memberId,
      )
    ) {
      this.#loggedSkip.delete(managedId);
      return true;
    }
    return await intentBlocksEngineStart(this.#layout.stateDir, managedId, now);
  }

  /** The wait is still running, or the guard has given up on this engine. */
  #startBackoffBlocks(managedId: string, now: number): boolean {
    const tries = this.#attempts.get(managedId);
    if (tries === undefined) return false;
    if (tries.gaveUp) return true;
    const gap = Math.min(
      this.#minStartGapMs * 2 ** (tries.count - 1),
      Math.max(ENGINE_EXIT_GUARD_MAX_START_GAP_MS, this.#minStartGapMs),
    );
    return now - tries.lastMs < gap;
  }

  #noteStartAttempt(managedId: string, now: number): void {
    const count = (this.#attempts.get(managedId)?.count ?? 0) + 1;
    const gaveUp = count >= ENGINE_EXIT_GUARD_MAX_ATTEMPTS;
    this.#attempts.set(managedId, { count, lastMs: now, gaveUp });
    if (gaveUp) {
      logWarn(
        "managed",
        `engine exit guard: engine did not stay up after ${count} starts, giving up until it runs again or an operator starts it managedId=${managedId}`,
      );
    }
  }

  async #standbyAllowsStart(member: ManagedHaMemberRecord): Promise<boolean> {
    const { managedId, memberId } = member;
    try {
      const allowed = await replicaStandbyDataAllowsEngineStart(
        this.#layout,
        managedId,
        member.engine,
        member.role,
        this.#run,
      );
      if (allowed || this.#loggedSkip.has(managedId)) return allowed;
      logInfo(
        "managed",
        `engine exit guard: not starting replica with non-standby data managedId=${managedId} member=${memberId}`,
      );
      this.#loggedSkip.add(managedId);
      return false;
    } catch (err) {
      logWarn(
        "managed",
        `engine exit guard: standby probe failed managedId=${managedId}:`,
        sanitizeForLog(err),
      );
      return false;
    }
  }

  async #maybeStart(member: ManagedHaMemberRecord): Promise<void> {
    const { managedId } = member;
    if (!(await pathExists(managedDir(this.#layout, managedId)))) return;

    const now = this.#nowMs();
    if (await this.#meantToStayStopped(member, now)) return;

    const project = managedComposeProject(managedId);
    const containers = await collectManagedContainers(
      project,
      (text) => sanitizeForLog(text),
      this.#run,
    );
    if (containers === undefined) return;
    if (!engineContainersDown(containers)) {
      this.#loggedSkip.delete(managedId);
      this.#attempts.delete(managedId);
      return;
    }

    // Cheap checks first: the standby probe runs a container.
    if (this.#startBackoffBlocks(managedId, now)) return;
    if (!(await this.#standbyAllowsStart(member))) return;

    this.#noteStartAttempt(managedId, now);
    await composeStartStoppedEngine(this.#run, project, managedId, member);
  }
}
