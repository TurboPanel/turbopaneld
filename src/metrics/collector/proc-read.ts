function isReadBlocked(err: unknown): boolean {
  return err instanceof Deno.errors.PermissionDenied ||
    err instanceof Deno.errors.NotCapable;
}

/** `cat` only ever gets an absolute path with no traversal segments. */
function isFallbackPath(path: string): boolean {
  return path.startsWith("/") && !path.includes("\0") &&
    !path.split("/").includes("..");
}

/**
 * Read a `/proc` (or sysfs) file. Tries Deno direct read first, then `cat`
 * fallback — Deno 2 blocks direct `/proc` reads under `--allow-read`.
 *
 * Async so metrics collection yields the event loop instead of blocking
 * WebSocket liveness / command handling on synchronous host I/O.
 *
 * Optional `io` injects readers for host-free tests of the cat fallback.
 */
export async function readProcFile(
  path: string,
  io?: {
    readTextFile?: (path: string) => Promise<string>;
    runCat?: (
      path: string,
    ) => Promise<{ code: number; stdout: Uint8Array }>;
  },
): Promise<string | undefined> {
  const readText = io?.readTextFile ?? ((p) => Deno.readTextFile(p));
  try {
    return await readText(path);
  } catch (err) {
    // A missing file (absent PSI, conntrack, md, an exited pid) is final and
    // common; forking `cat` for it every tick is pure overhead.
    if (!isReadBlocked(err) || !isFallbackPath(path)) return undefined;
    // Deno 2 blocks direct /proc reads under --allow-read; fall back to cat.
  }

  try {
    const runCat = io?.runCat ?? ((p) =>
      new Deno.Command("cat", {
        args: [p],
        stdout: "piped",
        stderr: "null",
        // Scoped --allow-run=cat cannot inherit LD_* / DYLD_* (Deno 2.9).
        clearEnv: true,
      }).output());
    const { code, stdout } = await runCat(path);
    if (code !== 0) return undefined;
    return new TextDecoder().decode(stdout);
  } catch {
    return undefined;
  }
}
