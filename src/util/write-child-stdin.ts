/**
 * Hand text to a spawned child's piped stdin, tolerating a child that has
 * already exited.
 *
 * A child that refuses its arguments (or fails to start) can exit before it
 * reads stdin. The kernel then reports a broken pipe on our write, and the
 * stream layer surfaces it as `BrokenPipe: Broken pipe (os error 32)` or
 * `Writable stream is closed`. That error says nothing about why the child
 * stopped; the child's own exit code and stderr do, so the caller reads those
 * instead. Any other write failure still throws.
 *
 * @returns `true` when every byte was written and stdin was closed, `false`
 * when the child had already closed its end.
 */
export async function writeChildStdin(
  stdin: WritableStream<Uint8Array>,
  data: string | Uint8Array,
): Promise<boolean> {
  const bytes = typeof data === "string"
    ? new TextEncoder().encode(data)
    : data;
  const writer = stdin.getWriter();
  let complete = true;
  try {
    await writer.write(bytes);
  } catch (err) {
    if (!isClosedPipeError(err)) throw err;
    complete = false;
  }
  try {
    await writer.close();
  } catch (err) {
    if (!isClosedPipeError(err)) throw err;
    complete = false;
  }
  return complete;
}

/** True for the errors a write to a pipe whose reader has gone produces. */
export function isClosedPipeError(err: unknown): boolean {
  if (err instanceof Deno.errors.BrokenPipe) return true;
  const message = (err instanceof Error ? err.message : String(err))
    .toLowerCase();
  return message.includes("broken pipe") ||
    message.includes("epipe") ||
    message.includes("writable stream is closed");
}
