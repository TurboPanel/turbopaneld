/**
 * Count running processes by scanning numeric entries in `/proc`.
 *
 * Prefer this over `/proc/loadavg` field 4 (thread count including kernel
 * threads) and over `/proc/stat` `processes` (cumulative fork counter).
 *
 * Async (`Deno.readDir`) so metrics does not block the WebSocket event loop.
 * Optional `procDir` is for host-free tests with a fixture directory tree.
 */
export async function countProcessesInProc(
  procDir = "/proc",
): Promise<number | null> {
  try {
    let count = 0;
    for await (const entry of Deno.readDir(procDir)) {
      if (!entry.isDirectory) continue;
      if (/^\d+$/.test(entry.name)) count++;
    }
    return count;
  } catch {
    return null;
  }
}
