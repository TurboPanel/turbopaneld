/**
 * Send the copy reports (`copies/reports/<jobId>.json`) to the control plane
 * as `backup-copy-report` frames and delete each only when the matching
 * `backup-copy-report-result` arrives. Nothing is sent unless the attached
 * control plane lists `backup-s3-copy-v1`: an older one would close the socket
 * on a frame it does not know.
 */

import type {
  BackupCopyReportMessage,
  BackupCopyReportResultMessage,
} from "../contracts/cell-messages.ts";
import { type LayoutPaths, resolveLayout } from "../paths/layout.ts";
import { logInfo, logWarn, sanitizeForLog } from "../util/logger.ts";
import { firstSequential } from "../util/sequential.ts";
import { listCopyReports, removeCopyReport } from "./copy-queue.ts";

const REPORT_INTERVAL_MS = 60_000;
const JOB_ID_RE = /^[0-9a-f]{32}$/;

export type BackupCopyReporterOptions = {
  send: (message: BackupCopyReportMessage) => boolean;
  peerSupports: () => boolean;
  intervalMs?: number;
  now?: () => string;
  layout?: Pick<LayoutPaths, "daemonStateDir">;
};

export class BackupCopyReporter {
  readonly #opts: BackupCopyReporterOptions;
  #timer: ReturnType<typeof setInterval> | undefined;
  #ticking = false;

  constructor(options: BackupCopyReporterOptions) {
    this.#opts = options;
  }

  #layout() {
    return this.#opts.layout ?? resolveLayout(Deno.env.toObject());
  }

  attach(): void {
    this.detach();
    this.#timer = setInterval(
      () => void this.tick(),
      this.#opts.intervalMs ?? REPORT_INTERVAL_MS,
    );
    void this.tick();
  }

  detach(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.#ticking || !this.#opts.peerSupports()) return;
    this.#ticking = true;
    try {
      const reports = await listCopyReports(this.#layout());
      await firstSequential(reports, ({ jobId, report }) => {
        const message: BackupCopyReportMessage = {
          type: "backup-copy-report",
          id: jobId,
          ...report,
          at: (this.#opts.now ?? (() => new Date().toISOString()))(),
        };
        return Promise.resolve(this.#opts.send(message) ? undefined : "stop");
      });
    } catch (err) {
      logWarn("backups", "backup copy report failed:", sanitizeForLog(err));
    } finally {
      this.#ticking = false;
    }
  }

  async handleResult(message: BackupCopyReportResultMessage): Promise<void> {
    if (!JOB_ID_RE.test(message.id)) {
      logWarn(
        "backups",
        "ignored backup-copy-report-result with an invalid id",
      );
      return;
    }
    await removeCopyReport(this.#layout(), message.id);
    if (message.ok) {
      logInfo("backups", `backup copy ${message.id} recorded`);
    } else {
      logWarn(
        "backups",
        `backup copy ${message.id} refused by the control plane:`,
        sanitizeForLog(message.error ?? "no reason given"),
      );
    }
  }
}
