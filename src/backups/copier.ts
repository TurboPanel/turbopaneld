/**
 * The copier: runs in the long-running daemon (the one-shot runner has no
 * network permission), takes jobs from the copy queue, uploads each backup to
 * its S3-compatible target, applies the bucket retention, and writes a report
 * the reporter sends to the control plane.
 *
 * A failed job is retried on a back-off schedule (1 min, 5 min, 15 min, 1 h,
 * then every 6 h) up to {@link MAX_ATTEMPTS} tries. A refusal that will not
 * fix itself (wrong key, no such bucket, a refused endpoint) stops after two
 * tries. The local backup file is never touched here.
 */

import type { LayoutPaths } from "../paths/layout.ts";
import { resolveLayout } from "../paths/layout.ts";
import { managedBackupArtifactPath } from "../managed/engine-paths.ts";
import { logInfo, logWarn, sanitizeForLog } from "../util/logger.ts";
import {
  type CopyJob,
  copyUploadsDir,
  listCopyJobs,
  onCopyQueued,
  removeCopyJob,
  saveCopyJob,
  writeCopyReport,
} from "./copy-queue.ts";
import { copyFolder, copyKey } from "./copy-keys.ts";
import { type DecryptSecretsFn, openTargetClient } from "./copy-target.ts";
import { type S3Client, type S3ClientDeps, S3Error } from "./s3/client.ts";
import { pruneBucketFolder } from "./s3/prune.ts";
import { abandonUpload, uploadBackupFile } from "./s3/upload.ts";
import { join } from "@std/path";
import { MAX_RESULT_ERROR_LENGTH } from "./result-spool.ts";

export const MAX_ATTEMPTS = 8;
/** Minutes to wait after the Nth failed attempt (1-based; the last repeats). */
export const RETRY_MINUTES = [1, 5, 15, 60, 360];
const NON_RETRYABLE_ATTEMPTS = 2;
const TICK_MS = 60_000;

export type BackupCopierOptions = {
  decryptSecrets: () => DecryptSecretsFn | undefined;
  layout?: Pick<LayoutPaths, "daemonStateDir"> & LayoutPaths;
  now?: () => Date;
  clientDeps?: S3ClientDeps;
  /** Test seam: build the client for a job instead of opening the sealed key. */
  openClient?: (job: CopyJob) => Promise<S3Client>;
  intervalMs?: number;
};

export function retryDelayMinutes(failedAttempts: number): number {
  return RETRY_MINUTES[Math.min(failedAttempts, RETRY_MINUTES.length) - 1]!;
}

function plainError(err: unknown): { text: string; retryable: boolean } {
  if (err instanceof S3Error) {
    return { text: err.message, retryable: err.retryable };
  }
  const text = err instanceof Error ? err.message : String(err);
  return { text: sanitizeForLog(text), retryable: true };
}

export class BackupCopier {
  readonly #opts: BackupCopierOptions;
  #timer: ReturnType<typeof setInterval> | undefined;
  #unsubscribe: (() => void) | undefined;
  #running: Promise<void> | undefined;

  constructor(options: BackupCopierOptions) {
    this.#opts = options;
  }

  #layout(): LayoutPaths {
    return this.#opts.layout ?? resolveLayout(Deno.env.toObject());
  }

  start(): void {
    this.stop();
    this.#timer = setInterval(
      () => void this.tick(),
      this.#opts.intervalMs ?? TICK_MS,
    );
    this.#unsubscribe = onCopyQueued(() => void this.tick());
    void this.tick();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  /** Work every job that is due. Overlapping calls share one run. */
  tick(): Promise<void> {
    this.#running ??= this.#runDue().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  async #runDue(): Promise<void> {
    try {
      const now = (this.#opts.now ?? (() => new Date()))();
      for (const job of await listCopyJobs(this.#layout())) {
        if (
          job.nextAttemptAt && Date.parse(job.nextAttemptAt) > now.getTime()
        ) {
          continue;
        }
        await this.#process(job);
      }
    } catch (err) {
      logWarn("backups", "backup copy run failed:", sanitizeForLog(err));
    }
  }

  async #client(job: CopyJob): Promise<S3Client> {
    if (this.#opts.openClient) return await this.#opts.openClient(job);
    return await openTargetClient(
      job.target,
      this.#opts.decryptSecrets(),
      this.#opts.clientDeps,
    );
  }

  async #process(job: CopyJob): Promise<void> {
    const layout = this.#layout();
    const now = this.#opts.now ?? (() => new Date());
    try {
      const client = await this.#client(job);
      const path = managedBackupArtifactPath(
        layout,
        job.managedId,
        job.backupId,
        job.artifactExtension,
        job.policyId,
      );
      try {
        await Deno.stat(path);
      } catch {
        await this.#finish(job, {
          state: "failed",
          error: "the backup file is no longer on this server",
        });
        return;
      }
      const key = client.fullKey(copyKey(job));
      await uploadBackupFile(client, {
        path,
        key,
        sha256: job.sha256,
        statePath: join(copyUploadsDir(layout), `${job.jobId}.json`),
      });
      const pruned = await this.#prune(client, job, key);
      await this.#finish(job, {
        state: "copied",
        objectKey: key,
        sizeBytes: job.sizeBytes,
        ...(pruned.length > 0 ? { pruned } : {}),
      });
    } catch (err) {
      await this.#failed(job, err, now());
    }
  }

  /** Retention trouble must not turn a good copy into a failed one. */
  async #prune(client: S3Client, job: CopyJob, key: string): Promise<string[]> {
    if (job.retentionKeep === undefined) return [];
    try {
      return await pruneBucketFolder(
        client,
        client.fullKey(copyFolder(job)),
        job.retentionKeep,
        key,
      );
    } catch (err) {
      logWarn("backups", "bucket retention failed:", sanitizeForLog(err));
      return [];
    }
  }

  async #failed(job: CopyJob, err: unknown, now: Date): Promise<void> {
    const { text, retryable } = plainError(err);
    // Not being able to reach the control plane to open the key is not a try.
    const waiting = err instanceof S3Error && err.code === "NoDecrypt";
    const attempts = waiting ? job.attempts : job.attempts + 1;
    const giveUp = !waiting && (
      attempts >= MAX_ATTEMPTS ||
      (!retryable && attempts >= NON_RETRYABLE_ATTEMPTS)
    );
    if (giveUp) {
      await this.#finish({ ...job, attempts }, {
        state: "failed",
        error: text,
      });
      return;
    }
    const delay = waiting ? 1 : retryDelayMinutes(attempts);
    logInfo(
      "backups",
      `copy of ${job.backupId} will be retried in ${delay} min: ${text}`,
    );
    await saveCopyJob(this.#layout(), {
      ...job,
      attempts,
      lastError: text.slice(0, MAX_RESULT_ERROR_LENGTH),
      nextAttemptAt: new Date(now.getTime() + delay * 60_000).toISOString(),
    });
  }

  async #finish(
    job: CopyJob,
    outcome: {
      state: "copied" | "failed";
      error?: string;
      objectKey?: string;
      sizeBytes?: number;
      pruned?: string[];
    },
  ): Promise<void> {
    const layout = this.#layout();
    if (outcome.state === "failed") {
      await this.#abandon(job);
    }
    await writeCopyReport(layout, job.jobId, {
      targetId: job.target.targetId,
      managedId: job.managedId,
      backupId: job.backupId,
      ...(job.policyId ? { policyId: job.policyId } : {}),
      state: outcome.state,
      ...(outcome.error
        ? { error: outcome.error.slice(0, MAX_RESULT_ERROR_LENGTH) }
        : {}),
      ...(outcome.objectKey ? { objectKey: outcome.objectKey } : {}),
      ...(outcome.sizeBytes === undefined
        ? {}
        : { sizeBytes: outcome.sizeBytes }),
      attempts: Math.max(job.attempts, 1),
      finishedAt: (this.#opts.now ?? (() => new Date()))().toISOString(),
      ...(outcome.pruned ? { pruned: outcome.pruned } : {}),
    });
    await removeCopyJob(layout, job.jobId);
  }

  async #abandon(job: CopyJob): Promise<void> {
    try {
      const client = await this.#client(job);
      await abandonUpload(
        client,
        join(copyUploadsDir(this.#layout()), `${job.jobId}.json`),
      );
    } catch { /* nothing to abort, or no way to reach it */ }
  }
}
