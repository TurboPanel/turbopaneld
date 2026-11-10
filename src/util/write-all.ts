/**
 * Write every byte to a writer whose `write` may take only part of them (a
 * socket, a file). Recursion instead of a loop, so each write waits for the
 * one before it.
 */
export async function writeAll(
  writer: { write(bytes: Uint8Array): Promise<number> },
  bytes: Uint8Array,
): Promise<void> {
  if (bytes.length === 0) return;
  const written = await writer.write(bytes);
  // A writer that takes nothing would never finish; that is a broken peer.
  if (written <= 0) throw new Deno.errors.WriteZero("write took no bytes");
  return await writeAll(writer, bytes.subarray(written));
}
