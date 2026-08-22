/**
 * Command output sink — spool + redaction + batched upload behind the tiny
 * {@link CommandOutputSink} interface handlers pass to `runDockerStreamed`.
 *
 * Ordering guarantee: a line is redacted *before* it is written to the spool
 * file, so plaintext secrets never touch disk. Uploads are batched (see
 * `spool.ts` thresholds) and failures never escape into the command outcome.
 */

import { logWarn, sanitizeForLog } from "../logger.ts";
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
import { CommandLogSpool } from "./spool.ts";
import { CommandLogUploader, type SendCommandLogChunkFn } from "./uploader.ts";

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
};

class CommandOutputSinkImpl implements CommandOutputSink {
  readonly #spool: CommandLogSpool;
  readonly #uploader: CommandLogUploader;
  readonly #redactor: MutableTranscriptRedactor;
  #phase: string;
  #chain: Promise<void> = Promise.resolve();
  #allAcked = true;
  #finalized = false;

  constructor(
    spool: CommandLogSpool,
    uploader: CommandLogUploader,
    redactor: MutableTranscriptRedactor,
    phase: string,
  ) {
    this.#spool = spool;
    this.#uploader = uploader;
    this.#redactor = redactor;
    this.#phase = phase;
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
    this.#queueFlush();
    this.#chain = this.#chain.then(async () => {
      if (this.#allAcked) {
        await this.#spool.discard().catch((err) => {
          this.#warn("spool cleanup failed", err);
        });
        return;
      }
      // Leave the file behind: the orphan sweep re-uploads it on next start.
      this.#spool.close();
    });
    return this.#chain;
  }

  #queueFlush(): void {
    this.#chain = this.#chain.then(() => this.#flush());
  }

  async #flush(): Promise<void> {
    const chunk = this.#spool.takePendingChunk();
    if (!chunk) return;
    // Already sealed: whatever raced in after the marker is dropped on
    // purpose, not lost work.
    if (this.#uploader.truncated) return;
    try {
      const acked = await this.#uploader.upload(chunk);
      if (!acked) this.#allAcked = false;
    } catch (err) {
      this.#allAcked = false;
      this.#warn("chunk upload failed", err);
    }
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
    });
    return new CommandOutputSinkImpl(
      spool,
      uploader,
      createMutableTranscriptRedactor(options.secrets ?? []),
      options.phase,
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
