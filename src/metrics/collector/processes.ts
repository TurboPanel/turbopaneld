/**
 * Count running processes by scanning numeric entries in `/proc`.
 *
 * Prefer this over `/proc/loadavg` field 4 (thread count including kernel
 * threads) and over `/proc/stat` `processes` (cumulative fork counter).
 *
 * Tries `Deno.readDir` first, then `ls -1` — Deno 2 blocks direct `/proc`
 * directory listing under `--allow-read` the same way it blocks
 * `readTextFile` (see `readProcFile`'s `cat` fallback).
 *
 * Async so metrics does not block the WebSocket event loop.
 * Optional `procDir` is for host-free tests with a fixture directory tree.
 * Optional `io` injects readers for host-free tests of the ls fallback.
 */

function countNumericProcNames(names: Iterable<string>): number {
  let count = 0;
  for (const name of names) {
    if (/^\d+$/.test(name)) count++;
  }
  return count;
}

export async function countProcessesInProc(
  procDir = "/proc",
  io?: {
    readDir?: (
      path: string,
    ) => AsyncIterable<{ name: string; isDirectory: boolean }>;
    runLs?: (
      path: string,
    ) => Promise<{ code: number; stdout: Uint8Array }>;
  },
): Promise<number | null> {
  try {
    const readDir = io?.readDir ?? ((path) => Deno.readDir(path));
    const names: string[] = [];
    for await (const entry of readDir(procDir)) {
      if (!entry.isDirectory) continue;
      names.push(entry.name);
    }
    return countNumericProcNames(names);
  } catch {
    // Deno 2 blocks direct /proc directory listing under --allow-read;
    // fall back to ls, matching readProcFile's cat fallback.
  }

  try {
    const runLs = io?.runLs ?? ((path) =>
      new Deno.Command("ls", {
        args: ["-1", path],
        stdout: "piped",
        stderr: "null",
        // Scoped --allow-run=ls cannot inherit LD_* / DYLD_* (Deno 2.9).
        clearEnv: true,
      }).output());
    const { code, stdout } = await runLs(procDir);
    if (code !== 0) return null;
    return countNumericProcNames(
      new TextDecoder().decode(stdout).split("\n"),
    );
  } catch {
    return null;
  }
}
