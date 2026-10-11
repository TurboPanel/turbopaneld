/**
 * Deliver the run-result spool (`result-spool.ts`) to the control plane as
 * `backup-run-report` frames, and delete a spooled result only when a
 * `backup-run-report-result` with its id comes back, `ok` true or false. No
 * answer (a disconnect, a control plane that does not know the frame yet, a
 * database error on its side) leaves the file for the next tick; the control
 * plane records each run once however often it arrives.
 *
 * The frame's `id` is the run id, which is also the file's name, so an answer
 * finds its file even after a reconnect or a daemon restart.
 *
 * Shaped like `instance/ha-observe.ts`: a local timer while the socket is up,
 * never a control-plane poll.
 */

import { join } from "@std/path";
import type {
  BackupRunReportMessage,
  BackupRunReportResultMessage,
} from "../contracts/cell-messages.ts";
import { type LayoutPaths, resolveLayout } from "../paths/layout.ts";
import { logInfo, logWarn, sanitizeForLog } from "../util/logger.ts";
import { firstSequential } from "../util/sequential.ts";
import { backupResultsDir, MAX_RESULT_ERROR_LENGTH } from "./result-spool.ts";
import { parseTimerNextRun, timerNextRunArgs } from "./timer-next-run.ts";

const REPORT_INTERVAL_MS = 60_000;
/** Reports sent per tick: a backlog drains over several ticks, oldest first. */
export const MAX_REPORTS_PER_TICK = 20;

const RESULT_FILE_RE = /^([\w-]{1,64})\.json$/;
const RUN_TOKEN_RE = /^[\w-]{1,64}$/;
const POLICY_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CHECKSUM_RE = /^[a-f0-9]{64}$/;
const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
/**
 * The control plane's frame limits for this message (turbopanel
 * `cell-protocol.ts`). A spooled result outside them is quarantined here
 * rather than sent, because an out-of-shape frame closes the socket.
 */
const MAX_PATH_CHARS = 1024;
const MAX_PRUNED = 256;

/** A spooled result as it goes on the wire; the reporter adds `id`, `nextRunAt` and `at`. */
export type SpooledBackupRunResult = Omit<
  BackupRunReportMessage,
  "type" | "id" | "nextRunAt" | "at"
>;

const OPTIONAL_FIELDS = [
  "error",
  "backupId",
  "sizeBytes",
  "checksum",
  "path",
  "pruned",
] as const;

export type BackupResultReporterOptions = {
  /** Send one frame; false when the socket is not open (the tick stops there). */
  send: (message: BackupRunReportMessage) => boolean;
  intervalMs?: number;
  now?: () => string;
  /** When the policy's timer next fires; defaults to {@link readTimerNextRun}. */
  readNextRun?: (policyId: string) => Promise<string | undefined>;
  /** Test seam — defaults to {@link resolveLayout} from process env. */
  layout?: Pick<LayoutPaths, "daemonStateDir">;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && ISO_TIMESTAMP_RE.test(value) &&
    Number.isFinite(Date.parse(value));
}

function isRunToken(value: unknown): value is string {
  return typeof value === "string" && RUN_TOKEN_RE.test(value);
}

function isAbsent(value: unknown): boolean {
  return value === undefined;
}

function checkRunFields(
  raw: Record<string, unknown>,
  runId: string,
): string | null {
  if (raw.version !== 1) return "unsupported version";
  if (typeof raw.policyId !== "string" || !POLICY_ID_RE.test(raw.policyId)) {
    return "invalid policyId";
  }
  if (raw.runId !== runId) return "runId does not match the file name";
  if (!isIsoTimestamp(raw.startedAt) || !isIsoTimestamp(raw.finishedAt)) {
    return "invalid timestamps";
  }
  if (raw.status !== "succeeded" && raw.status !== "failed") {
    return "invalid status";
  }
  const error = raw.error;
  if (
    !isAbsent(error) &&
    (typeof error !== "string" || error.length > MAX_RESULT_ERROR_LENGTH)
  ) {
    return "invalid error";
  }
  return null;
}

function isPrunedList(value: unknown): boolean {
  return Array.isArray(value) && value.length <= MAX_PRUNED &&
    value.every((entry) => isRunToken(entry));
}

function checkArtifactFields(raw: Record<string, unknown>): string | null {
  if (!isAbsent(raw.backupId) && !isRunToken(raw.backupId)) {
    return "invalid backupId";
  }
  const size = raw.sizeBytes;
  if (
    !isAbsent(size) &&
    !(typeof size === "number" && Number.isSafeInteger(size) && size >= 0)
  ) {
    return "invalid sizeBytes";
  }
  const checksum = raw.checksum;
  if (
    !isAbsent(checksum) &&
    !(typeof checksum === "string" && CHECKSUM_RE.test(checksum))
  ) {
    return "invalid checksum";
  }
  const path = raw.path;
  if (
    !isAbsent(path) &&
    !(typeof path === "string" && path.length <= MAX_PATH_CHARS)
  ) {
    return "invalid path";
  }
  if (!isAbsent(raw.pruned) && !isPrunedList(raw.pruned)) {
    return "invalid pruned";
  }
  return null;
}

/**
 * Parse one spooled result (`<runId>.json`). Returns the reason as a string
 * when the file cannot be sent as a well-formed frame.
 */
export function parseSpooledBackupRunResult(
  text: string,
  runId: string,
): SpooledBackupRunResult | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return "not JSON";
  }
  if (!isRecord(raw)) return "not an object";
  const issue = checkRunFields(raw, runId) ?? checkArtifactFields(raw);
  if (issue) return issue;
  const result: Record<string, unknown> = {
    policyId: raw.policyId,
    runId: raw.runId,
    startedAt: raw.startedAt,
    finishedAt: raw.finishedAt,
    status: raw.status,
  };
  for (const field of OPTIONAL_FIELDS) {
    if (raw[field] !== undefined) result[field] = raw[field];
  }
  return result as SpooledBackupRunResult;
}

/**
 * When `turbopanel-backup-<policyId>.timer` next fires. A read-only query (no
 * sudo); undefined when the unit does not exist yet, is not scheduled, or
 * systemctl is unavailable.
 */
export async function readTimerNextRun(
  policyId: string,
): Promise<string | undefined> {
  if (!POLICY_ID_RE.test(policyId)) return undefined;
  try {
    const timer = `turbopanel-backup-${policyId}.timer`;
    const out = await new Deno.Command("systemctl", {
      args: timerNextRunArgs(timer),
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!out.success) return undefined;
    return parseTimerNextRun(new TextDecoder().decode(out.stdout), timer);
  } catch {
    return undefined;
  }
}

/** Spooled run ids, oldest first, at most {@link MAX_REPORTS_PER_TICK}. Dot-prefixed files are skipped. */
export async function listSpooledRunIds(dir: string): Promise<string[]> {
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(dir));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err;
  }
  const runIds = entries
    .filter((entry) => entry.isFile)
    .map((entry) => RESULT_FILE_RE.exec(entry.name)?.[1])
    .filter((runId): runId is string => runId !== undefined);
  const stamped = await Promise.all(
    runIds.map(async (runId) => {
      const stat = await Deno.stat(join(dir, `${runId}.json`));
      return { runId, mtime: stat.mtime?.getTime() ?? 0 };
    }),
  );
  return stamped
    .toSorted((a, b) => a.mtime - b.mtime || a.runId.localeCompare(b.runId))
    .slice(0, MAX_REPORTS_PER_TICK)
    .map((entry) => entry.runId);
}

export class BackupResultReporter {
  readonly #send: (message: BackupRunReportMessage) => boolean;
  readonly #intervalMs: number;
  readonly #now: () => string;
  readonly #readNextRun: (policyId: string) => Promise<string | undefined>;
  readonly #layout: Pick<LayoutPaths, "daemonStateDir"> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #ticking = false;

  constructor(options: BackupResultReporterOptions) {
    this.#send = options.send;
    this.#intervalMs = options.intervalMs ?? REPORT_INTERVAL_MS;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#readNextRun = options.readNextRun ?? readTimerNextRun;
    this.#layout = options.layout;
  }

  #resultsDir(): string {
    return backupResultsDir(
      this.#layout ?? resolveLayout(Deno.env.toObject()),
    );
  }

  /** Report once now (the socket just attached), then every interval. */
  attach(): void {
    this.detach();
    this.#timer = setInterval(() => {
      void this.tick();
    }, this.#intervalMs);
    void this.tick();
  }

  detach(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  /** Send the oldest spooled results; overlapping ticks are skipped. */
  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      const dir = this.#resultsDir();
      const runIds = await listSpooledRunIds(dir);
      await firstSequential(runIds, (runId) => this.#report(dir, runId));
    } catch (err) {
      logWarn("backups", "backup result report failed:", sanitizeForLog(err));
    } finally {
      this.#ticking = false;
    }
  }

  /** Resolves "stop" when the socket is gone, which ends this tick. */
  async #report(dir: string, runId: string): Promise<"stop" | undefined> {
    let text: string;
    try {
      text = await Deno.readTextFile(join(dir, `${runId}.json`));
    } catch (err) {
      // Acked and deleted between the listing and this read.
      if (err instanceof Deno.errors.NotFound) return undefined;
      throw err;
    }
    const result = parseSpooledBackupRunResult(text, runId);
    if (typeof result === "string") {
      await this.#quarantine(dir, runId, result);
      return undefined;
    }
    const nextRunAt = await this.#readNextRun(result.policyId);
    const message: BackupRunReportMessage = {
      type: "backup-run-report",
      id: runId,
      ...result,
      ...(nextRunAt === undefined ? {} : { nextRunAt }),
      at: this.#now(),
    };
    return this.#send(message) ? undefined : "stop";
  }

  /** Park an unsendable file under a dot name: skipped from now on, kept for a look. */
  async #quarantine(dir: string, runId: string, reason: string): Promise<void> {
    await Deno.rename(
      join(dir, `${runId}.json`),
      join(dir, `.${runId}.json.invalid`),
    );
    logWarn(
      "backups",
      `spooled backup result ${runId} is not sendable (${reason}); kept as .${runId}.json.invalid`,
    );
  }

  /** The control plane answered: drop the spooled result whether it was stored or refused. */
  async handleResult(message: BackupRunReportResultMessage): Promise<void> {
    if (!isRunToken(message.id)) {
      logWarn("backups", "ignored backup-run-report-result with an invalid id");
      return;
    }
    try {
      await Deno.remove(join(this.#resultsDir(), `${message.id}.json`));
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
    if (message.ok) {
      logInfo("backups", `backup run ${message.id} recorded`);
    } else {
      logWarn(
        "backups",
        `backup run ${message.id} refused by the control plane:`,
        sanitizeForLog(message.error ?? "no reason given"),
      );
    }
  }
}
