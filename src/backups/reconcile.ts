/**
 * `server.backups.reconcile`: make this host's backup timers match the
 * complete policy set the control plane sent.
 *
 * Order matters. The policies file is written first, so a timer installed
 * below can never fire into a file that does not list its policy yet (a timer
 * about to be removed that fires in between finds its policy gone and runs
 * nothing). Then the unit family is applied through the same three-phase
 * discipline as tenant cron: install only what changed, one daemon-reload,
 * enable only what moved, and remove every `turbopanel-backup-*` timer the set
 * no longer names — disabled policies included. An unchanged set touches
 * nothing: the file is left as is and no unit is rewritten or restarted.
 *
 * When any enabled policy backs up a storage copy, the pinned helper image the
 * archive runs in is pulled here (only if it is missing), because a scheduled
 * run never pulls. A pull failure is a warning, not an error: the timers are
 * in place and the run reports the missing image itself.
 */

import {
  type BackupPolicyNextRun,
  type BackupPolicyWireEntry,
  type BackupsReconcilePayload,
  type BackupsReconcileResult,
  parseBackupsReconcilePayload,
} from "../contracts/commands-contracts.ts";
import { type LayoutPaths, resolveLayout } from "../paths/layout.ts";
import type { RunFn } from "../deploy/ensure-principal.ts";
import { SYSTEMD_UNIT_DIR } from "../deploy/native/unit.ts";
import {
  applyUnitSet,
  runHostCommand,
  type UnitSetFamily,
  type UnitSetMember,
} from "../deploy/systemd-unit-set.ts";
import { logInfo } from "../util/logger.ts";
import { mapSequential } from "../util/sequential.ts";
import {
  readBackupPoliciesFile,
  writeBackupPoliciesFile,
} from "./policies-file.ts";
import { ensureCopyBackupImage } from "./copy-backup.ts";
import {
  BACKUP_UNIT_PREFIX,
  backupServiceContent,
  backupServicePath,
  backupTimerContent,
  backupTimerPath,
  backupUnitName,
} from "./units.ts";
import { parseTimerNextRun, timerNextRunArgs } from "./timer-next-run.ts";

export type BackupsReconcileDeps = {
  resolveLayout?: () => LayoutPaths;
  /** Host command runner (sudo through tp-host, and the unprivileged `systemctl show`). */
  run?: RunFn;
  systemdUnitDir?: string;
  now?: () => Date;
  /** Pull the storage-copy helper image when missing; an error string on failure. */
  ensureHelperImage?: () => Promise<string | undefined>;
};

const BACKUP_UNIT_FAMILY: UnitSetFamily = {
  prefix: BACKUP_UNIT_PREFIX,
  label: "backup",
  tempPrefix: "tp-backup-",
  logScope: "backups",
};

function backupMembers(
  layout: LayoutPaths,
  policies: readonly BackupPolicyWireEntry[],
  unitDir: string,
): UnitSetMember[] {
  return policies
    .filter((policy) => policy.enabled)
    .map((policy) => ({
      unit: backupUnitName(policy.policyId),
      files: [
        {
          path: backupServicePath(policy.policyId, unitDir),
          contents: backupServiceContent(layout, policy.policyId),
        },
        {
          path: backupTimerPath(policy.policyId, unitDir),
          contents: backupTimerContent(policy.policyId, policy.onCalendar),
        },
      ],
    }));
}

function policyIdOfUnit(unit: string): string {
  return unit.slice(BACKUP_UNIT_PREFIX.length);
}

/** Rewrite the policies file only when the set differs from what is on disk. */
async function writePoliciesIfChanged(
  layout: LayoutPaths,
  payload: BackupsReconcilePayload,
  now: () => Date,
): Promise<boolean> {
  let current: BackupPolicyWireEntry[] | undefined;
  try {
    current = await readBackupPoliciesFile(layout);
  } catch {
    // A malformed file is replaced, never trusted.
    current = undefined;
  }
  if (
    current !== undefined &&
    JSON.stringify(current) === JSON.stringify(payload.policies)
  ) {
    return false;
  }
  await writeBackupPoliciesFile(layout, payload, now);
  return true;
}

/**
 * When a policy's timer next fires, read from systemd without sudo (a read-only
 * query). `undefined` when nothing is scheduled; a string warning on failure.
 */
async function readNextRun(
  runFn: RunFn,
  policyId: string,
): Promise<{ nextRunAt?: string; warning?: string }> {
  const timer = `${backupUnitName(policyId)}.timer`;
  const show = await runFn("systemctl", timerNextRunArgs(timer));
  if (!show.success) {
    return { warning: `next run unknown for ${timer}: ${show.stderr}` };
  }
  const nextRunAt = parseTimerNextRun(show.stdout, timer);
  return nextRunAt ? { nextRunAt } : {};
}

export async function handleBackupsReconcile(
  payload: BackupsReconcilePayload,
  _daemonReceivedAt: string,
  deps: BackupsReconcileDeps = {},
): Promise<BackupsReconcileResult> {
  const parsed = parseBackupsReconcilePayload(payload);
  const layout = (deps.resolveLayout ?? resolveLayout)();
  const runFn = deps.run ?? runHostCommand;
  const unitDir = deps.systemdUnitDir ?? SYSTEMD_UNIT_DIR;

  await writePoliciesIfChanged(
    layout,
    parsed,
    deps.now ?? (() => new Date()),
  );
  const { changed, removed } = await applyUnitSet(
    backupMembers(layout, parsed.policies, unitDir),
    BACKUP_UNIT_FAMILY,
    runFn,
    unitDir,
  );

  const enabled = parsed.policies.filter((policy) => policy.enabled);
  const warnings: string[] = [];
  if (enabled.some((policy) => policy.targetKind === "copy")) {
    const ensureHelperImage = deps.ensureHelperImage ??
      (() => ensureCopyBackupImage());
    const imageIssue = await ensureHelperImage();
    if (imageIssue) warnings.push(imageIssue);
  }
  const nextRuns = await mapSequential(
    enabled,
    async (policy): Promise<BackupPolicyNextRun> => {
      const next = await readNextRun(runFn, policy.policyId);
      if (next.warning) warnings.push(next.warning);
      const entry: BackupPolicyNextRun = { policyId: policy.policyId };
      if (next.nextRunAt) entry.nextRunAt = next.nextRunAt;
      return entry;
    },
  );

  const unitsChanged = changed.map(policyIdOfUnit);
  const unitsRemoved = removed.map(policyIdOfUnit);
  if (unitsChanged.length > 0 || unitsRemoved.length > 0) {
    logInfo(
      "backups",
      `backup timers applied changed=${
        unitsChanged.join(",") || "none"
      } removed=${unitsRemoved.join(",") || "none"}`,
    );
  }
  return {
    policiesApplied: enabled.length,
    unitsChanged,
    unitsRemoved,
    nextRuns,
    warnings,
  };
}
