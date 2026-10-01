/**
 * One scheduled backup run: `turbopaneld backup-run <policyId>`, started by
 * the policy's systemd timer through `<install>/lib/tp-backup-run`. It runs
 * in its own process, never takes the daemon's `daemon.lock`, and never talks
 * to the control plane: the policy comes from the host's policies file, and
 * the outcome goes to the result spool for the long-running daemon to report.
 *
 * Outcomes:
 * - `invalid-policy-id` / `no-policy`: nothing is run and no result is
 *   written (a policy the host does not hold is one the control plane will
 *   not accept a report for).
 * - `ran`: a result file was written, `succeeded` or `failed` (a busy engine
 *   or copy, low disk, a missing volume or helper image, a dump or archive
 *   error).
 *
 * A `managed` policy dumps its engine (`../managed/backup.ts`); a `copy`
 * policy archives the storage copy live through the pinned helper container
 * (`./copy-backup.ts`), with `--pull never`: the image arrives when the policy
 * set is applied, never while a timer fires.
 */

import {
  type BackupPolicyWireEntry,
  COPY_BACKUP_ARTIFACT_EXTENSION,
  type CopyBackupSource,
} from "../contracts/commands-contracts.ts";
import { type LayoutPaths, resolveLayout } from "../paths/layout.ts";
import {
  createManagedBackupArtifact,
  listBackupArtifacts,
  type ManagedBackupArtifactDeps,
  resolveBackupEngine,
} from "../managed/backup.ts";
import { managedBackupArtifactDir } from "../managed/engine-paths.ts";
import {
  withCopyTargetLock,
  withManagedTargetLock,
} from "../managed/target-lock.ts";
import {
  copyBackupArtifactDir,
  type CopyBackupDeps,
  createCopyBackupArtifact,
} from "./copy-backup.ts";
import { sanitizeForLog } from "../util/logger.ts";
import { backupPoliciesPath, readBackupPoliciesFile } from "./policies-file.ts";
import { freeBytesAtNearestDir } from "./free-space.ts";
import {
  type BackupRunResult,
  capResultError,
  mintRunId,
  writeBackupRunResult,
} from "./result-spool.ts";

/** A policy id as it appears in a unit name: a lower-case UUID. */
const POLICY_ID_RE =
  /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;

/** Never start a dump with less than this free, however small the last one was. */
export const MIN_FREE_BYTES = 256 * 1024 * 1024;

export type ScheduledBackupDeps = {
  layout?: LayoutPaths;
  now?: () => Date;
  /** Free bytes on the filesystem holding `path`. */
  freeBytes?: (path: string) => Promise<number>;
  /** Engine access and dump streaming; defaults reach Docker. */
  artifact?: ManagedBackupArtifactDeps;
  /** Volume checks and the helper archive stream for copy targets; defaults reach Docker. */
  copy?: CopyBackupDeps;
};

export type ScheduledBackupOutcome =
  | { kind: "invalid-policy-id"; message: string }
  | { kind: "no-policy"; message: string }
  | { kind: "ran"; result: BackupRunResult; resultPath: string };

/** `bk_<32 hex>`, the id format the control plane mints for manual backups. */
function mintBackupId(): string {
  return `bk_${crypto.randomUUID().replaceAll("-", "")}`;
}

async function findPolicy(
  layout: LayoutPaths,
  policyId: string,
): Promise<BackupPolicyWireEntry | string> {
  let policies: BackupPolicyWireEntry[];
  try {
    policies = await readBackupPoliciesFile(layout);
  } catch (err) {
    return `backup policies file ${backupPoliciesPath(layout)} is unreadable: ${
      sanitizeForLog(err)
    }`;
  }
  const entry = policies.find((policy) => policy.policyId === policyId);
  if (!entry) {
    return `policy ${policyId} is not in ${backupPoliciesPath(layout)}`;
  }
  if (!entry.enabled) return `policy ${policyId} is disabled`;
  return entry;
}

/** The newest artifact's size in the policy's own directory; 0 before the first run. */
async function lastArtifactSize(dir: string, ext: string): Promise<number> {
  const entries = await listBackupArtifacts(dir, ext);
  let newest: { mtimeMs: number; sizeBytes: number } | undefined;
  for (const entry of entries) {
    if (!newest || entry.mtimeMs > newest.mtimeMs) newest = entry;
  }
  return newest?.sizeBytes ?? 0;
}

async function assertFreeSpace(
  dir: string,
  ext: string,
  freeBytes: (path: string) => Promise<number>,
): Promise<void> {
  const required = Math.max(
    2 * (await lastArtifactSize(dir, ext)),
    MIN_FREE_BYTES,
  );
  const free = await freeBytes(dir);
  if (free < required) {
    throw new Error(
      `not enough free space for ${dir}: ${free} bytes free, ${required} required`,
    );
  }
}

type ScheduledArtifact = {
  backupId: string;
  path: string;
  sizeBytes: number;
  checksum: string;
  pruned: string[];
};

function backUpManagedTarget(
  layout: LayoutPaths,
  entry: BackupPolicyWireEntry,
  deps: ScheduledBackupDeps,
): Promise<ScheduledArtifact> {
  if (!entry.managedId || !entry.engine || !entry.artifactExtension) {
    throw new Error("the managed policy entry is incomplete");
  }
  const managedId = entry.managedId;
  const artifactExtension = entry.artifactExtension;
  const engine = resolveBackupEngine(
    entry.engine,
    artifactExtension,
    "backup-run",
  );
  const dir = managedBackupArtifactDir(layout, managedId, entry.policyId);
  const backupId = mintBackupId();
  return withManagedTargetLock(layout, managedId, async () => {
    await assertFreeSpace(
      dir,
      artifactExtension,
      deps.freeBytes ?? freeBytesAtNearestDir,
    );
    const artifact = await createManagedBackupArtifact(
      layout,
      engine,
      {
        managedId,
        backupId,
        artifactExtension,
        retentionKeep: entry.retentionKeep,
        policyId: entry.policyId,
      },
      deps.artifact,
    );
    return { ...artifact, backupId };
  });
}

/** The copy-source fields of a (validated) `copy` policy entry. */
function copySourceOf(entry: BackupPolicyWireEntry): CopyBackupSource {
  if (!entry.copyId || !entry.copyProvider) {
    throw new Error("the copy policy entry is incomplete");
  }
  const source: CopyBackupSource = {
    copyId: entry.copyId,
    copyProvider: entry.copyProvider,
  };
  if (entry.volumeName) source.volumeName = entry.volumeName;
  if (entry.hostPath) source.hostPath = entry.hostPath;
  if (entry.organizationId) source.organizationId = entry.organizationId;
  if (entry.storageId) source.storageId = entry.storageId;
  return source;
}

function backUpCopyTarget(
  layout: LayoutPaths,
  entry: BackupPolicyWireEntry,
  deps: ScheduledBackupDeps,
): Promise<ScheduledArtifact> {
  const source = copySourceOf(entry);
  const dir = copyBackupArtifactDir(layout, source.copyId, entry.policyId);
  const backupId = mintBackupId();
  return withCopyTargetLock(layout, source.copyId, async () => {
    await assertFreeSpace(
      dir,
      COPY_BACKUP_ARTIFACT_EXTENSION,
      deps.freeBytes ?? freeBytesAtNearestDir,
    );
    const artifact = await createCopyBackupArtifact(
      layout,
      {
        source,
        backupId,
        retentionKeep: entry.retentionKeep,
        policyId: entry.policyId,
      },
      deps.copy,
    );
    return { ...artifact, backupId };
  });
}

function backUpTarget(
  layout: LayoutPaths,
  entry: BackupPolicyWireEntry,
  deps: ScheduledBackupDeps,
): Promise<ScheduledArtifact> {
  return entry.targetKind === "copy"
    ? backUpCopyTarget(layout, entry, deps)
    : backUpManagedTarget(layout, entry, deps);
}

async function runPolicy(
  layout: LayoutPaths,
  entry: BackupPolicyWireEntry,
  deps: ScheduledBackupDeps,
): Promise<BackupRunResult> {
  const now = deps.now ?? (() => new Date());
  const base = {
    policyId: entry.policyId,
    runId: mintRunId(),
    startedAt: now().toISOString(),
  };
  try {
    const artifact = await backUpTarget(layout, entry, deps);
    const result: BackupRunResult = {
      ...base,
      finishedAt: now().toISOString(),
      status: "succeeded",
      backupId: artifact.backupId,
      sizeBytes: artifact.sizeBytes,
      checksum: artifact.checksum,
      path: artifact.path,
    };
    if (artifact.pruned.length > 0) result.pruned = artifact.pruned;
    return result;
  } catch (err) {
    return {
      ...base,
      finishedAt: now().toISOString(),
      status: "failed",
      error: capResultError(sanitizeForLog(err)),
    };
  }
}

/** Run one scheduled backup for `policyId`; see the module doc for outcomes. */
export async function runScheduledBackup(
  policyId: string,
  deps: ScheduledBackupDeps = {},
): Promise<ScheduledBackupOutcome> {
  if (!POLICY_ID_RE.test(policyId)) {
    return {
      kind: "invalid-policy-id",
      message: "policy id must be a lower-case UUID",
    };
  }
  const layout = deps.layout ?? resolveLayout(Deno.env.toObject());
  const policy = await findPolicy(layout, policyId);
  if (typeof policy === "string") return { kind: "no-policy", message: policy };

  const result = await runPolicy(layout, policy, deps);
  const resultPath = await writeBackupRunResult(layout, result);
  return { kind: "ran", result, resultPath };
}
