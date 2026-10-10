/**
 * Periodic stop of a fenced (demoted) member whose engine was started by
 * hand. Never starts anything, never deletes data, never touches a member
 * without a demoted marker.
 */

import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { logError, logWarn, sanitizeForLog } from "../util/logger.ts";
import { forEachSequential } from "../util/sequential.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { collectManagedContainers } from "./containers.ts";
import {
  isManagedMemberDemoted,
  listDemotedFenceTargets,
} from "./demoted-marker.ts";
import {
  enforceFencedMemberIfRunning,
  isFencedMemberStillWritable,
} from "./fenced-member-enforce.ts";
import { managedComposeProject } from "./engine-paths.ts";
import { isManagedMemberDestroyed } from "./destroyed-marker.ts";
import { recordManagedIntent } from "./ha-intent.ts";
import type { ManagedHaMemberRecord } from "./ha-member.ts";
import { tryWithManagedLifecycleLock } from "./target-lock.ts";

export const DEMOTED_GUARD_INTERVAL_MS = 5_000;

const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";
const SAFE_CONTAINER_ID_RE = /^[a-f0-9]{12,64}$/i;

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

async function forceStopComposeProjectContainers(
  run: DockerRunFn,
  project: string,
): Promise<void> {
  const ids = await listComposeProjectContainerIds(run, project);
  if (ids === null || ids.length === 0) return;
  const stopped = await run(["stop", ...ids]);
  if (stopped.success) return;
  await run(["kill", ...ids]);
}

export type DockerRunFn = (args: string[]) => Promise<DockerCliResult>;

export type DemotedMemberGuardDeps = {
  layout: LayoutPaths;
  run: DockerRunFn;
  listMembers?: () => Promise<ManagedHaMemberRecord[]>;
  intervalMs?: number;
};

type EngineRunningState = "running" | "stopped" | "unknown";

async function engineRunningState(
  run: DockerRunFn,
  managedId: string,
): Promise<EngineRunningState> {
  const containers = await collectManagedContainers(
    managedComposeProject(managedId),
    (text) => sanitizeForLog(text),
    run,
  );
  if (!containers) return "unknown";
  return containers.some((row) => row.status.toLowerCase() === "running")
    ? "running"
    : "stopped";
}

async function stopWritableDemotedEngine(
  layout: LayoutPaths,
  member: ManagedHaMemberRecord,
  run: DockerRunFn,
  warned: Set<string>,
): Promise<void> {
  await enforceFencedMemberIfRunning(
    layout,
    member.managedId,
    member.engine,
    run,
  );
  const stillWritable = await isFencedMemberStillWritable(
    layout,
    member.managedId,
    member.engine,
    run,
  );
  if (!stillWritable) {
    warned.delete(member.managedId);
    return;
  }
  await recordManagedIntent(layout.stateDir, member.managedId, "stop", {
    mode: "held",
  });
  if (!warned.has(member.managedId)) {
    logWarn(
      "managed",
      `demoted member is running; stopping it managedId=${member.managedId} member=${member.memberId}`,
    );
    warned.add(member.managedId);
  }
  await stopDemotedEngine(run, member.managedId);
  const stillWritableAfterStop = await isFencedMemberStillWritable(
    layout,
    member.managedId,
    member.engine,
    run,
  );
  if (stillWritableAfterStop) {
    logError(
      "managed",
      `demoted member guard: engine still writable after stop managedId=${member.managedId} member=${member.memberId}`,
    );
  }
}

async function stopDemotedEngine(
  run: DockerRunFn,
  managedId: string,
): Promise<void> {
  const project = managedComposeProject(managedId);
  const result = await run(["compose", "-p", project, "stop"]);
  if (!result.success) {
    logError(
      "managed",
      `demoted member guard: compose stop failed managedId=${managedId}:`,
      sanitizeForLog(result.stderr || result.stdout),
    );
  }
  await forceStopComposeProjectContainers(run, project);
}

export class DemotedMemberGuard {
  #timer: ReturnType<typeof setInterval> | undefined;
  #ticking = false;
  readonly #warned = new Set<string>();
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
      await forEachSequential(members, (member) => this.#fenceOne(member));
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
    if (
      !(await isManagedMemberDemoted(
        this.#layout,
        member.managedId,
        memberId,
      ))
    ) {
      this.#warned.delete(member.managedId);
      return;
    }
    const acquired = await tryWithManagedLifecycleLock(
      this.#layout,
      member.managedId,
      () => this.#checkAndStop(member),
    );
    if (!acquired) return;
  }

  async #checkAndStop(member: ManagedHaMemberRecord): Promise<void> {
    const memberId = member.memberId.length > 0 ? member.memberId : undefined;
    if (
      !(await isManagedMemberDemoted(
        this.#layout,
        member.managedId,
        memberId,
      ))
    ) {
      this.#warned.delete(member.managedId);
      return;
    }
    const running = await engineRunningState(this.#run, member.managedId);
    if (running === "stopped") {
      const stillWritable = await isFencedMemberStillWritable(
        this.#layout,
        member.managedId,
        member.engine,
        this.#run,
      );
      if (!stillWritable) {
        this.#warned.delete(member.managedId);
        return;
      }
    }
    if (running === "unknown") {
      logWarn(
        "managed",
        `demoted member guard: compose ps failed; treating engine as possibly running managedId=${member.managedId}`,
      );
    }
    await stopWritableDemotedEngine(
      this.#layout,
      member,
      this.#run,
      this.#warned,
    );
  }
}
