import { hostSudoArgs } from "../permissions/host-sudo.ts";
/**
 * Host command runner for the firewall module (`iptables`, `ip6tables`, their
 * `-restore` / `-save` twins, `sshd`, `systemctl`).
 *
 * Same shape as the private runner in `../commands/fabric.ts` —
 * direct spawn, then `sudo -n` on a permission error — with one difference on
 * purpose: every xtables invocation carries `-w 5`. Docker holds the xtables
 * lock while it mutates its chains, and a concurrent call without `-w` fails
 * with "Another app is currently holding the xtables lock"; the older fabric
 * and managed-listener code does not wait, which is a latent flake this
 * module does not inherit.
 *
 * Test seams: {@link setFirewallRunForTests} installs a fake runner;
 * {@link setFirewallSkipRealSyscallsForTests} makes every call a silent
 * success. Both are cleared by {@link resetFirewallRunOverrides}.
 */

export type FirewallRunResult = {
  success: boolean;
  code: number;
  stdout: string;
  stderr: string;
};

export type FirewallRunOptions = { stdin?: string; timeoutMs?: number };

export type FirewallRunFn = (
  cmd: string,
  args: string[],
  options?: FirewallRunOptions,
) => Promise<FirewallRunResult>;

/** Binaries that take the xtables lock and therefore get `-w`. */
const XTABLES_BINARIES = new Set([
  "iptables",
  "ip6tables",
  "iptables-restore",
  "ip6tables-restore",
  "iptables-save",
  "ip6tables-save",
]);

/** Seconds to wait for the xtables lock. */
export const XTABLES_LOCK_WAIT_SECONDS = 5;

/** Default wall-clock bound on any one host command. */
export const FIREWALL_COMMAND_TIMEOUT_MS = 30_000;

let runOverride: FirewallRunFn | null = null;
let skipRealSyscalls = false;

export function setFirewallRunForTests(fn: FirewallRunFn | null): void {
  runOverride = fn;
}

export function setFirewallSkipRealSyscallsForTests(skip: boolean): void {
  skipRealSyscalls = skip;
}

export function resetFirewallRunOverrides(): void {
  runOverride = null;
  skipRealSyscalls = false;
}

/**
 * "Try again as root." Besides the two kernel/libc spellings, `sshd -T` run
 * by an unprivileged user says `no hostkeys available -- exiting` — it could
 * not read `/etc/ssh/ssh_host_*_key`, which is a permission failure in sshd's
 * own words (proven on Debian 13: exit 0, that line on stderr, no config).
 */
export function isPermissionDeniedText(result: FirewallRunResult): boolean {
  const text = `${result.stderr} ${result.stdout}`.toLowerCase();
  return text.includes("permission denied") ||
    text.includes("operation not permitted") ||
    text.includes("no hostkeys available");
}

/** "That chain / rule is not there" in every spelling iptables uses. */
export function isMissingRuleText(result: FirewallRunResult): boolean {
  const text = `${result.stderr} ${result.stdout}`.toLowerCase();
  return text.includes("no such chain") ||
    text.includes("no chain/target/match") ||
    text.includes("does not exist") ||
    text.includes("bad rule") ||
    text.includes("rule doesn't exist") ||
    text.includes("can't find");
}

export function isMissingBinaryText(result: FirewallRunResult): boolean {
  const text = `${result.stderr} ${result.stdout}`.toLowerCase();
  return result.code === 127 && (
    text.includes("no such file") ||
    text.includes("not found") ||
    text.includes("spawn failed")
  );
}

async function spawnCommand(
  cmd: string,
  args: string[],
  options?: FirewallRunOptions,
): Promise<FirewallRunResult> {
  try {
    const hasStdin = options?.stdin !== undefined;
    const child = new Deno.Command(cmd, {
      args,
      stdin: hasStdin ? "piped" : "null",
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(
        options?.timeoutMs ?? FIREWALL_COMMAND_TIMEOUT_MS,
      ),
    }).spawn();
    if (hasStdin) {
      const writer = child.stdin.getWriter();
      try {
        const payload = options!.stdin!;
        await writer.write(
          new TextEncoder().encode(
            payload.endsWith("\n") ? payload : `${payload}\n`,
          ),
        );
      } finally {
        await writer.close();
      }
    }
    const output = await child.output();
    return {
      success: output.success,
      code: output.code,
      stdout: new TextDecoder().decode(output.stdout).trim(),
      stderr: new TextDecoder().decode(output.stderr).trim(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      code: 127,
      stdout: "",
      stderr: `spawn failed: ${message}`,
    };
  }
}

/**
 * Run a host command, `sudo -n` on a permission error. Xtables binaries get
 * `-w <seconds>` prepended so the call waits for Docker rather than failing
 * on its lock.
 */
export async function runFirewallHost(
  cmd: string,
  args: string[],
  options?: FirewallRunOptions,
): Promise<FirewallRunResult> {
  const finalArgs = XTABLES_BINARIES.has(cmd)
    ? ["-w", String(XTABLES_LOCK_WAIT_SECONDS), ...args]
    : args;
  if (runOverride) return await runOverride(cmd, finalArgs, options);
  if (skipRealSyscalls) {
    return { success: true, code: 0, stdout: "", stderr: "" };
  }
  const direct = await spawnCommand(cmd, finalArgs, options);
  if (direct.success || !isPermissionDeniedText(direct)) return direct;
  return await spawnCommand(
    "sudo",
    hostSudoArgs(["-n", cmd, ...finalArgs]),
    options,
  );
}
