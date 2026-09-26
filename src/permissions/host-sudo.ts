/**
 * Route the daemon's root host commands through `tp-host`.
 *
 * On a managed host `/etc/sudoers.d/tp` no longer grants `install`, `rm`,
 * `chown`, `systemctl`, `useradd`, `iptables`, … directly — only
 * `<install>/lib/tp-host` (orchestration/scripts/tp-host), which accepts the
 * argument shapes below and nothing else. Every `sudo -n <cmd> …` call site
 * passes its argv through {@link hostSudoArgs}; in co-located development (a
 * dev user with full sudo) and when already root, the argv is unchanged.
 */
import { join } from "@std/path";
import { resolveLayout } from "../paths/layout.ts";
import { playbooksNeedRootHelper } from "../orchestration/privileged.ts";

/** The commands tp-host implements. Keep in step with its dispatch. */
export const TP_HOST_VERBS: ReadonlySet<string> = new Set([
  "install",
  "mkdir",
  "cp",
  "mv",
  "rm",
  "ln",
  "readlink",
  "test",
  "cat",
  "cmp",
  "ls",
  "find",
  "chown",
  "chmod",
  "setfacl",
  "tee",
  "systemctl",
  "journalctl",
  "sshd",
  "ss",
  "sysctl",
  "iptables",
  "ip6tables",
  "iptables-restore",
  "ip6tables-restore",
  "iptables-save",
  "ip6tables-save",
  "ip",
  "wg",
  "groupadd",
  "useradd",
  "usermod",
  "gpasswd",
  "chpasswd",
  "getent",
]);

export type HostSudoOptions = Parameters<typeof playbooksNeedRootHelper>[0] & {
  env?: Record<string, string | undefined>;
};

/** Where the managed install keeps tp-host (the path sudoers names). */
export function tpHostPath(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  return join(resolveLayout(env).libDir, "tp-host");
}

/**
 * `["-n", <verb>, …]` (optionally `["-n", "--", <verb>, …]`) becomes
 * `["-n", "--", <tp-host>, <verb>, …]` on a managed host. Anything else —
 * `-u <self>` re-execs, docker, tp-orchestrate, engine config tests, or a
 * development / root process — is returned as given.
 */
export function hostSudoArgs(
  args: readonly string[],
  options: HostSudoOptions = {},
): string[] {
  if (args[0] !== "-n") return [...args];
  const at = args[1] === "--" ? 2 : 1;
  const verb = args[at];
  if (verb === undefined || !TP_HOST_VERBS.has(verb)) return [...args];
  if (!playbooksNeedRootHelper(options)) return [...args];
  return ["-n", "--", tpHostPath(options.env), ...args.slice(at)];
}
