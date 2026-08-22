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

/**
 * Read `readable` to completion, calling `onLine` per complete line, and
 * resolve with the full decoded text.
 */
export async function pumpLines(
  readable: ReadableStream<Uint8Array>,
  onLine?: LineHandler,
): Promise<string> {
  const reader = readable.pipeThrough(new TextDecoderStream()).getReader();
  const chunks: string[] = [];
  let pending = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      if (!onLine) continue;
      pending += value;
      let newlineAt = pending.indexOf("\n");
      while (newlineAt !== -1) {
        const line = stripCarriageReturn(pending.slice(0, newlineAt));
        pending = pending.slice(newlineAt + 1);
        if (line.length > 0) onLine(line);
        newlineAt = pending.indexOf("\n");
      }
    }
    if (onLine && pending.trim().length > 0) {
      onLine(stripCarriageReturn(pending));
    }
  } finally {
    reader.releaseLock();
  }
  return chunks.join("");
}

/** Replay already-buffered text through `onLine`, one non-empty line at a time. */
export function emitBufferedLines(text: string, onLine?: LineHandler): void {
  if (!onLine || text.length === 0) return;
  for (const raw of text.split("\n")) {
    const line = stripCarriageReturn(raw);
    if (line.length > 0) onLine(line);
  }
}
