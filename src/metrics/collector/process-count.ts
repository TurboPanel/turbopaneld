/**
 * Count running processes by scanning numeric entries in `/proc`.
 *
 * Prefer this over `/proc/loadavg` field 4 (thread count including kernel
 * threads) and over `/proc/stat` `processes` (cumulative fork counter).
 *
 * Async (`Deno.readDir`) so metrics does not block the WebSocket event loop.
 */
export async function countProcessesInProc(): Promise<number | null> {
  try {
    let count = 0;
    for await (const entry of Deno.readDir("/proc")) {
      if (!entry.isDirectory) continue;
      if (/^\d+$/.test(entry.name)) count++;
    }
    return count;
  } catch {
    return null;
  }
}
