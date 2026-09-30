/**
 * Install a family of systemd timer units and remove the ones no longer
 * wanted — the machinery tenant cron (`./cron/apply.ts`) and scheduled
 * backups (`../backups/reconcile.ts`) share.
 *
 * Three-phase discipline: install every file **only** when its bytes differ,
 * then one `daemon-reload` after every file is on disk and before anything is
 * enabled, then `enable --now` only the units that moved. A schedule that did
 * not change must not restart its timer, or every apply would reset each
 * one's next firing.
 *
 * **Removal is prefix-scoped.** The caller names the prefix that is entirely
 * its own (one environment's cron units, or every backup unit); the sweep
 * lists `<prefix>*.timer` in the unit directory and removes what the desired
 * set no longer names. Units outside the prefix are never touched.
 */

import { join } from "@std/path";
import { hostSudoArgs } from "../permissions/host-sudo.ts";
import { logWarn } from "../util/logger.ts";
import { forEachSequential } from "../util/sequential.ts";
import type { RunFn, RunResult } from "./ensure-principal.ts";

/** One unit file to install as `root:root 0644`. */
export type UnitSetFile = { path: string; contents: string };

/** One timer unit (no extension) and the files that make it up. */
export type UnitSetMember = { unit: string; files: readonly UnitSetFile[] };

/** What distinguishes one unit family from another. */
export type UnitSetFamily = {
  /** Only `<prefix>*.timer` units in the unit directory are swept. */
  prefix: string;
  /** Word used in warnings (`<label> timer disable failed unit=…`). */
  label: string;
  /** Prefix for the staged temp file of each install. */
  tempPrefix: string;
  /** Logger scope for warnings. */
  logScope: string;
};

export type UnitSetResult = {
  /** Units whose bytes changed and which were (re-)enabled. */
  changed: string[];
  /** Units removed because the desired set no longer names them. */
  removed: string[];
};

const decoder = new TextDecoder();

/** Run a host command directly (the default for {@link RunFn}). */
export async function runHostCommand(
  command: string,
  args: string[],
): Promise<RunResult> {
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
  return runFn("sudo", hostSudoArgs(["-n", "systemctl", ...args]));
}

/** Install one root-owned unit file; returns whether the bytes moved. */
async function installUnit(
  runFn: RunFn,
  path: string,
  contents: string,
  tempPrefix: string,
): Promise<boolean> {
  const staged = await Deno.makeTempFile({ prefix: tempPrefix });
  try {
    await Deno.writeTextFile(staged, contents, { mode: 0o600 });
    const same = await runFn(
      "sudo",
      hostSudoArgs(["-n", "cmp", "-s", "--", staged, path]),
    );
    if (same.success) return false;
    const install = await runFn(
      "sudo",
      hostSudoArgs([
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
      ]),
    );
    if (!install.success) {
      throw new Error(install.stderr || `Failed to install unit ${path}`);
    }
    return true;
  } finally {
    await Deno.remove(staged).catch(() => {});
  }
}

/**
 * Timer units (no extension) currently installed under `prefix`.
 *
 * Listed off the filesystem rather than off `systemctl`: a unit whose file
 * exists but which was never enabled still has to be cleaned up, and
 * `list-units` would not show it.
 */
export async function installedTimerUnits(
  runFn: RunFn,
  unitDir: string,
  prefix: string,
): Promise<string[]> {
  const listing = await runFn(
    "sudo",
    hostSudoArgs(["-n", "ls", "-1", "--", unitDir]),
  );
  if (!listing.success) return [];
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
  family: UnitSetFamily,
): Promise<void> {
  // `disable --now` stops the timer as well as unlinking it from timers.target;
  // deleting the file first would leave a running timer systemd can no longer
  // describe.
  const disable = await systemctl(runFn, ["disable", "--now", `${unit}.timer`]);
  if (!disable.success) {
    logWarn(
      family.logScope,
      `${family.label} timer disable failed unit=${unit}: ${disable.stderr}`,
    );
  }
  await forEachSequential([".timer", ".service"], async (suffix) => {
    const rm = await runFn(
      "sudo",
      hostSudoArgs([
        "-n",
        "rm",
        "-f",
        "--",
        join(unitDir, `${unit}${suffix}`),
      ]),
    );
    if (!rm.success) {
      logWarn(
        family.logScope,
        `${family.label} unit removal failed unit=${unit}: ${rm.stderr}`,
      );
    }
  });
}

/**
 * Reconcile one unit family to `members`, the **complete** desired set under
 * `family.prefix`: a unit absent from it is removed.
 */
export async function applyUnitSet(
  members: readonly UnitSetMember[],
  family: UnitSetFamily,
  runFn: RunFn,
  unitDir: string,
): Promise<UnitSetResult> {
  const desired = new Map<string, { changed: boolean }>();
  // Phase 1 — install every file. Nothing is reloaded or enabled yet, so a
  // failure here leaves the previous timers running unchanged.
  await forEachSequential(members, async (member) => {
    let changed = false;
    await forEachSequential(member.files, async (file) => {
      if (
        await installUnit(runFn, file.path, file.contents, family.tempPrefix)
      ) {
        changed = true;
      }
    });
    desired.set(member.unit, { changed });
  });

  const installed = await installedTimerUnits(runFn, unitDir, family.prefix);
  const stale = installed.filter((unit) => !desired.has(unit));
  await forEachSequential(
    stale,
    (unit) => removeUnit(runFn, unitDir, unit, family),
  );

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

  // Phase 3 — enable only what moved. Re-enabling an unchanged timer would
  // reset its next firing.
  await forEachSequential(changed, async (unit) => {
    const enable = await systemctl(runFn, ["enable", "--now", `${unit}.timer`]);
    if (!enable.success) {
      throw new Error(enable.stderr || `Failed to enable timer ${unit}`);
    }
  });

  return { changed, removed: stale };
}

/** Remove every unit under `family.prefix` (teardown); returns how many. */
export async function removeUnitSet(
  family: UnitSetFamily,
  runFn: RunFn,
  unitDir: string,
): Promise<number> {
  const installed = await installedTimerUnits(runFn, unitDir, family.prefix);
  if (installed.length === 0) return 0;
  await forEachSequential(
    installed,
    (unit) => removeUnit(runFn, unitDir, unit, family),
  );
  const reload = await systemctl(runFn, ["daemon-reload"]);
  if (!reload.success) {
    logWarn(
      family.logScope,
      `systemctl daemon-reload after ${family.label} removal failed: ${reload.stderr}`,
    );
  }
  return installed.length;
}
