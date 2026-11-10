/**
 * Route the daemon's root host commands through `tp-host`.
 *
 * On a managed host `/etc/sudoers.d/tp` no longer grants `install`, `rm`,
 * `chown`, `systemctl`, `useradd`, `iptables`, … directly — only
 * `<install>/lib/tp-host` (orchestration/scripts/tp-host), which accepts the
 * argument shapes below and nothing else. Every `sudo -n <cmd> …` call site
 * passes its argv through {@link hostSudoArgs}. In co-located development (a
 * dev user with full sudo) a verb that is also a host program runs that
 * program; a verb only tp-host has runs the checkout's own tp-host. When
 * already root on a managed install, the argv is unchanged.
 */
import { join } from "@std/path";
import { resolveLayout } from "../paths/layout.ts";
import { ORCHESTRATION_LAYOUT } from "../orchestration/assets.ts";
import { playbooksNeedRootHelper } from "../orchestration/privileged.ts";

/**
 * tp-host verbs that are also real host programs (`install`, `iptables`,
 * `useradd`, …). In development a bare `sudo -n <verb>` runs the program.
 */
export const HOST_PROGRAM_VERBS: ReadonlySet<string> = new Set([
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
  "groupmod",
  "useradd",
  "usermod",
  "gpasswd",
  "chpasswd",
  "getent",
  "modprobe",
]);

/**
 * tp-host verbs that exist nowhere else: no host program has the name, so they
 * run through tp-host in development too (the checkout's own script, with
 * every check it applies on a managed host).
 */
export const TP_HOST_ONLY_VERBS: ReadonlySet<string> = new Set([
  "sftp-chroot",
  "sshd-config",
  "principal-remove",
  "build-run",
  "build-return",
  "php-test",
  "cert-dates",
  "cert-export",
  "site-usage",
  "folder-list",
  "site-caddy-mounts",
  "publish-open",
  "publish",
  "publish-keep",
  "php-loopback-sync",
  "app-env-install",
  "app-env-remove",
  "tunnel-env-install",
  "tunnel-env-remove",
  "tunnel-loopback-sync",
  "panel-identity-write",
  "instance-cert-install",
  "instance-cert-prune",
]);

/** The commands tp-host implements. Keep in step with its dispatch. */
export const TP_HOST_VERBS: ReadonlySet<string> = new Set([
  ...HOST_PROGRAM_VERBS,
  ...TP_HOST_ONLY_VERBS,
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

/** The checkout's own tp-host (`<checkout>/orchestration/scripts/tp-host`). */
export function devTpHostPath(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  return join(
    resolveLayout(env, { forceMode: "development" }).orchestrationDir,
    "scripts",
    "tp-host",
  );
}

/**
 * `["-n", <verb>, …]` (optionally `["-n", "--", <verb>, …]`) becomes
 * `["-n", "--", <tp-host>, <verb>, …]` on a managed host. In development a
 * {@link TP_HOST_ONLY_VERBS} verb becomes
 * `["-n", "--", <checkout>/orchestration/scripts/tp-host, <verb>, …]`. Anything
 * else — `-u <self>` re-execs, docker, tp-orchestrate, engine config tests, a
 * host program verb in development, or a root process on a managed install —
 * is returned as given.
 */
export function hostSudoArgs(
  args: readonly string[],
  options: HostSudoOptions = {},
): string[] {
  if (args[0] !== "-n") return [...args];
  const at = args[1] === "--" ? 2 : 1;
  const verb = args[at];
  if (verb === undefined || !TP_HOST_VERBS.has(verb)) return [...args];
  if (playbooksNeedRootHelper(options)) {
    return ["-n", "--", tpHostPath(options.env), ...args.slice(at)];
  }
  const mode = options.installMode ?? ORCHESTRATION_LAYOUT.mode;
  if (mode === "development" && TP_HOST_ONLY_VERBS.has(verb)) {
    return ["-n", "--", devTpHostPath(options.env), ...args.slice(at)];
  }
  return [...args];
}
