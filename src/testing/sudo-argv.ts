/**
 * Test-only: undo the tp-host wrapper `hostSudoArgs` adds.
 *
 * In a checkout (development) a tp-host-only verb leaves as
 * `["-n", "--", <checkout>/orchestration/scripts/tp-host, <verb>, …]`; fakes
 * that answer by verb read it back as `["-n", <verb>, …]`. Any other argv is
 * returned as given.
 */
export function bareSudoArgs(args: readonly string[]): string[] {
  if (args[0] === "-n" && args[1] === "--" && args[2]?.endsWith("/tp-host")) {
    return ["-n", ...args.slice(3)];
  }
  return [...args];
}
