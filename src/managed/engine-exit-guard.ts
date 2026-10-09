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
import { isManagedMemberDemoted } from "./demoted-marker.ts";
import { managedComposeProject, managedDir } from "./engine-paths.ts";
import {
  type IntentLookup,
  isHeldIntent,
  isIntentLookupActive,
  isRunningIntent,
  lookupManagedIntent,
} from "./ha-intent.ts";
import {
  listManagedHaMembers,
  type ManagedHaMemberRecord,
} from "./ha-member.ts";
import { replicaStandbyDataAllowsEngineStart } from "./replica-start-guard.ts";
import { tryWithManagedLifecycleLock } from "./target-lock.ts";

export const ENGINE_EXIT_GUARD_INTERVAL_MS = 60_000;
export const ENGINE_EXIT_GUARD_MIN_START_GAP_MS = 60_000;

export type DockerRunFn = (args: string[]) => Promise<DockerCliResult>;

export type ManagedEngineExitGuardDeps = {
  layout: LayoutPaths;
  run: DockerRunFn;
  listMembers?: () => Promise<ManagedHaMemberRecord[]>;
  intervalMs?: number;
  minStartGapMs?: number;
  nowMs?: () => number;
};

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

/** Held stop/destroy, unreadable marker, or an in-flight command. */
function intentBlocksEngineStart(lookup: IntentLookup, nowMs: number): boolean {
  if (lookup.status === "unreadable") return true;
  if (lookup.status !== "found") return false;
  if (
    isHeldIntent(lookup) &&
    (lookup.intent.kind === "stop" || lookup.intent.kind === "destroy")
  ) {
    return true;
  }
  return isRunningIntent(lookup) && isIntentLookupActive(lookup, nowMs);
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
  readonly #lastStartAttempt = new Map<string, number>();
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

  async #maybeStart(member: ManagedHaMemberRecord): Promise<void> {
    const { managedId, memberId } = member;
    if (!(await pathExists(managedDir(this.#layout, managedId)))) return;

    if (
      await isManagedMemberDemoted(this.#layout, managedId, member.memberId)
    ) {
      this.#loggedSkip.delete(managedId);
      return;
    }

    const now = this.#nowMs();
    const lookup = await lookupManagedIntent(this.#layout.stateDir, managedId);
    if (intentBlocksEngineStart(lookup, now)) return;

    const project = managedComposeProject(managedId);
    const containers = await collectManagedContainers(
      project,
      (text) => sanitizeForLog(text),
      this.#run,
    );
    if (containers === undefined) return;
    if (!engineContainersDown(containers)) {
      this.#loggedSkip.delete(managedId);
      return;
    }

    let mayStart: boolean;
    try {
      mayStart = await replicaStandbyDataAllowsEngineStart(
        this.#layout,
        managedId,
        member.engine,
        member.role,
        this.#run,
      );
    } catch (err) {
      logWarn(
        "managed",
        `engine exit guard: standby probe failed managedId=${managedId}:`,
        sanitizeForLog(err),
      );
      return;
    }
    if (!mayStart) {
      if (!this.#loggedSkip.has(managedId)) {
        logInfo(
          "managed",
          `engine exit guard: not starting replica with non-standby data managedId=${managedId} member=${memberId}`,
        );
        this.#loggedSkip.add(managedId);
      }
      return;
    }

    const last = this.#lastStartAttempt.get(managedId) ?? 0;
    if (now - last < this.#minStartGapMs) return;

    this.#lastStartAttempt.set(managedId, now);
    await composeStartStoppedEngine(this.#run, project, managedId, member);
  }
}
