/**
 * Install this environment's cron timers, and remove the ones it no longer
 * declares.
 *
 * Same three-phase discipline as `native/apply-native-apps.ts`: render, install
 * **only** when the bytes differ, then one `daemon-reload` after every file is
 * on disk and before anything is enabled. A schedule that did not change must
 * not restart its timer, or a routine redeploy would reset every job's next
 * firing.
 *
 * **Removal is scoped to this environment.** Units carry the environment id in
 * their name, so the sweep can list what is installed for it and delete what
 * the payload no longer names — without that, a job removed from compose would
 * keep firing forever, which is the failure nobody notices until it does
 * something.
 */

import { join } from "@std/path";
import { logInfo, logWarn } from "../../logger.ts";
import type { LayoutPaths } from "../../paths/layout.ts";
import type { RunFn, RunResult } from "../ensure-principal.ts";
import { SYSTEMD_UNIT_DIR } from "../native/unit.ts";
import {
  CRON_UNIT_PREFIX,
  cronServiceContent,
  cronServicePath,
  cronTimerContent,
  cronTimerPath,
  cronUnitName,
} from "./unit.ts";
import type { EnvironmentDeployCronJob } from "../../instance/commands/contracts.ts";

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

const decoder = new TextDecoder();

async function runDefault(command: string, args: string[]): Promise<RunResult> {
  const result = await new Deno.Command(command, {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    success: result.success,
    stdout: decoder.decode(result.stdout).trim(),
    stderr: decoder.decode(result.stderr).trim(),
  };
}

function systemctl(runFn: RunFn, args: string[]): Promise<RunResult> {
  return runFn("sudo", ["-n", "systemctl", ...args]);
}

/** Install one root-owned unit file; returns whether the bytes moved. */
async function installUnit(
  runFn: RunFn,
  path: string,
  contents: string,
): Promise<boolean> {
  const staged = await Deno.makeTempFile({ prefix: "tp-cron-" });
  try {
    await Deno.writeTextFile(staged, contents, { mode: 0o600 });
    const same = await runFn("sudo", ["-n", "cmp", "-s", "--", staged, path]);
    if (same.success) return false;
    const install = await runFn("sudo", [
      "-n",
      "install",
      "-m",
      "0644",
      "-o",
      "root",
      "-g",
      "root",
      staged,
      path,
    ]);
    if (!install.success) {
      throw new Error(install.stderr || `Failed to install unit ${path}`);
    }
    return true;
  } finally {
    await Deno.remove(staged).catch(() => {});
  }
}

/**
 * Timer units currently installed for one environment.
 *
 * Listed off the filesystem rather than off `systemctl`: a unit whose file
 * exists but which was never enabled still has to be cleaned up, and
 * `list-units` would not show it.
 */
async function installedTimerNames(
  runFn: RunFn,
  unitDir: string,
  environmentId: string,
): Promise<string[]> {
  const listing = await runFn("sudo", ["-n", "ls", "-1", "--", unitDir]);
  if (!listing.success) return [];
  const prefix = `${CRON_UNIT_PREFIX}${environmentId}-`;
  return listing.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((name) => name.startsWith(prefix) && name.endsWith(".timer"))
    .map((name) => name.slice(0, -".timer".length));
}

async function removeUnit(
  runFn: RunFn,
  unitDir: string,
  unit: string,
): Promise<void> {
  // `disable --now` stops the timer as well as unlinking it from timers.target;
  // deleting the file first would leave a running timer systemd can no longer
  // describe.
  const disable = await systemctl(runFn, ["disable", "--now", `${unit}.timer`]);
  if (!disable.success) {
    logWarn(
      "deploy",
      `cron timer disable failed unit=${unit}: ${disable.stderr}`,
    );
  }
  for (const suffix of [".timer", ".service"]) {
    const rm = await runFn("sudo", [
      "-n",
      "rm",
      "-f",
      "--",
      join(unitDir, `${unit}${suffix}`),
    ]);
    if (!rm.success) {
      logWarn("deploy", `cron unit removal failed unit=${unit}: ${rm.stderr}`);
    }
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
  const runFn = opts.run ?? runDefault;
  const unitDir = opts.systemdUnitDir ?? SYSTEMD_UNIT_DIR;

  const desired = new Map<string, { changed: boolean }>();
  // Phase 1 — render and install every file. Nothing is reloaded or enabled
  // yet, so a failure here leaves the previous timers running unchanged.
  for (const spec of specs) {
    for (const job of spec.jobs) {
      const identity = {
        environmentId,
        composeServiceName: spec.composeServiceName,
        jobName: job.name,
      };
      const unit = cronUnitName(identity);
      const opts_ = {
        layout,
        environmentId,
        composeServiceName: spec.composeServiceName,
        job,
        username: spec.username,
        workingDirectory: spec.workingDirectory,
      };
      const serviceChanged = await installUnit(
        runFn,
        cronServicePath(identity, unitDir),
        cronServiceContent(opts_),
      );
      const timerChanged = await installUnit(
        runFn,
        cronTimerPath(identity, unitDir),
        cronTimerContent(opts_),
      );
      desired.set(unit, { changed: serviceChanged || timerChanged });
    }
  }

  const installed = await installedTimerNames(runFn, unitDir, environmentId);
  const stale = installed.filter((unit) => !desired.has(unit));
  for (const unit of stale) await removeUnit(runFn, unitDir, unit);

  const changed = [...desired]
    .filter(([, state]) => state.changed)
    .map(([unit]) => unit);

  // Phase 2 — one `daemon-reload`, after every file is on disk and before
  // anything is enabled, so systemd never reads a half-written set.
  if (changed.length > 0 || stale.length > 0) {
    const reload = await systemctl(runFn, ["daemon-reload"]);
    if (!reload.success) {
      throw new Error(reload.stderr || "systemctl daemon-reload failed");
    }
  }

  // Phase 3 — enable only what moved. A schedule that did not change keeps its
  // next firing; re-enabling every timer on every deploy would reset them all,
  // and a five-minute job would then never actually fire on a busy project.
  for (const unit of changed) {
    const enable = await systemctl(runFn, ["enable", "--now", `${unit}.timer`]);
    if (!enable.success) {
      throw new Error(enable.stderr || `Failed to enable timer ${unit}`);
    }
  }

  if (changed.length > 0 || stale.length > 0) {
    logInfo(
      "deploy",
      `cron applied env=${environmentId} changed=${
        changed.join(",") || "none"
      } removed=${stale.join(",") || "none"}`,
    );
  }
  return { changed, removed: stale };
}

/** Remove every cron unit belonging to an environment (teardown path). */
export async function removeCronJobs(
  environmentId: string,
  opts: CronApplyOpts = {},
): Promise<number> {
  const runFn = opts.run ?? runDefault;
  const unitDir = opts.systemdUnitDir ?? SYSTEMD_UNIT_DIR;
  const installed = await installedTimerNames(runFn, unitDir, environmentId);
  if (installed.length === 0) return 0;
  for (const unit of installed) await removeUnit(runFn, unitDir, unit);
  const reload = await systemctl(runFn, ["daemon-reload"]);
  if (!reload.success) {
    logWarn(
      "deploy",
      `systemctl daemon-reload after cron removal failed: ${reload.stderr}`,
    );
  }
  return installed.length;
}
