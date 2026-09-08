/**
 * Kernel `hung_task` detection: primary source is a non-blocking,
 * cursor-based scan of `/dev/kmsg`. `/dev/kmsg` is a stream device, but
 * opened `O_NONBLOCK` each `read()` returns exactly one already-buffered
 * kernel-log record or fails with `EAGAIN` once drained — never blocking the
 * collection tick the way a plain `cat`/`Deno.readTextFile` open would. On
 * first open the existing backlog is drained silently to seed the cursor
 * (the record `seq` last consumed) so a freshly-started daemon doesn't
 * replay the whole ring buffer as brand-new events; every scan after that
 * only returns records with `seq` past the cursor.
 *
 * `/dev/kmsg` requires `CAP_SYSLOG` when `kernel.dmesg_restrict=1` (the
 * common default) — when the open fails (`EPERM`, or the device is simply
 * absent) this collector falls back to bounded `dmesg --level=err,warn -x`,
 * strictly secondary and only as often as this collector's own low-cadence
 * timer allows (documented exception, same shape as `smart.ts`/
 * `clock-sync.ts`) — never a subprocess on the metrics tick itself.
 *
 * Lines are deduplicated by exact content so a line already reported on a
 * prior tick never re-fires — the kmsg cursor already prevents replay, but
 * the `dmesg` fallback's ring buffer keeps returning history, so this stays
 * the single dedupe path shared by both sources; the dedupe set is bounded
 * so a very chatty kernel log can't grow it unbounded over a long daemon
 * lifetime.
 */
import { closeSync, constants, openSync, readSync } from "node:fs";
import type { EventCollector, EventDetectContext } from "./types.ts";
import { makeEvent } from "./types.ts";
import type { MetricEvent } from "../../contract.ts";

export const DEFAULT_HUNG_TASK_INTERVAL_MS = 2 * 60_000;
const MAX_SEEN_LINES = 500;
const KMSG_PATH = "/dev/kmsg";

// The kernel emits the hung-task warning as
// "INFO: task <comm>:<pid> blocked for more than <n> seconds." — a
// *separate* line ("...hung_task_timeout_secs" disables this message) is the
// only one actually containing the literal "hung_task", and carries no comm.
const HUNG_TASK_RE = /blocked for more than \d+ seconds/i;
const HUNG_TASK_COMM_RE = /task\s+(\S+):\d+\s+blocked/i;

export type KernelLogReader = () => Promise<string[]>;

async function defaultReadDmesg(): Promise<string[]> {
  try {
    const { code, stdout } = await new Deno.Command("dmesg", {
      args: ["--level=err,warn", "-x"],
      stdout: "piped",
      stderr: "null",
      // Scoped --allow-run cannot inherit LD_* / DYLD_* (Deno 2.9).
      clearEnv: true,
      signal: AbortSignal.timeout(10_000),
    }).output();
    if (code !== 0) return [];
    return new TextDecoder().decode(stdout).split("\n").filter((line) =>
      line.length > 0
    );
  } catch {
    return [];
  }
}

/** One raw `/dev/kmsg` record's decoded bytes, or `undefined` once drained (`EAGAIN`) this scan. Throws on a fatal read error — the caller treats that as "kmsg unavailable". */
export type KmsgHandle = {
  next: () => string | undefined;
  close: () => void;
};

/** Injectable `/dev/kmsg` access — production opens the real device; tests supply canned records. */
export type KmsgIo = {
  /** Opens `/dev/kmsg` non-blocking. Throws (`EPERM` under `dmesg_restrict`, `ENOENT` when absent, ...) when unavailable. */
  open: () => KmsgHandle;
};

const KMSG_READ_BUFFER_BYTES = 8192;

function defaultKmsgIo(): KmsgIo {
  return {
    open(): KmsgHandle {
      const fd = openSync(KMSG_PATH, constants.O_RDONLY | constants.O_NONBLOCK);
      const buffer = new Uint8Array(KMSG_READ_BUFFER_BYTES);
      return {
        next(): string | undefined {
          let n: number;
          try {
            n = readSync(fd, buffer, 0, buffer.length, null);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EAGAIN") {
              return undefined;
            }
            throw error;
          }
          if (n <= 0) return undefined;
          return new TextDecoder().decode(buffer.subarray(0, n));
        },
        close(): void {
          try {
            closeSync(fd);
          } catch {
            // already closed / fd invalid — nothing to do.
          }
        },
      };
    },
  };
}

type KmsgRecord = { seq: number; message: string };

// `<level>,<seq>,<timestamp_usec>,<flags>[,extra=...];<message>\n[ KEY=VALUE
// continuation lines]` — only `seq` and the message's own first line matter
// here; the flags/extra fields are variable-length and ignored.
const KMSG_RECORD_RE = /^\d+,(\d+),\d+,[^;]*;([\s\S]*)$/;

function parseKmsgRecord(raw: string): KmsgRecord | undefined {
  const match = KMSG_RECORD_RE.exec(raw.trimEnd());
  if (!match) return undefined;
  const seq = Number(match[1]);
  if (!Number.isFinite(seq)) return undefined;
  return { seq, message: match[2].split("\n")[0] };
}

function drainParsedRecords(handle: KmsgHandle): KmsgRecord[] {
  const records: KmsgRecord[] = [];
  let raw: string | undefined;
  while ((raw = handle.next()) !== undefined) {
    const record = parseKmsgRecord(raw);
    if (record) records.push(record);
  }
  return records;
}

function advanceCursor(records: KmsgRecord[], cursor: number): number {
  let next = cursor;
  for (const record of records) {
    if (record.seq > next) next = record.seq;
  }
  return next;
}

function collectFreshMessages(
  records: KmsgRecord[],
  cursor: number,
): { messages: string[]; cursor: number } {
  const messages: string[] = [];
  let next = cursor;
  for (const record of records) {
    if (record.seq <= next) continue;
    next = record.seq;
    messages.push(record.message);
  }
  return { messages, cursor: next };
}

function closeQuietly(handle: KmsgHandle | undefined): void {
  try {
    handle?.close();
  } catch {
    // already closed / fd invalid — nothing to do.
  }
}

/**
 * Wraps a `KmsgIo` into a `KernelLogReader`: primes the cursor silently on
 * first open (existing backlog never reported as new), then returns only
 * records past the cursor on every later call. Once the underlying open (or
 * a read) fails, this reader gives up on kmsg for the rest of the process
 * lifetime and yields `undefined` so the caller falls back to `dmesg`.
 */
export function createKmsgKernelLogReader(
  io: KmsgIo,
): () => string[] | undefined {
  let handle: KmsgHandle | undefined;
  let unavailable = false;
  let primed = false;
  let cursor = -1;

  return function readNewRecords(): string[] | undefined {
    if (unavailable) return undefined;
    try {
      if (!handle) handle = io.open();
      const records = drainParsedRecords(handle);
      if (!primed) {
        primed = true;
        cursor = advanceCursor(records, cursor);
        return [];
      }
      const fresh = collectFreshMessages(records, cursor);
      cursor = fresh.cursor;
      return fresh.messages;
    } catch {
      unavailable = true;
      closeQuietly(handle);
      handle = undefined;
      return undefined;
    }
  };
}

/** Composes the kmsg-primary / dmesg-fallback `KernelLogReader` production wiring uses. */
export function createDefaultKernelLogReader(
  deps?: { kmsgIo?: KmsgIo; dmesgReader?: KernelLogReader },
): KernelLogReader {
  const readKmsg = createKmsgKernelLogReader(deps?.kmsgIo ?? defaultKmsgIo());
  const readDmesg = deps?.dmesgReader ?? defaultReadDmesg;

  return async function read(): Promise<string[]> {
    const fromKmsg = readKmsg();
    if (fromKmsg !== undefined) return fromKmsg;
    return await readDmesg();
  };
}

export class HungTaskEventCollector implements EventCollector {
  readonly #reader: KernelLogReader;
  readonly #intervalMs: number;
  #lastRunMs: number | null = null;
  readonly #seenLines = new Set<string>();

  constructor(deps?: { reader?: KernelLogReader; intervalMs?: number }) {
    this.#reader = deps?.reader ?? createDefaultKernelLogReader();
    this.#intervalMs = deps?.intervalMs ?? DEFAULT_HUNG_TASK_INTERVAL_MS;
  }

  async detect(ctx: EventDetectContext): Promise<MetricEvent[]> {
    if (
      this.#lastRunMs !== null &&
      ctx.nowMs - this.#lastRunMs < this.#intervalMs
    ) {
      return [];
    }
    this.#lastRunMs = ctx.nowMs;

    const lines = await this.#reader();
    const events: MetricEvent[] = [];

    for (const line of lines) {
      if (!HUNG_TASK_RE.test(line)) continue;
      if (this.#seenLines.has(line)) continue;
      this.#seenLines.add(line);

      const comm = HUNG_TASK_COMM_RE.exec(line)?.[1];
      events.push(
        makeEvent(
          "hung_task",
          "critical",
          ctx.nowMs,
          comm ? { payload: { comm } } : undefined,
        ),
      );
    }

    if (this.#seenLines.size > MAX_SEEN_LINES) {
      const excess = this.#seenLines.size - MAX_SEEN_LINES;
      let dropped = 0;
      for (const line of this.#seenLines) {
        if (dropped++ >= excess) break;
        this.#seenLines.delete(line);
      }
    }

    return events;
  }
}
