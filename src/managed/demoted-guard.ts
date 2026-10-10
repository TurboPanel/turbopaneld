/**
 * Periodic stop of a fenced (demoted) member whose engine was started by
 * hand. Never starts anything, never deletes data, never touches a member
 * without a demoted marker.
 */

import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { logError, logWarn, sanitizeForLog } from "../util/logger.ts";
import { forEachSequential } from "../util/sequential.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { readManagedComposeContainerName } from "./compose.ts";
import { collectRunningContainersByComposeProjectLabel } from "./containers.ts";
import {
  clearDemotedFenceAlerts,
  isManagedMemberDemoted,
  listDemotedFenceTargets,
  markDemotedFenceUnsafe,
} from "./demoted-marker.ts";
import {
  enforceFencedReadOnlySql,
  isFencedMemberStillWritable,
  persistDemotedVolumeFenceBestEffort,
} from "./fenced-member-enforce.ts";
import { managedComposePath, managedComposeProject } from "./engine-paths.ts";
import { isManagedMemberDestroyed } from "./destroyed-marker.ts";
import { recordManagedIntent } from "./ha-intent.ts";
import {
  type ManagedHaMemberRecord,
  readManagedHaMember,
} from "./ha-member.ts";
import { tryWithManagedLifecycleLock } from "./target-lock.ts";

export const DEMOTED_GUARD_INTERVAL_MS = 5_000;

/** Stop passes per tick before escalating to kill + the durable unsafe flag. */
const MAX_STOP_PASSES = 3;

const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";
const SAFE_CONTAINER_ID_RE = /^[a-f0-9]{12,64}$/i;
/** Docker container-name grammar; anything else never reaches argv. */
const SAFE_CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;

export type DockerRunFn = (args: string[]) => Promise<DockerCliResult>;

export type DemotedMemberGuardDeps = {
  layout: LayoutPaths;
  run: DockerRunFn;
  listMembers?: () => Promise<ManagedHaMemberRecord[]>;
  intervalMs?: number;
};

type GuardTarget = { layout: LayoutPaths; run: DockerRunFn; managedId: string };

function parseComposeProjectContainerIds(stdout: string): string[] {
  return stdout
    .trim()
    .split(/\s+/)
    .filter((id) => SAFE_CONTAINER_ID_RE.test(id));
}

async function listComposeProjectContainerIds(
  run: DockerRunFn,
  project: string,
): Promise<string[] | null> {
  const listed = await run([
    "ps",
    "-aq",
    "--filter",
    `label=${COMPOSE_PROJECT_LABEL}=${project}`,
  ]);
  if (!listed.success) return null;
  return parseComposeProjectContainerIds(listed.stdout);
}

/** Running ids by label, else by `compose ps -q`; `null` when both fail. */
async function fallbackComposeProjectContainerIds(
  run: DockerRunFn,
  project: string,
): Promise<string[] | null> {
  const byLabel = await collectRunningContainersByComposeProjectLabel(
    project,
    run,
  );
  if (byLabel && byLabel.length > 0) {
    return byLabel.map((row) => row.containerId);
  }
  const composeListed = await run(["compose", "-p", project, "ps", "-q"]);
  if (composeListed.success) {
    return parseComposeProjectContainerIds(composeListed.stdout);
  }
  return byLabel ? [] : null;
}

async function readComposeContainerNameBestEffort(
  target: GuardTarget,
): Promise<string | undefined> {
  try {
    return readManagedComposeContainerName(
      await Deno.readTextFile(
        managedComposePath(target.layout, target.managedId),
      ),
      managedComposeProject(target.managedId),
    );
  } catch {
    return undefined;
  }
}

/**
 * Container names to stop when no listing works: the HA member record's
 * name and the persisted compose file's name, validated before argv.
 */
async function demotedContainerNames(target: GuardTarget): Promise<string[]> {
  const member = await readManagedHaMember(target.layout, target.managedId)
    .catch(() => null);
  const fromCompose = await readComposeContainerNameBestEffort(target);
  const names = [member?.containerName, fromCompose].filter(
    (name): name is string =>
      typeof name === "string" && SAFE_CONTAINER_NAME_RE.test(name),
  );
  return [...new Set(names)];
}

async function stopOrKill(run: DockerRunFn, refs: string[]): Promise<void> {
  if (refs.length === 0) return;
  const stopped = await run(["stop", ...refs]);
  if (stopped.success) return;
  await run(["kill", ...refs]);
}

/** Every listing failed: kill the compose project, then stop/kill by name. */
async function stopByNameWithoutListing(target: GuardTarget): Promise<void> {
  const project = managedComposeProject(target.managedId);
  logError(
    "managed",
    `demoted member guard: every container listing failed; killing by project and name project=${project}`,
  );
  await target.run(["compose", "-p", project, "kill"]);
  await stopOrKill(target.run, await demotedContainerNames(target));
}

async function forceStopComposeProjectContainers(
  target: GuardTarget,
): Promise<void> {
  const project = managedComposeProject(target.managedId);
  let ids = await listComposeProjectContainerIds(target.run, project);
  if (ids === null) {
    logWarn(
      "managed",
      `demoted member guard: docker ps failed; retrying container listing project=${project}`,
    );
    ids = await listComposeProjectContainerIds(target.run, project);
  }
  ids ??= await fallbackComposeProjectContainerIds(target.run, project);
  if (ids === null) {
    await stopByNameWithoutListing(target);
    return;
  }
  await stopOrKill(target.run, ids);
}

async function stopDemotedEngine(target: GuardTarget): Promise<void> {
  const project = managedComposeProject(target.managedId);
  const result = await target.run(["compose", "-p", project, "stop"]);
  if (!result.success) {
    logError(
      "managed",
      `demoted member guard: compose stop failed managedId=${target.managedId}:`,
      sanitizeForLog(result.stderr || result.stdout),
    );
  }
  await forceStopComposeProjectContainers(target);
}

/** Last resort for one tick: kill by project, by running id and by name. */
async function killDemotedEngine(target: GuardTarget): Promise<void> {
  const project = managedComposeProject(target.managedId);
  await target.run(["compose", "-p", project, "kill"]);
  const ids = await fallbackComposeProjectContainerIds(target.run, project);
  if (ids && ids.length > 0) await target.run(["kill", ...ids]);
  const names = await demotedContainerNames(target);
  if (names.length > 0) await target.run(["kill", ...names]);
}

/** Bounded retry (recursion, not an awaited loop): true once not writable. */
async function stopUntilNotWritable(
  target: GuardTarget,
  engine: ManagedHaMemberRecord["engine"],
  passesLeft: number,
): Promise<boolean> {
  if (passesLeft <= 0) return false;
  await stopDemotedEngine(target);
  if (
    !(await isFencedMemberStillWritable(
      target.layout,
      target.managedId,
      engine,
      target.run,
    ))
  ) {
    return true;
  }
  return stopUntilNotWritable(target, engine, passesLeft - 1);
}

async function bestEffort(
  what: string,
  managedId: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    logError(
      "managed",
      `demoted member guard: ${what} failed managedId=${managedId}:`,
      sanitizeForLog(err),
    );
  }
}

export class DemotedMemberGuard {
  #timer: ReturnType<typeof setInterval> | undefined;
  #ticking = false;
  readonly #warned = new Set<string>();
  readonly #unsafeLogged = new Set<string>();
  readonly #layout: LayoutPaths;
  readonly #run: DockerRunFn;
  readonly #listTargets: () => Promise<ManagedHaMemberRecord[]>;
  readonly #intervalMs: number;

  constructor(deps: DemotedMemberGuardDeps) {
    this.#layout = deps.layout;
    this.#run = deps.run;
    this.#listTargets = deps.listMembers ??
      (async () => {
        const targets = await listDemotedFenceTargets(deps.layout);
        return targets.flatMap((target) => {
          if (!target.engine) return [];
          return [{
            managedId: target.managedId,
            memberId: target.memberId ?? "",
            engine: target.engine,
            role: "primary" as const,
            containerName: "",
            replicaPeerCount: 0,
            updatedAt: "",
          }];
        });
      });
    this.#intervalMs = deps.intervalMs ?? DEMOTED_GUARD_INTERVAL_MS;
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
      const members = await this.#listTargets();
      await forEachSequential(
        members,
        (member) => this.#fenceOneIsolated(member),
      );
    } catch (err) {
      logWarn(
        "managed",
        "demoted member guard failed:",
        sanitizeForLog(err),
      );
    } finally {
      this.#ticking = false;
    }
  }

  /** One member's failure never skips the others in the same tick. */
  async #fenceOneIsolated(member: ManagedHaMemberRecord): Promise<void> {
    await bestEffort(
      "fence check",
      member.managedId,
      () => this.#fenceOne(member),
    );
  }

  async #fenceOne(member: ManagedHaMemberRecord): Promise<void> {
    const memberId = member.memberId.length > 0 ? member.memberId : undefined;
    if (
      await isManagedMemberDestroyed(
        this.#layout.stateDir,
        member.managedId,
        memberId,
      )
    ) {
      return;
    }
    if (!(await isManagedMemberDemoted(this.#layout, member.managedId))) {
      this.#settle(member.managedId);
      return;
    }
    await tryWithManagedLifecycleLock(
      this.#layout,
      member.managedId,
      () => this.#checkAndStop(member),
    );
  }

  #settle(managedId: string): void {
    this.#warned.delete(managedId);
    this.#unsafeLogged.delete(managedId);
  }

  async #settleFenced(managedId: string): Promise<void> {
    this.#settle(managedId);
    await bestEffort(
      "clearing fence alerts",
      managedId,
      () => clearDemotedFenceAlerts(this.#layout, managedId),
    );
  }

  /**
   * Under the lifecycle lock: re-plant the on-disk fence, and if the engine
   * is (or may be) writable, enforce SQL read-only and stop it regardless —
   * the container stop is the real fence. Bookkeeping failures never skip
   * the stop. A standby / read-only engine is left running.
   */
  async #checkAndStop(member: ManagedHaMemberRecord): Promise<void> {
    const { managedId, engine } = member;
    if (!(await isManagedMemberDemoted(this.#layout, managedId))) {
      this.#settle(managedId);
      return;
    }
    const target: GuardTarget = {
      layout: this.#layout,
      run: this.#run,
      managedId,
    };
    await persistDemotedVolumeFenceBestEffort(
      this.#layout,
      managedId,
      engine,
      this.#run,
    );
    if (
      !(await isFencedMemberStillWritable(
        this.#layout,
        managedId,
        engine,
        this.#run,
      ))
    ) {
      await this.#settleFenced(managedId);
      return;
    }
    await bestEffort(
      "held stop intent",
      managedId,
      () =>
        recordManagedIntent(this.#layout.stateDir, managedId, "stop", {
          mode: "held",
        }),
    );
    if (!this.#warned.has(managedId)) {
      logWarn(
        "managed",
        `demoted member is writable; stopping it managedId=${managedId} member=${member.memberId}`,
      );
      this.#warned.add(managedId);
    }
    await enforceFencedReadOnlySql(this.#layout, managedId, engine, this.#run);
    let stopped = false;
    await bestEffort("stop passes", managedId, async () => {
      stopped = await stopUntilNotWritable(target, engine, MAX_STOP_PASSES);
    });
    if (stopped) {
      await this.#settleFenced(managedId);
      return;
    }
    await this.#escalate(target, member);
  }

  /** Stop passes left it writable: error log every tick, kill, unsafe flag. */
  async #escalate(
    target: GuardTarget,
    member: ManagedHaMemberRecord,
  ): Promise<void> {
    const reason =
      "demoted primary remained writable after compose stop and docker kill";
    const first = !this.#unsafeLogged.has(member.managedId);
    this.#unsafeLogged.add(member.managedId);
    logError(
      "managed",
      `demoted member guard: ${
        first ? reason : "still writable; killing again"
      } managedId=${member.managedId} member=${member.memberId}`,
    );
    await bestEffort(
      "kill",
      member.managedId,
      () => killDemotedEngine(target),
    );
    await bestEffort(
      "unsafe flag",
      member.managedId,
      () => markDemotedFenceUnsafe(this.#layout, member.managedId, reason),
    );
  }
}
