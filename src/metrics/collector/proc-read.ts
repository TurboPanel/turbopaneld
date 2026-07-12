/**
 * Read a `/proc` (or sysfs) file. Tries Deno direct read first, then `cat`
 * fallback — Deno 2 blocks direct `/proc` reads under `--allow-read`.
 *
 * Async so metrics collection yields the event loop instead of blocking
 * WebSocket liveness / command handling on synchronous host I/O.
 */
export async function readProcFile(
  path: string,
): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    // Deno 2 blocks direct /proc reads under --allow-read; fall back to cat.
  }

  try {
    const { code, stdout } = await new Deno.Command("cat", {
      args: [path],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (code !== 0) return undefined;
    return new TextDecoder().decode(stdout);
  } catch {
    return undefined;
  }
}
