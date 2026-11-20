/**
 * Test-only: wrap a fake host runner so it sees `iptables` argv without the
 * leading `-w <seconds>` the daemon adds, after asserting the wait is there.
 * Every fabric iptables call except the `--version` probe must carry it.
 */

import { assertEquals } from "@std/assert";

export const EXPECTED_XTABLES_WAIT_ARGS = ["-w", "5"];

type RunFn<Result, Options> = (
  cmd: string,
  args: string[],
  options?: Options,
) => Promise<Result>;

export function stripXtablesWait<Result, Options>(
  run: RunFn<Result, Options>,
): RunFn<Result, Options> {
  return (cmd, args, options) => {
    if (cmd === "iptables" && args[0] !== "--version") {
      assertEquals(args.slice(0, 2), EXPECTED_XTABLES_WAIT_ARGS);
      return run(cmd, args.slice(2), options);
    }
    return run(cmd, args, options);
  };
}
