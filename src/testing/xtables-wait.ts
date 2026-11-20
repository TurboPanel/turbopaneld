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

const violations: string[] = [];

/**
 * Fail if any wrapped runner saw an iptables call without the wait. The
 * wrapper records instead of only throwing, because a best-effort caller can
 * catch the throw; call this after the run.
 */
export function assertXtablesWaitHonoured(): void {
  const seen = violations.splice(0);
  assertEquals(seen, [], "iptables calls missing -w 5");
}

export function stripXtablesWait<Result, Options>(
  run: RunFn<Result, Options>,
): RunFn<Result, Options> {
  return (cmd, args, options) => {
    if (cmd === "iptables" && args[0] !== "--version") {
      if (
        args[0] !== EXPECTED_XTABLES_WAIT_ARGS[0] ||
        args[1] !== EXPECTED_XTABLES_WAIT_ARGS[1]
      ) {
        violations.push(args.join(" "));
        return run(cmd, args, options);
      }
      return run(cmd, args.slice(2), options);
    }
    return run(cmd, args, options);
  };
}
