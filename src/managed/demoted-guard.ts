/**
 * Periodic stop of a fenced (demoted) member whose engine was started by
 * hand. Never starts anything, never deletes data, never touches a member
 * without a demoted marker.
 */

import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { logWarn, sanitizeForLog } from "../util/logger.ts";
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
import { recordManagedIntent } from "./ha-intent.ts";
import type { ManagedHaMemberRecord } from "./ha-member.ts";
import { tryWithManagedLifecycleLock } from "./target-lock.ts";

export const DEMOTED_GUARD_INTERVAL_MS = 5_000;

export type DockerRunFn = (args: string[]) => Promise<DockerCliResult>;

export type DemotedMemberGuardDeps = {
  layout: LayoutPaths;
  run: DockerRunFn;
  listMembers?: () => Promise<ManagedHaMemberRecord[]>;
  intervalMs?: number;
};

async function engineIsRunning(
  run: DockerRunFn,
  managedId: string,
): Promise<boolean> {
  const containers = await collectManagedContainers(
    managedComposeProject(managedId),
    (text) => sanitizeForLog(text),
    run,
  );
  if (!containers) return false;
  return containers.some((row) => row.status.toLowerCase() === "running");
}

async function stopDemotedEngine(
  run: DockerRunFn,
  managedId: string,
): Promise<void> {
  const result = await run([
    "compose",
    "-p",
    managedComposeProject(managedId),
    "stop",
  ]);
  if (!result.success) {
    logWarn(
      "managed",
      `demoted member guard: compose stop failed managedId=${managedId}:`,
      sanitizeForLog(result.stderr || result.stdout),
    );
  }
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
        return targets.map((target) => ({
          managedId: target.managedId,
          memberId: target.memberId ?? "",
          engine: target.engine ?? "postgres",
          role: "primary" as const,
          containerName: "",
          replicaPeerCount: 0,
          updatedAt: "",
        }));
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
    if (
      !(await isManagedMemberDemoted(
        this.#layout,
        member.managedId,
        member.memberId,
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
    if (
      !(await isManagedMemberDemoted(
        this.#layout,
        member.managedId,
        member.memberId,
      ))
    ) {
      this.#warned.delete(member.managedId);
      return;
    }
    if (!(await engineIsRunning(this.#run, member.managedId))) {
      this.#warned.delete(member.managedId);
      return;
    }
    await enforceFencedMemberIfRunning(
      this.#layout,
      member.managedId,
      member.engine,
      this.#run,
    );
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
    await recordManagedIntent(this.#layout.stateDir, member.managedId, "stop", {
      mode: "held",
    });
    if (!this.#warned.has(member.managedId)) {
      logWarn(
        "managed",
        `demoted member is running; stopping it managedId=${member.managedId} member=${member.memberId}`,
      );
      this.#warned.add(member.managedId);
    }
    await stopDemotedEngine(this.#run, member.managedId);
  }
}
