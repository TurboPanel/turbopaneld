/**
 * Where the daemon's root boundary sits on a managed host.
 *
 * Production `tp` has no `NOPASSWD:ALL`: `/etc/sudoers.d/tp` grants a fixed
 * list of host utilities plus the `tp-orchestrate` helper. Ansible playbooks
 * therefore cannot `become` from `tp` (that would need `sudo /bin/sh`) and
 * are run as root *through the helper*, which validates the playbook name
 * and extra-vars against the root-owned orchestration tree. Co-located
 * development keeps running `ansible-playbook` directly: the dev user has
 * full sudo and `become` works as before.
 */
import { ORCHESTRATE_HELPER, ORCHESTRATION_LAYOUT } from "./paths.ts";

export type PlaybookInvocation = { bin: string; args: string[] };

function currentUid(): number | null {
  try {
    return Deno.uid();
  } catch {
    return null;
  }
}

/**
 * True when playbooks must go through `sudo -n tp-orchestrate`: a managed
 * (production) install running as an unprivileged account. Root (the
 * installer's `run-installer` verb) and development checkouts run
 * ansible-playbook directly.
 */
export function playbooksNeedRootHelper(
  options: {
    installMode?: "development" | "production";
    uid?: number | null;
  } = {},
): boolean {
  const mode = options.installMode ?? ORCHESTRATION_LAYOUT.mode;
  if (mode !== "production") return false;
  const uid = options.uid === undefined ? currentUid() : options.uid;
  return uid !== 0;
}

/**
 * Rewrite an `ansible-playbook <args>` invocation for the active privilege
 * regime. Through the helper the argument list is preserved verbatim — the
 * helper re-validates it (`-i localhost,`, `-c local`, `-e key=value`, one
 * shipped playbook basename) before exec'ing ansible-playbook as root.
 */
export function privilegedPlaybookInvocation(
  ansiblePlaybookBin: string,
  args: string[],
  options: Parameters<typeof playbooksNeedRootHelper>[0] = {},
): PlaybookInvocation {
  if (!playbooksNeedRootHelper(options)) {
    return { bin: ansiblePlaybookBin, args };
  }
  return {
    bin: "sudo",
    args: ["-n", "--", ORCHESTRATE_HELPER, "playbook", ...args],
  };
}

/** `sudo -n tp-orchestrate galaxy-docker-role` — the root-owned role fetch. */
export function galaxyDockerRoleHelperInvocation(): PlaybookInvocation {
  return {
    bin: "sudo",
    args: ["-n", "--", ORCHESTRATE_HELPER, "galaxy-docker-role"],
  };
}
