/**
 * The S3 copy queue, on disk under `<daemonStateDir>/backup/copies/`:
 *
 * - `queue/<jobId>.json`: a backup waiting to be copied (or waiting for a retry).
 * - `uploads/<jobId>.json`: multipart progress, so a restart continues.
 * - `reports/<jobId>.json`: how a copy ended; sent to the control plane as a
 *   `backup-copy-report` and deleted when it acks.
 *
 * The one-shot scheduled runner has no network permission, so it only writes a
 * job here (it may write under `<daemonStateDir>/backup`); the long-running
 * daemon copies. Files are written to a dot-prefixed name and renamed into
 * place; readers skip dot names. Job files hold the target with its secret
 * still sealed to this host's daemon key.
 */

import { join } from "@std/path";
import { encodeHex } from "@std/encoding/hex";
import {
  type BackupCopyTargetWire,
  parseBackupCopyTarget,
} from "../contracts/commands-contracts.ts";
import type { BackupCopyReportMessage } from "../contracts/cell-messages.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { backupStateDir } from "./policies-file.ts";

type StateLayout = Pick<LayoutPaths, "daemonStateDir">;

export type CopyJob = {
  version: 1;
  jobId: string;
  target: BackupCopyTargetWire;
  managedId: string;
  backupId: string;
  policyId?: string;
  artifactExtension: string;
  sha256: string;
  sizeBytes: number;
  /** A scheduled backup's keep count; absent for a manual backup (never pruned). */
  retentionKeep?: number;
  createdAt: string;
  attempts: number;
  /** ISO time before which the job is not tried again. */
  nextAttemptAt?: string;
  lastError?: string;
};

export type CopyReport = Omit<BackupCopyReportMessage, "type" | "id" | "at">;

type StoredReport = CopyReport & { version: 1 };

export function copiesDir(layout: StateLayout): string {
  return join(backupStateDir(layout), "copies");
}
export const copyQueueDir = (l: StateLayout) => join(copiesDir(l), "queue");
export const copyUploadsDir = (l: StateLayout) => join(copiesDir(l), "uploads");
export const copyReportsDir = (l: StateLayout) => join(copiesDir(l), "reports");

const JOB_FILE_RE = /^([0-9a-f]{32})\.json$/;

/** A stable, short, filename-safe id for one backup of one engine. */
export async function copyJobId(
  managedId: string,
  backupId: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${managedId}/${backupId}`),
  );
  return encodeHex(new Uint8Array(digest)).slice(0, 32);
}

async function writeAtomic(dir: string, name: string, value: unknown) {
  await Deno.mkdir(dir, { recursive: true, mode: 0o750 });
  const tmp = join(dir, `.${name}.tmp`);
  await Deno.writeTextFile(tmp, JSON.stringify(value), { mode: 0o640 });
  await Deno.rename(tmp, join(dir, name));
}

export type EnqueueInput = Omit<
  CopyJob,
  "version" | "jobId" | "createdAt" | "attempts"
>;

/** Queue a copy. A second call for the same backup keeps the first job. */
export async function enqueueCopyJob(
  layout: StateLayout,
  input: EnqueueInput,
  now: () => Date = () => new Date(),
): Promise<string> {
  const jobId = await copyJobId(input.managedId, input.backupId);
  const path = join(copyQueueDir(layout), `${jobId}.json`);
  try {
    await Deno.stat(path);
    return jobId;
  } catch { /* not queued yet */ }
  const job: CopyJob = {
    ...input,
    version: 1,
    jobId,
    createdAt: now().toISOString(),
    attempts: 0,
  };
  await writeAtomic(copyQueueDir(layout), `${jobId}.json`, job);
  notifyCopyQueued();
  return jobId;
}

export async function saveCopyJob(layout: StateLayout, job: CopyJob) {
  await writeAtomic(copyQueueDir(layout), `${job.jobId}.json`, job);
}

export async function removeCopyJob(layout: StateLayout, jobId: string) {
  await Deno.remove(join(copyQueueDir(layout), `${jobId}.json`)).catch(
    () => {},
  );
}

function parseJob(raw: unknown, name: string): CopyJob | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  try {
    if (
      r.version !== 1 || `${r.jobId}.json` !== name ||
      typeof r.managedId !== "string" || typeof r.backupId !== "string" ||
      typeof r.artifactExtension !== "string" ||
      typeof r.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(r.sha256) ||
      typeof r.sizeBytes !== "number" || typeof r.createdAt !== "string" ||
      typeof r.attempts !== "number"
    ) return null;
    return {
      ...(r as unknown as CopyJob),
      target: parseBackupCopyTarget(r.target),
    };
  } catch {
    return null;
  }
}

/** Every readable job, oldest first. Unreadable files are left in place. */
export async function listCopyJobs(layout: StateLayout): Promise<CopyJob[]> {
  const dir = copyQueueDir(layout);
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(dir));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err;
  }
  const jobs: CopyJob[] = [];
  for (const entry of entries) {
    if (!entry.isFile || !JOB_FILE_RE.test(entry.name)) continue;
    try {
      const job = parseJob(
        JSON.parse(await Deno.readTextFile(join(dir, entry.name))),
        entry.name,
      );
      if (job) jobs.push(job);
    } catch { /* a half-written or foreign file: skip */ }
  }
  return jobs.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function writeCopyReport(
  layout: StateLayout,
  jobId: string,
  report: CopyReport,
) {
  const stored: StoredReport = { version: 1, ...report };
  await writeAtomic(copyReportsDir(layout), `${jobId}.json`, stored);
}

export async function listCopyReports(
  layout: StateLayout,
): Promise<{ jobId: string; report: CopyReport }[]> {
  const dir = copyReportsDir(layout);
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(dir));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err;
  }
  const out: { jobId: string; report: CopyReport }[] = [];
  for (const entry of entries) {
    const jobId = JOB_FILE_RE.exec(entry.name)?.[1];
    if (!entry.isFile || !jobId) continue;
    try {
      const { version: _v, ...report } = JSON.parse(
        await Deno.readTextFile(join(dir, entry.name)),
      ) as StoredReport;
      out.push({ jobId, report });
    } catch { /* skip */ }
  }
  return out.slice(0, 20);
}

export async function removeCopyReport(layout: StateLayout, jobId: string) {
  await Deno.remove(join(copyReportsDir(layout), `${jobId}.json`)).catch(
    () => {},
  );
}

const listeners = new Set<() => void>();

/** The copier subscribes so a freshly queued job starts without waiting for the next tick. */
export function onCopyQueued(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyCopyQueued(): void {
  for (const listener of listeners) listener();
}
