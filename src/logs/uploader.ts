/**
 * Transcript chunk uploader.
 *
 * Wraps `DaemonApiClient.sendCommandLogChunk` with capped-backoff retry, a
 * per-command byte cap, and a hard guarantee that nothing ever throws out of a
 * command handler: an upload that cannot be delivered is warned about and
 * dropped, never surfaced as a command failure.
 */

import { logWarn, sanitizeForLog } from "../logger.ts";
import type { PendingChunk } from "./spool.ts";

/** Per-command transcript cap; beyond it a single marker line is uploaded. */
export const MAX_COMMAND_LOG_BYTES = 2 * 1024 * 1024;

export const TRUNCATION_MARKER = "... transcript truncated ...";

const DEFAULT_MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 200;
const MAX_BACKOFF_MS = 2_000;

export type SendCommandLogChunkFn = (params: {
  commandId: string;
  seq: number;
  bytes: string;
}) => Promise<{ nextSeq: number }>;

export type CommandLogUploaderOptions = {
  commandId: string;
  send: SendCommandLogChunkFn;
  maxBytes?: number;
  maxAttempts?: number;
  /** Injectable sleep (tests) — defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CommandLogUploader {
  readonly commandId: string;
  readonly #send: SendCommandLogChunkFn;
  readonly #maxBytes: number;
  readonly #maxAttempts: number;
  readonly #sleep: (ms: number) => Promise<void>;
  #uploadedBytes = 0;
  #truncated = false;
  #stopped = false;

  constructor(options: CommandLogUploaderOptions) {
    this.commandId = options.commandId;
    this.#send = options.send;
    this.#maxBytes = options.maxBytes ?? MAX_COMMAND_LOG_BYTES;
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  /**
   * True once the byte cap tripped *and* the truncation marker was acked — no
   * further chunks are uploaded. A marker that could not be delivered leaves
   * this false so the caller keeps treating the spooled bytes as unacked work.
   */
  get truncated(): boolean {
    return this.#truncated;
  }

  get uploadedBytes(): number {
    return this.#uploadedBytes;
  }

  /**
   * Upload one chunk. Returns true when the control plane acked it. Never
   * throws — transport failures are logged and the chunk is dropped.
   */
  async upload(chunk: PendingChunk): Promise<boolean> {
    if (this.#stopped) return false;

    if (this.#uploadedBytes + chunk.bytes.length > this.#maxBytes) {
      return await this.#truncate(chunk.seq);
    }

    const sent = await this.#sendWithRetry(chunk.seq, chunk.bytes);
    if (sent) this.#uploadedBytes += chunk.bytes.length;
    return sent;
  }

  /**
   * Seal the transcript with a single marker line. Only a delivered marker
   * counts: if it cannot be sent, nothing is sealed and `upload()` reports the
   * chunk as unacked so the spool file survives for the orphan sweep.
   */
  async #truncate(seq: number): Promise<boolean> {
    const marker = `${TRUNCATION_MARKER}\n`;
    const sent = await this.#sendWithRetry(seq, marker);
    if (!sent) return false;
    this.#truncated = true;
    this.#stopped = true;
    this.#uploadedBytes += marker.length;
    return true;
  }

  async #sendWithRetry(seq: number, bytes: string): Promise<boolean> {
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      try {
        await this.#send({ commandId: this.commandId, seq, bytes });
        return true;
      } catch (err) {
        if (attempt === this.#maxAttempts) {
          logWarn(
            "logs",
            `command log chunk dropped command=${
              sanitizeForLog(this.commandId)
            } seq=${seq}: ${sanitizeForLog(err)}`,
          );
          return false;
        }
        await this.#sleep(
          Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS),
        );
      }
    }
    return false;
  }
}
