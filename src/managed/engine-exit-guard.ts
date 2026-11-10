/**
 * Periodic `compose start` for a managed member whose engine container is
 * down but should be running (not demoted, not needs_resync, no held stop).
 *
 * Docker's `restart: unless-stopped` revives a `docker kill`, but
 * `compose stop` (operator stop, boot hold, demoted fence) leaves the project
 * stopped until something starts it again. This guard is that backstop.
 *
 * One exception: a primary with peers whose engine is already down the first
 * time this process looks at it is never started here. The daemon did not see
 * it stop, and while it was down the control plane may have promoted another
 * member; starting it would let it take writes as a second primary until the
 * control plane's return fence reaches it. It gets a boot hold instead
 * (`boot-hold.ts`), which the control plane answers with a start (still the
 * primary) or leaves stopped (replaced). Once this process has seen the engine
 * running, or a control-plane command has settled it, later exits are started
 * as before.
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
import {
  holdUnconfirmedPrimary,
  isBootHoldUnsettled,
  isHoldablePrimary,
} from "./boot-hold.ts";

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
  /** Called once when the guard stops trying for one engine (test seam). */
  onGiveUp?: (managedId: string) => void;
  /** Test seam — defaults to {@link holdUnconfirmedPrimary}. */
  holdPrimary?: (member: ManagedHaMemberRecord) => Promise<void>;
};

/** Why an engine is left stopped, or `undefined` when it may be started. */
type StayStopped =
  /** A control-plane command or marker owns the engine's state. */
  | "settled"
  /**
   * Local doubt or a marker that ends by the clock (boot hold not finished,
   * unreadable marker, active command window).
   */
  | "unsure";

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
): StayStopped | undefined {
  if (lookup.status === "unreadable") return "unsure";
  if (lookup.status !== "found") return undefined;
  // A requested stop stands until an explicit start, restart, apply, promote
  // or failover replaces the marker, even after its timer ran out: a stop
  // that failed half way leaves only a timed marker, and the engine must not
  // come back on its own once that expires. Only a control-plane command can
  // lift these, so they settle the engine.
  if (lookup.intent.kind === "stop") return "settled";
  if (isHeldIntent(lookup) && lookup.intent.kind === "destroy") {
    return "settled";
  }
  // Any other marker ends by the clock (the window after an apply, a command
  // cut off by a daemon crash): it blocks the start but vouches for nothing.
  return isIntentLookupActive(lookup, nowMs) ? "unsure" : undefined;
}

async function intentBlocksEngineStart(
  stateDir: string,
  managedId: string,
  nowMs: number,
): Promise<StayStopped | undefined> {
  const [cluster, host] = await Promise.all([
    lookupManagedIntent(stateDir, managedId),
    lookupManagedIntent(stateDir, HOST_WIDE_INTENT_ID),
  ]);
  const reasons = new Set([
    intentLookupBlocksEngineStart(cluster, nowMs),
    intentLookupBlocksEngineStart(host, nowMs),
  ]);
  if (reasons.has("unsure")) return "unsure";
  return reasons.has("settled") ? "settled" : undefined;
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
  readonly #onGiveUp: (managedId: string) => void;
  readonly #holdPrimary: (member: ManagedHaMemberRecord) => Promise<void>;
  readonly #attempts = new Map<string, StartAttempts>();
  readonly #loggedSkip = new Set<string>();
  /**
   * Clusters this process has seen running, held, or left to a control-plane
   * command. A primary with peers that is down and not in here is held instead
   * of started (see the file comment).
   */
  readonly #vouched = new Set<string>();

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
    this.#onGiveUp = deps.onGiveUp ?? (() => undefined);
    this.#holdPrimary = deps.holdPrimary ??
      ((member) =>
        holdUnconfirmedPrimary(member, { layout: deps.layout, run: deps.run }));
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
    const reason = await this.#stayStoppedReason(member, now);
    // What happens next to a settled engine is a control-plane command, which
    // knows the member's role: a later exit needs no new confirmation.
    if (reason === "settled") this.#vouched.add(member.managedId);
    return reason !== undefined;
  }

  async #stayStoppedReason(
    member: ManagedHaMemberRecord,
    now: number,
  ): Promise<StayStopped | undefined> {
    const { managedId } = member;
    if (isBootHoldUnsettled(managedId)) return "unsure";
    if (await isManagedMemberDemoted(this.#layout, managedId)) {
      this.#loggedSkip.delete(managedId);
      return "settled";
    }
    if (
      await isManagedMemberDestroyed(
        this.#layout.stateDir,
        managedId,
        member.memberId,
      )
    ) {
      this.#loggedSkip.delete(managedId);
      return "settled";
    }
    return await intentBlocksEngineStart(this.#layout.stateDir, managedId, now);
  }

  /**
   * A primary with peers found down before this process ever saw it run:
   * hold it for the control plane instead of starting it. True when the
   * engine must not be started on this tick.
   */
  async #holdsUnconfirmedPrimary(
    member: ManagedHaMemberRecord,
  ): Promise<boolean> {
    const { managedId } = member;
    if (this.#vouched.has(managedId) || !isHoldablePrimary(member)) {
      return false;
    }
    try {
      await this.#holdPrimary(member);
      this.#vouched.add(managedId);
    } catch (err) {
      // Not vouched: the next tick tries the hold again. The engine stays
      // stopped meanwhile.
      logWarn(
        "managed",
        `engine exit guard: could not hold unconfirmed primary managedId=${managedId}:`,
        sanitizeForLog(err),
      );
    }
    return true;
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
      this.#onGiveUp(managedId);
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
      this.#vouched.add(managedId);
      this.#loggedSkip.delete(managedId);
      this.#attempts.delete(managedId);
      return;
    }
    if (await this.#holdsUnconfirmedPrimary(member)) return;

    // Cheap checks first: the standby probe runs a container.
    if (this.#startBackoffBlocks(managedId, now)) return;
    if (!(await this.#standbyAllowsStart(member))) return;

    // The probe above takes seconds and stop, restore and failover commands
    // do not take the lifecycle lock: look again right before starting.
    if (await this.#meantToStayStopped(member, this.#nowMs())) return;

    this.#noteStartAttempt(managedId, now);
    await composeStartStoppedEngine(this.#run, project, managedId, member);
  }
}
