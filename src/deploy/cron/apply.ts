/**
 * Install this environment's cron timers, and remove the ones it no longer
 * declares.
 *
 * The three-phase apply lives in `../systemd-unit-set.ts`, shared with
 * scheduled backups: render, install **only** when the bytes differ, then one
 * `daemon-reload` after every file is on disk and before anything is enabled.
 * A schedule that did not change must not restart its timer, or a routine
 * redeploy would reset every job's next firing.
 *
 * **Removal is scoped to this environment.** Units carry the environment id in
 * their name, so the sweep can list what is installed for it and delete what
 * the payload no longer names — without that, a job removed from compose would
 * keep firing forever, which is the failure nobody notices until it does
 * something.
 */

import { logInfo } from "../../util/logger.ts";
import type { LayoutPaths } from "../../paths/layout.ts";
import type { RunFn } from "../ensure-principal.ts";
import { SYSTEMD_UNIT_DIR } from "../native/unit.ts";
import {
  applyUnitSet,
  removeUnitSet,
  runHostCommand,
  type UnitSetFamily,
  type UnitSetMember,
} from "../systemd-unit-set.ts";
import {
  CRON_UNIT_PREFIX,
  cronServiceContent,
  cronServicePath,
  cronTimerContent,
  cronTimerPath,
  cronUnitName,
} from "./unit.ts";
import type { EnvironmentDeployCronJob } from "../../contracts/commands-contracts.ts";

/** One service's jobs, with the account and tree they run as and in. */
export type CronApplySpec = {
  composeServiceName: string;
  username: string;
  workingDirectory: string;
  jobs: readonly EnvironmentDeployCronJob[];
};

export type CronApplyOpts = {
  run?: RunFn;
  systemdUnitDir?: string;
};

export type CronApplyResult = {
  /** Units whose bytes changed and which were re-enabled. */
  changed: string[];
  /** Units removed because the payload no longer declares them. */
  removed: string[];
};

/** One environment's cron units: `turbopanel-cron-<environmentId>-*`. */
function cronFamily(environmentId: string): UnitSetFamily {
  return {
    prefix: `${CRON_UNIT_PREFIX}${environmentId}-`,
    label: "cron",
    tempPrefix: "tp-cron-",
    logScope: "deploy",
  };
}

function cronMembers(
  layout: LayoutPaths,
  environmentId: string,
  specs: readonly CronApplySpec[],
  unitDir: string,
): UnitSetMember[] {
  const members: UnitSetMember[] = [];
  forEachSpecJob(specs, (spec, job) => {
    const identity = {
      environmentId,
      composeServiceName: spec.composeServiceName,
      jobName: job.name,
    };
    const opts = {
      layout,
      environmentId,
      composeServiceName: spec.composeServiceName,
      job,
      username: spec.username,
      workingDirectory: spec.workingDirectory,
    };
    members.push({
      unit: cronUnitName(identity),
      files: [
        {
          path: cronServicePath(identity, unitDir),
          contents: cronServiceContent(opts),
        },
        {
          path: cronTimerPath(identity, unitDir),
          contents: cronTimerContent(opts),
        },
      ],
    });
  });
  return members;
}

function forEachSpecJob(
  specs: readonly CronApplySpec[],
  fn: (spec: CronApplySpec, job: EnvironmentDeployCronJob) => void,
): void {
  for (const spec of specs) {
    for (const job of spec.jobs) fn(spec, job);
  }
}

/**
 * Reconcile cron for one environment.
 *
 * `specs` is the **complete** set for this environment — a job absent from it
 * is one the operator removed, and its timer goes. Scoping by environment is
 * what makes that safe on a host serving many.
 */
export async function applyCronJobs(
  layout: LayoutPaths,
  environmentId: string,
  specs: readonly CronApplySpec[],
  opts: CronApplyOpts = {},
): Promise<CronApplyResult> {
  const runFn = opts.run ?? runHostCommand;
  const unitDir = opts.systemdUnitDir ?? SYSTEMD_UNIT_DIR;
  const { changed, removed } = await applyUnitSet(
    cronMembers(layout, environmentId, specs, unitDir),
    cronFamily(environmentId),
    runFn,
    unitDir,
  );
  if (changed.length > 0 || removed.length > 0) {
    logInfo(
      "deploy",
      `cron applied env=${environmentId} changed=${
        changed.join(",") || "none"
      } removed=${removed.join(",") || "none"}`,
    );
  }
  return { changed, removed };
}

/** Remove every cron unit belonging to an environment (teardown path). */
export function removeCronJobs(
  environmentId: string,
  opts: CronApplyOpts = {},
): Promise<number> {
  return removeUnitSet(
    cronFamily(environmentId),
    opts.run ?? runHostCommand,
    opts.systemdUnitDir ?? SYSTEMD_UNIT_DIR,
  );
}
