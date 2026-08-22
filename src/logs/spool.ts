/**
 * Durable transcript spool.
 *
 * Every redacted line is appended to
 * `<stateDir>/spool/execution-logs/<commandId>.log` (mode 0600 under a 0700
 * dir) *before* it is batched for upload — the file is the durability source of
 * truth, the in-memory buffer is only a batching cache. A daemon crash leaves
 * the file behind for `orphan-sweep.ts` to re-upload.
 */

import { join } from "@std/path";
import {
  type CommandOutputEvent,
  encodeCommandOutputEvent,
} from "./contracts.ts";

/** Flush cadence — whichever threshold trips first. */
export const FLUSH_INTERVAL_MS = 750;
export const FLUSH_BYTES = 64 * 1024;

const SAFE_COMMAND_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Spool files owned by a command that is still running in this process.
 *
 * The orphan sweep (`orphan-sweep.ts`) may run while commands are in flight —
 * it must only ever touch true crash leftovers, never a file a live sink still
 * appends to.
 */
const activeSpoolPaths = new Set<string>();

/** True while a live {@link CommandLogSpool} still owns this file. */
export function isActiveSpoolPath(path: string): boolean {
  return activeSpoolPaths.has(path);
}

/** Spool files currently owned by a running command (test/diagnostic use). */
export function activeCommandSpoolPaths(): string[] {
  return [...activeSpoolPaths];
}

/** Spool file path for one command; rejects ids that are not path-safe. */
export function commandLogSpoolPath(dir: string, commandId: string): string {
  if (!SAFE_COMMAND_ID_RE.test(commandId)) {
    throw new TypeError(`unsafe commandId for spool path: ${commandId}`);
  }
  return join(dir, `${commandId}.log`);
}

export type PendingChunk = {
  /**
   * Zero-based, gap-free **chunk** sequence for the control plane
   * (`POST /api/daemon/v1/commands/:commandId/log`). Deliberately not the line
   * sequence: the ingest contract counts chunks, so the first upload must be
   * `seq = 0` and every later upload exactly one higher.
   */
  seq: number;
  bytes: string;
};

export type CommandLogSpoolOptions = {
  commandId: string;
  dir: string;
  flushIntervalMs?: number;
  flushBytes?: number;
  /** Injectable clock (tests) — defaults to `Date.now`. */
  now?: () => number;
};

/**
 * Append-only NDJSON spool with a monotonic sequence and a batching buffer.
 * Writes are synchronous so line ordering never depends on scheduling.
 */
export class CommandLogSpool {
  readonly commandId: string;
  readonly path: string;

  #file: Deno.FsFile | undefined;
  #sequence = 0;
  #buffer: string[] = [];
  #bufferBytes = 0;
  /** Next chunk sequence handed to the uploader — zero-based, gap-free. */
  #chunkSeq = 0;
  #lastFlushAt: number;
  readonly #flushIntervalMs: number;
  readonly #flushBytes: number;
  readonly #now: () => number;

  private constructor(options: Required<CommandLogSpoolOptions>, path: string) {
    this.commandId = options.commandId;
    this.path = path;
    this.#flushIntervalMs = options.flushIntervalMs;
    this.#flushBytes = options.flushBytes;
    this.#now = options.now;
    this.#lastFlushAt = options.now();
  }

  static open(options: CommandLogSpoolOptions): CommandLogSpool {
    const resolved: Required<CommandLogSpoolOptions> = {
      commandId: options.commandId,
      dir: options.dir,
      flushIntervalMs: options.flushIntervalMs ?? FLUSH_INTERVAL_MS,
      flushBytes: options.flushBytes ?? FLUSH_BYTES,
      now: options.now ?? Date.now,
    };
    const path = commandLogSpoolPath(resolved.dir, resolved.commandId);
    Deno.mkdirSync(resolved.dir, { recursive: true, mode: 0o700 });
    const spool = new CommandLogSpool(resolved, path);
    spool.#file = Deno.openSync(path, {
      create: true,
      append: true,
      write: true,
      mode: 0o600,
    });
    activeSpoolPaths.add(path);
    return spool;
  }

  /** Next sequence number without consuming it. */
  get sequence(): number {
    return this.#sequence;
  }

  get pendingBytes(): number {
    return this.#bufferBytes;
  }

  /**
   * Append one event, assigning its sequence. Returns the stored event so the
   * caller can inspect the assigned sequence.
   */
  append(
    event: Omit<CommandOutputEvent, "commandId" | "sequence">,
  ): CommandOutputEvent {
    this.#sequence += 1;
    const full: CommandOutputEvent = {
      commandId: this.commandId,
      sequence: this.#sequence,
      ...event,
    };
    const line = encodeCommandOutputEvent(full);
    try {
      this.#file?.writeSync(new TextEncoder().encode(line));
    } catch {
      // A broken spool file must never fail the command; the batching buffer
      // still carries the line to the uploader.
    }
    this.#buffer.push(line);
    this.#bufferBytes += line.length;
    return full;
  }

  /** True when the buffer is due for upload (byte or time threshold). */
  flushDue(): boolean {
    if (this.#bufferBytes === 0) return false;
    if (this.#bufferBytes >= this.#flushBytes) return true;
    return this.#now() - this.#lastFlushAt >= this.#flushIntervalMs;
  }

  /** Take (and clear) the buffered chunk; null when nothing is pending. */
  takePendingChunk(): PendingChunk | null {
    if (this.#buffer.length === 0) return null;
    const chunk: PendingChunk = {
      seq: this.#chunkSeq,
      bytes: this.#buffer.join(""),
    };
    this.#chunkSeq += 1;
    this.#buffer = [];
    this.#bufferBytes = 0;
    this.#lastFlushAt = this.#now();
    return chunk;
  }

  /** Close the file handle without deleting the spool (crash-safe path). */
  close(): void {
    try {
      this.#file?.close();
    } catch {
      // already closed
    }
    this.#file = undefined;
    // No longer owned by a live command: the orphan sweep may pick it up.
    activeSpoolPaths.delete(this.path);
  }

  /** Close and delete the spool file — only after its bytes were acked. */
  async discard(): Promise<void> {
    this.close();
    try {
      await Deno.remove(this.path);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }
}
