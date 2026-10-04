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
  const { tailChars, maxLineChars, maxTotalChars } = limits;
  let kept: string[] = [];
  let keptChars = 0;
  let total = 0;
  let limitHit = false;
  let pending = "";
  const emit = (raw: string) => {
    const line = stripCarriageReturn(raw);
    if (line.length > 0) onLine?.(line);
  };
  const feed = (value: string) => {
    let start = 0;
    let newlineAt = value.indexOf("\n", start);
    while (newlineAt !== -1) {
      emit(pending + value.slice(start, newlineAt));
      pending = "";
      start = newlineAt + 1;
      newlineAt = value.indexOf("\n", start);
    }
    pending += value.slice(start);
    if (maxLineChars !== undefined && pending.length > maxLineChars) {
      let at = 0;
      while (pending.length - at > maxLineChars) {
        emit(pending.slice(at, at + maxLineChars));
        at += maxLineChars;
      }
      pending = pending.slice(at);
    }
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || limitHit) continue;
      total += value.length;
      if (maxTotalChars !== undefined && total > maxTotalChars) {
        limitHit = true;
        limits.onLimit?.();
        continue;
      }
      kept.push(value);
      keptChars += value.length;
      if (tailChars !== undefined && keptChars > tailChars * 2) {
        const joined = kept.join("").slice(-tailChars);
        kept = [joined];
        keptChars = joined.length;
      }
      if (onLine) feed(value);
    }
    if (onLine && pending.trim().length > 0) emit(pending);
  } finally {
    reader.releaseLock();
  }
  const text = kept.join("");
  return tailChars === undefined ? text : text.slice(-tailChars);
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
