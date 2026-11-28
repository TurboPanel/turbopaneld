/**
 * Test-only: point the daemon state directory at a temp folder for this test
 * file, so `handleCommandDispatch` can journal the commands it runs (a command
 * that cannot be journaled is refused). The folder is removed when the file's
 * tests finish.
 */
export function useTempCommandJournal(): string {
  const dir = Deno.makeTempDirSync({ prefix: "tp-command-journal-" });
  Deno.env.set("TURBOPANEL_STATE_DIR", dir);
  globalThis.addEventListener("unload", () => {
    try {
      Deno.removeSync(dir, { recursive: true });
    } catch {
      // Already gone.
    }
  });
  return dir;
}
