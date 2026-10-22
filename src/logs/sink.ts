/**
 * Command output sink — spool + redaction + batched upload behind the tiny
 * {@link CommandOutputSink} interface handlers pass to `runDockerStreamed`.
 *
 * Ordering guarantee: a line is redacted *before* it is written to the spool
 * file, so plaintext secrets never touch disk. Uploads are batched (see
 * `spool.ts` thresholds) and failures never escape into the command outcome.
 */

import { logWarn, sanitizeForLog } from "../util/logger.ts";
import { commandLogSpoolDir, type LayoutPaths } from "../paths/layout.ts";
import {
  type CommandLogStream,
  type CommandOutputSink,
  createNoopCommandOutputSink,
} from "./contracts.ts";
import {
  createMutableTranscriptRedactor,
  type MutableTranscriptRedactor,
  redactCommandSummary,
} from "./redactor.ts";
import { CommandLogSpool, type PendingChunk } from "./spool.ts";
import {
  CommandLogUploader,
  MAX_COMMAND_LOG_BYTES,
  type SendCommandLogChunkFn,
} from "./uploader.ts";

/** How often chunks the control plane has not taken yet are tried again. */
export const LOG_RETRY_INTERVAL_MS = 5_000;

/** How many retry rounds `finalize()` waits for the control plane (about a minute). */
export const LOG_FINALIZE_RETRY_ROUNDS = 12;

/** Slack above the upload cap before lines are no longer kept for a later upload. */
const BACKLOG_SLACK_BYTES = 64 * 1024;

export type CreateCommandOutputSinkOptions = {
  commandId: string;
  /** Initial phase for lines emitted before the first `setPhase`. */
  phase: string;
  /** Control-plane transport (usually `DaemonApiClient.sendCommandLogChunk`). */
  send: SendCommandLogChunkFn;
  layout: Pick<LayoutPaths, "daemonStateDir">;
  /** Deny-set seed for material the caller already holds in plaintext. */
  secrets?: readonly (string | null | undefined)[];
  spoolDir?: string;
  flushIntervalMs?: number;
  flushBytes?: number;
  maxBytes?: number;
  now?: () => number;
  /** Test seams: the retry timer and the wait between final retry rounds. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
  retryIntervalMs?: number;
  maxAttempts?: number;
};

type SinkTimers = {
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  sleep: (ms: number) => Promise<void>;
  retryIntervalMs: number;
};

class CommandOutputSinkImpl implements CommandOutputSink {
  readonly #spool: CommandLogSpool;
  readonly #uploader: CommandLogUploader;
  readonly #redactor: MutableTranscriptRedactor;
  #phase: string;
  #chain: Promise<void> = Promise.resolve();
  #allAcked = true;
  #finalized = false;
  /** Every chunk taken from the spool, in order; acked ones stay for a resync. */
  readonly #chunks: PendingChunk[] = [];
  /** Index into {@link #chunks} of the first chunk the control plane has not taken. */
  #nextIndex = 0;
  #backlogBytes = 0;
  readonly #maxBytes: number;
  #retryHandle: unknown;
  readonly #timers: SinkTimers;

  constructor(
    spool: CommandLogSpool,
    uploader: CommandLogUploader,
    redactor: MutableTranscriptRedactor,
    phase: string,
    timers: SinkTimers,
    maxBytes: number,
  ) {
    this.#spool = spool;
    this.#uploader = uploader;
    this.#redactor = redactor;
    this.#phase = phase;
    this.#timers = timers;
    this.#maxBytes = maxBytes;
  }

  setPhase(phase: string): void {
    this.#phase = phase;
  }

  addSecrets(values: readonly (string | null | undefined)[]): void {
    this.#redactor.add(values);
  }

  redactSummary(text: string): string {
    // Same deny-set as `onLine`, but whole-text: a summary is the raw
    // stdout/stderr a handler is about to throw, and it never passes through
    // the line path that would otherwise scrub it.
    return redactCommandSummary(text, this.#redactor.secrets());
  }

  onLine(stream: CommandLogStream, message: string): void {
    // Once the transcript is sealed by the truncation marker, stop spooling:
    // the on-disk file must not keep growing past the configured cap.
    if (this.#finalized || this.#uploader.truncated) return;
    // A control plane that stays away must not grow the backlog without bound.
    if (this.#backlogBytes >= this.#maxBytes + BACKLOG_SLACK_BYTES) return;
    const redacted = this.#redactor.redact(message);
    if (redacted.length === 0) return;
    try {
      this.#spool.append({
        timestamp: new Date().toISOString(),
        stream,
        phase: this.#phase,
        message: redacted,
      });
    } catch (err) {
      this.#warn("spool append failed", err);
      return;
    }
    if (this.#spool.flushDue()) this.#queueFlush();
  }

  finalize(): Promise<void> {
    if (this.#finalized) return this.#chain;
    this.#finalized = true;
    this.#stopRetry();
    this.#queueFlush();
    this.#chain = this.#chain
      .then(() => this.#settleQueue(LOG_FINALIZE_RETRY_ROUNDS))
      .then(() => this.#settleSpool());
    return this.#chain;
  }

  async #settleSpool(): Promise<void> {
    if (!this.#allAcked) {
      // Leave the file behind: the orphan sweep re-uploads it on next start.
      this.#spool.close();
      return;
    }
    try {
      await this.#spool.discard();
    } catch (err) {
      this.#warn("spool cleanup failed", err);
    }
  }

  #queueFlush(): void {
    this.#chain = this.#chain.then(() => this.#flush());
  }

  async #flush(): Promise<void> {
    const chunk = this.#spool.takePendingChunk();
    if (chunk) {
      this.#chunks.push(chunk);
      this.#backlogBytes += chunk.bytes.length;
    }
    await this.#drain();
    if (!this.#finalized && !this.#allSent()) this.#scheduleRetry();
  }

  #allSent(): boolean {
    return this.#uploader.truncated || this.#nextIndex >= this.#chunks.length;
  }

  /** Send the chunks the control plane has not taken, in order, until one fails. */
  async #drain(): Promise<void> {
    if (this.#allSent() || this.#uploader.refused) return;
    // Already sealed: whatever raced in after the marker is dropped on
    // purpose, not lost work.
    if (this.#uploader.truncated) return;
    const chunk = this.#chunks[this.#nextIndex];
    let acked = false;
    try {
      acked = await this.#uploader.upload(chunk);
    } catch (err) {
      this.#warn("chunk upload failed", err);
    }
    if (acked) {
      this.#nextIndex += 1;
      this.#allAcked = this.#allAcked || this.#allSent();
      return await this.#drain();
    }
    this.#allAcked = false;
    this.#resyncOnConflict();
  }

  /** The control plane is missing earlier chunks: go back and send from there. */
  #resyncOnConflict(): void {
    const expected = this.#uploader.takeConflict();
    if (expected === undefined) return;
    const index = this.#chunks.findIndex((chunk) => chunk.seq >= expected);
    if (index >= 0 && index < this.#nextIndex) this.#nextIndex = index;
  }

  /** Keep trying until everything is taken, a bounded number of rounds. */
  async #settleQueue(rounds: number): Promise<void> {
    if (this.#allSent() || this.#uploader.refused || rounds <= 0) return;
    await this.#drain();
    if (this.#allSent()) return;
    await this.#timers.sleep(this.#timers.retryIntervalMs);
    return await this.#settleQueue(rounds - 1);
  }

  #scheduleRetry(): void {
    if (this.#retryHandle !== undefined || this.#uploader.refused) return;
    this.#retryHandle = this.#timers.setTimer(() => {
      this.#retryHandle = undefined;
      if (!this.#finalized) this.#queueFlush();
    }, this.#timers.retryIntervalMs);
  }

  #stopRetry(): void {
    if (this.#retryHandle === undefined) return;
    this.#timers.clearTimer(this.#retryHandle);
    this.#retryHandle = undefined;
  }

  #warn(what: string, err: unknown): void {
    logWarn(
      "logs",
      `${what} command=${sanitizeForLog(this.#spool.commandId)}: ${
        sanitizeForLog(err)
      }`,
    );
  }
}

function defaultSetTimer(fn: () => void, ms: number): unknown {
  const handle = setTimeout(fn, ms);
  Deno.unrefTimer(handle);
  return handle;
}

/**
 * Build the real sink for one command execution. Returns the no-op sink when
 * the spool cannot be opened — transcript capture is never load-bearing.
 */
export function createCommandOutputSink(
  options: CreateCommandOutputSinkOptions,
): CommandOutputSink {
  const dir = options.spoolDir ?? commandLogSpoolDir(options.layout);
  try {
    const spool = CommandLogSpool.open({
      commandId: options.commandId,
      dir,
      ...(options.flushIntervalMs === undefined
        ? {}
        : { flushIntervalMs: options.flushIntervalMs }),
      ...(options.flushBytes === undefined
        ? {}
        : { flushBytes: options.flushBytes }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    const uploader = new CommandLogUploader({
      commandId: options.commandId,
      send: options.send,
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
      ...(options.maxAttempts === undefined
        ? {}
        : { maxAttempts: options.maxAttempts }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    });
    return new CommandOutputSinkImpl(
      spool,
      uploader,
      createMutableTranscriptRedactor(options.secrets ?? []),
      options.phase,
      {
        setTimer: options.setTimer ?? defaultSetTimer,
        clearTimer: options.clearTimer ??
          ((handle) => clearTimeout(handle as number)),
        sleep: options.sleep ??
          ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
        retryIntervalMs: options.retryIntervalMs ?? LOG_RETRY_INTERVAL_MS,
      },
      options.maxBytes ?? MAX_COMMAND_LOG_BYTES,
    );
  } catch (err) {
    logWarn(
      "logs",
      `command log spool unavailable command=${
        sanitizeForLog(options.commandId)
      }: ${sanitizeForLog(err)}`,
    );
    return createNoopCommandOutputSink();
  }
}
