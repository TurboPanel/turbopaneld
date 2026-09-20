/**
 * The ports sshd actually listens on, read from `sshd -T` — the effective
 * configuration after every `Include`, `Match` and `ListenAddress addr:port`
 * is resolved — rather than from a hand parse of `sshd_config`. `sshd -T`
 * prints one `port N` line per listening port (and `listenaddress addr:port`
 * lines when an address pins a port of its own).
 *
 * This is the input to the renderer's sshd invariant, so it fails **open**:
 * when `sshd -T` cannot run (not installed, a config it refuses, no sudo) the
 * result is empty and the renderer keeps port 22 with a warning. Losing SSH is
 * the lockout this whole track guards against; an extra open port 22 on a host
 * that moved sshd elsewhere is a visible, fixable condition by comparison.
 */

import { isValidFirewallPort } from "../instance/commands/contracts.ts";
import { type FirewallRunFn, runFirewallHost } from "./run.ts";

export type SshdPortsResult = {
  ports: number[];
  /** Why the list is empty or incomplete, when it is. */
  warning?: string;
};

/** Pure: the ports `sshd -T` output names, sorted and deduplicated. */
export function parseSshdEffectivePorts(output: string): number[] {
  const ports = new Set<number>();
  for (const raw of output.split("\n")) {
    const line = raw.trim().toLowerCase();
    const portMatch = /^port\s+(\d{1,5})$/.exec(line);
    if (portMatch) {
      const port = Number.parseInt(portMatch[1]!, 10);
      if (isValidFirewallPort(port)) ports.add(port);
      continue;
    }
    // `listenaddress 0.0.0.0:2222` / `listenaddress [::1]:2222` pin a port
    // that `port` lines do not repeat.
    const listenMatch = /^listenaddress\s+(?:\[[^\]]+\]|[^:\s]+):(\d{1,5})$/
      .exec(line);
    if (listenMatch) {
      const port = Number.parseInt(listenMatch[1]!, 10);
      if (isValidFirewallPort(port)) ports.add(port);
    }
  }
  return [...ports].sort((a, b) => a - b);
}

export async function readSshdEffectivePorts(
  run: FirewallRunFn = runFirewallHost,
): Promise<SshdPortsResult> {
  const result = await run("sshd", ["-T"], { timeoutMs: 10_000 });
  // Unprivileged `sshd -T` exits 0 having printed nothing but "no hostkeys
  // available"; runFirewallHost retries it under `sudo -n` (sudoers grants
  // `/usr/sbin/sshd -T`), so reaching here with that text means sudo refused.
  if (!result.success || /no hostkeys available/i.test(result.stderr)) {
    return {
      ports: [],
      warning: `sshd -T failed (${
        result.stderr || result.stdout || `exit ${result.code}`
      }); the sshd port could not be detected`,
    };
  }
  const ports = parseSshdEffectivePorts(result.stdout);
  if (ports.length === 0) {
    return {
      ports,
      warning:
        "sshd -T printed no port line; the sshd port could not be detected",
    };
  }
  return { ports };
}
