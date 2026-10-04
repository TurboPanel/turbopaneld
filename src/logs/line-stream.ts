/**
 * Line-oriented tee for a child process' stdout/stderr.
 *
 * Shared by `src/deploy/docker-cli.ts` (`runDockerStreamed`) and the deploy
 * shell hooks: decode a byte stream, emit complete lines as they arrive, and
 * still accumulate the full text for the buffered result the caller returns.
 */

export type LineHandler = (line: string) => void;

function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

export interface PumpLimits {
  /** Keep only the last this-many characters of the returned text. */
  tailChars?: number;
  /** Split a line longer than this into pieces before `onLine`. */
  maxLineChars?: number;
  /** Past this many characters in total, call `onLimit` once and discard the rest. */
  maxTotalChars?: number;
  onLimit?: () => void;
}

/** Splits decoded chunks into lines in time linear in the input. */
class LineSplitter {
  private pending = "";

  constructor(
    private readonly onLine: LineHandler,
    private readonly maxLineChars?: number,
  ) {}

  private emit(raw: string): void {
    const line = stripCarriageReturn(raw);
    if (line.length > 0) this.onLine(line);
  }

  push(value: string): void {
    let start = 0;
    let newlineAt = value.indexOf("\n", start);
    while (newlineAt !== -1) {
      this.emit(this.pending + value.slice(start, newlineAt));
      this.pending = "";
      start = newlineAt + 1;
      newlineAt = value.indexOf("\n", start);
    }
    this.pending += value.slice(start);
    this.splitLongPending();
  }

  private splitLongPending(): void {
    const max = this.maxLineChars;
    if (max === undefined || this.pending.length <= max) return;
    let at = 0;
    while (this.pending.length - at > max) {
      this.emit(this.pending.slice(at, at + max));
      at += max;
    }
    this.pending = this.pending.slice(at);
  }

  finish(): void {
    if (this.pending.trim().length > 0) this.emit(this.pending);
  }
}

/** Keeps decoded text, or only its tail when a limit is given. */
class TextKeeper {
  private parts: string[] = [];
  private chars = 0;

  constructor(private readonly tailChars?: number) {}

  push(value: string): void {
    this.parts.push(value);
    this.chars += value.length;
    if (this.tailChars !== undefined && this.chars > this.tailChars * 2) {
      const joined = this.parts.join("").slice(-this.tailChars);
      this.parts = [joined];
      this.chars = joined.length;
    }
  }

  text(): string {
    const text = this.parts.join("");
    return this.tailChars === undefined ? text : text.slice(-this.tailChars);
  }
}

/**
 * Read `readable` to completion, calling `onLine` per complete line, and
 * resolve with the decoded text (all of it, or only its tail when
 * `limits.tailChars` is set). Line splitting is linear in the input size.
 */
export async function pumpLines(
  readable: ReadableStream<Uint8Array>,
  onLine?: LineHandler,
  limits: PumpLimits = {},
): Promise<string> {
  const reader = readable.pipeThrough(new TextDecoderStream()).getReader();
  const keeper = new TextKeeper(limits.tailChars);
  const splitter = onLine
    ? new LineSplitter(onLine, limits.maxLineChars)
    : undefined;
  let total = 0;
  let limitHit = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || limitHit) continue;
      total += value.length;
      if (limits.maxTotalChars !== undefined && total > limits.maxTotalChars) {
        limitHit = true;
        limits.onLimit?.();
        continue;
      }
      keeper.push(value);
      splitter?.push(value);
    }
    splitter?.finish();
  } finally {
    reader.releaseLock();
  }
  return keeper.text();
}

/** Replay already-buffered text through `onLine`, one non-empty line at a time. */
export function emitBufferedLines(text: string, onLine?: LineHandler): void {
  if (!onLine || text.length === 0) return;
  for (const raw of text.split("\n")) {
    const line = stripCarriageReturn(raw);
    if (line.length > 0) onLine(line);
  }
}

/** Bounds for a tenant build's output held in the daemon (not the transcript). */
export const BUILD_OUTPUT_LIMITS = {
  tailChars: 64 * 1024,
  maxLineChars: 64 * 1024,
  maxTotalChars: 128 * 1024 * 1024,
} as const;
