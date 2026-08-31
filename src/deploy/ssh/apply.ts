/**
 * Reconcile SSH access for the principals TurboPanel manages on this host.
 *
 * Two halves, in this order and for a reason:
 *
 * 1. **Key files.** Written before the drop-in, so the moment the `Match`
 *    blocks take effect the keys they authorize are already on disk. The other
 *    order gives a window where an account is matched but has nothing to
 *    present.
 * 2. **The `sshd` drop-in.** Staged, `sshd -t`-tested, swapped, reloaded, and
 *    **rolled back on any failure** — the same discipline the site engines use,
 *    except that here it is not a nicety. A bad `sshd_config` that survives a
 *    reload locks every administrator out of the box, and there is no second
 *    channel to fix it through.
 *
 * `reload`, never `restart`: a reload leaves established sessions alive, so
 * even a config that passes `-t` and then rejects every key does not evict the
 * operator who is watching it happen.
 */

import { dirname } from "@std/path";
import { logInfo, logWarn } from "../../logger.ts";
import { accessGroup } from "../../runtime/registry.ts";
import type { RunFn, RunResult } from "../ensure-principal.ts";
import {
  AUTHORIZED_KEYS_DIR,
  authorizedKeysContent,
  authorizedKeysPath,
  isKeyFileUsername,
} from "./authorized-keys.ts";
import {
  SSHD_CONFIG_PATH,
  SSHD_DROPIN_PATH,
  sshdAccessRestrictions,
  sshdConfigIncludesDropIns,
  sshdDropInContent,
} from "./sshd-config.ts";

/** One account's desired key set. `keys: []` is a revocation, not a no-op. */
export type PrincipalSshSpec = {
  username: string;
  keys: readonly string[];
};

export type SshApplyPaths = {
  authorizedKeysDir?: string;
  sshdConfigPath?: string;
  sshdDropInPath?: string;
  /**
   * Whether `principals` is the **complete** managed set for this host, and
   * therefore whether an account missing from it should have its key file
   * removed.
   *
   * This is not a tuning knob — it is the difference between a correct
   * revocation and a data-plane outage. A deploy payload describes **one
   * environment**, and a host serves many; pruning from it would delete the key
   * files of every principal belonging to every other environment on the box.
   * So `environment.deploy` passes `false` (write and update only) and
   * `server.principals.reconcile`, which carries the whole server, passes
   * `true`.
   *
   * Defaults to `false`: the safe answer for a caller that has not thought
   * about it is "do not delete anything".
   */
  prune?: boolean;
};

export type SshApplyResult = {
  /** Accounts whose key file was created or rewritten. */
  changedPrincipals: string[];
  /** Accounts whose key file was removed because they are no longer managed. */
  removedPrincipals: string[];
  /** True when the drop-in changed and `sshd` was reloaded. */
  sshdReloaded: boolean;
  /**
   * Host conditions that will stop a valid key from working and that TurboPanel
   * must not edit its way around. Surfaced, never silently repaired.
   */
  warnings: string[];
};

const decoder = new TextDecoder();

async function runDefault(command: string, args: string[]): Promise<RunResult> {
  const result = await new Deno.Command(command, {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    success: result.success,
    stdout: decoder.decode(result.stdout).trim(),
    stderr: decoder.decode(result.stderr).trim(),
  };
}

/** `sudo -n cat`, because the managed tree is root-owned and the daemon is not. */
async function readPrivileged(
  runFn: RunFn,
  path: string,
): Promise<string | null> {
  const result = await runFn("sudo", ["-n", "cat", "--", path]);
  return result.success ? result.stdout : null;
}

/**
 * Install `contents` at `path` as `root:root <mode>`, skipping a byte-identical
 * rewrite.
 *
 * The unchanged-content rule is what keeps a routine deploy from touching
 * `sshd` at all: nothing reloads unless the bytes genuinely moved.
 */
async function installRootFile(
  runFn: RunFn,
  path: string,
  contents: string,
  mode: string,
): Promise<boolean> {
  const staged = await Deno.makeTempFile({ prefix: "tp-ssh-" });
  try {
    await Deno.writeTextFile(staged, contents, { mode: 0o600 });
    const same = await runFn("sudo", ["-n", "cmp", "-s", "--", staged, path]);
    if (same.success) return false;
    const install = await runFn("sudo", [
      "-n",
      "install",
      "-m",
      mode,
      "-o",
      "root",
      "-g",
      "root",
      staged,
      path,
    ]);
    if (!install.success) {
      throw new Error(install.stderr || `Failed to install ${path}`);
    }
    return true;
  } finally {
    await Deno.remove(staged).catch(() => {});
  }
}

/**
 * Key files for accounts TurboPanel no longer manages.
 *
 * Containment comes from the directory rather than from per-file bookkeeping:
 * `/etc/ssh/turbopanel/authorized_keys/` is created by TurboPanel and holds
 * nothing else, so everything in it is ours by construction. Nothing outside it
 * is ever examined, which is why an administrator's own
 * `~/.ssh/authorized_keys` and `root`'s keys are untouchable from here no
 * matter what the payload says.
 *
 * A name that could not have been written by {@link authorizedKeysPath} is left
 * alone: if something unexpected is in the directory, deleting it is the wrong
 * guess.
 */
async function removeUnmanagedKeyFiles(
  runFn: RunFn,
  dir: string,
  managed: ReadonlySet<string>,
): Promise<string[]> {
  const listing = await runFn("sudo", ["-n", "ls", "-1", "--", dir]);
  if (!listing.success) return [];
  const removed: string[] = [];
  for (const name of listing.stdout.split("\n").map((line) => line.trim())) {
    if (name.length === 0 || managed.has(name)) continue;
    if (!isKeyFileUsername(name)) continue;
    const result = await runFn("sudo", [
      "-n",
      "rm",
      "-f",
      "--",
      `${dir}/${name}`,
    ]);
    // A failed removal is loud: an access grant that outlives its revocation is
    // a security problem, not an inconvenience.
    if (!result.success) {
      throw new Error(
        result.stderr || `Failed to remove stale key file for ${name}`,
      );
    }
    removed.push(name);
  }
  return removed;
}

/**
 * `sshd -t`, run against the whole configuration rather than the drop-in alone.
 *
 * There is no way to test a drop-in in isolation, and testing it in isolation
 * would miss the failure that matters most — a `Match` block interacting badly
 * with what the administrator wrote below the `Include` line.
 */
async function sshdConfigTest(runFn: RunFn): Promise<RunResult> {
  return await runFn("sudo", ["-n", "sshd", "-t"]);
}

/**
 * Reload whichever unit this distro calls its SSH daemon.
 *
 * Debian names it `ssh.service` and Red Hat `sshd.service`; on Debian `sshd`
 * exists only as an alias, and on a socket-activated host neither may be
 * running. Trying both and failing only if both fail is cheaper than probing.
 */
async function reloadSshd(runFn: RunFn): Promise<void> {
  const units = ["ssh.service", "sshd.service"];
  const errors: string[] = [];
  for (const unit of units) {
    const result = await runFn("sudo", ["-n", "systemctl", "reload", unit]);
    if (result.success) return;
    errors.push(result.stderr || `reload ${unit} failed`);
  }
  throw new Error(`Failed to reload sshd: ${errors.join("; ")}`);
}

/**
 * Write every managed account's key file and remove the rest.
 *
 * Split from the drop-in half so a host whose `sshd_config` has no `Include`
 * line still gets its keys reconciled — the keys are correct, they simply are
 * not consulted yet, and that is a better state to leave behind than neither.
 */
async function reconcileKeyFiles(
  runFn: RunFn,
  dir: string,
  principals: readonly PrincipalSshSpec[],
  prune: boolean,
): Promise<{ changed: string[]; removed: string[] }> {
  const mkdir = await runFn("sudo", [
    "-n",
    "install",
    "-d",
    "-m",
    // 0750, and every parent root-owned: `sshd` with `StrictModes` on refuses
    // an `AuthorizedKeysFile` whose path is group- or world-writable.
    // Traversal for the authenticating account is an ACL on tpsftp/tpshell
    // (principal-access role), not a world bit.
    "0750",
    "-o",
    "root",
    "-g",
    "root",
    dir,
  ]);
  if (!mkdir.success) {
    throw new Error(mkdir.stderr || `Failed to create ${dir}`);
  }

  const changed: string[] = [];
  for (const principal of principals) {
    const path = authorizedKeysPath(principal.username, dir);
    // Throws on a key that is not in canonical form — see
    // `authorizedKeysContent`. Failing the reconcile is deliberate: a silently
    // dropped key is an account that half-works, and a silently kept one is
    // worse.
    const contents = authorizedKeysContent(principal.keys);
    if (await installRootFile(runFn, path, contents, "0644")) {
      changed.push(principal.username);
    }
  }

  // Only when the caller holds the whole host. See `SshApplyPaths.prune`.
  const removed = prune
    ? await removeUnmanagedKeyFiles(
      runFn,
      dir,
      new Set(principals.map((principal) => principal.username)),
    )
    : [];
  return { changed, removed };
}

/**
 * Stage, test, publish, and reload the drop-in — rolling back to the previous
 * bytes if `sshd -t` refuses the result.
 *
 * The test runs **after** the swap because `sshd -t` reads the real
 * `sshd_config` and follows its `Include`; there is no flag that points it at a
 * candidate tree. So the window between publish and test is unavoidable, and
 * the rollback is what makes it survivable: nothing has been reloaded yet, so a
 * refused config never reaches a running daemon.
 */
async function reconcileDropIn(
  runFn: RunFn,
  dropInPath: string,
  contents: string,
): Promise<boolean> {
  const backup = `${dropInPath}.tpprev`;
  const existing = await readPrivileged(runFn, dropInPath);
  if (existing !== null) {
    const snapshot = await runFn("sudo", [
      "-n",
      "cp",
      "-p",
      "--",
      dropInPath,
      backup,
    ]);
    if (!snapshot.success) {
      throw new Error(
        snapshot.stderr || `Failed to snapshot ${dropInPath} before rewriting`,
      );
    }
  }

  const mkdir = await runFn("sudo", [
    "-n",
    "install",
    "-d",
    "-m",
    "0755",
    "-o",
    "root",
    "-g",
    "root",
    dirname(dropInPath),
  ]);
  if (!mkdir.success) {
    throw new Error(mkdir.stderr || `Failed to create ${dirname(dropInPath)}`);
  }

  if (!await installRootFile(runFn, dropInPath, contents, "0644")) {
    await runFn("sudo", ["-n", "rm", "-f", "--", backup]);
    return false;
  }

  const test = await sshdConfigTest(runFn);
  if (!test.success) {
    // Put the host back exactly as it was before failing. Leaving a rejected
    // drop-in in place would break the next unrelated `systemctl reload ssh`,
    // by anyone, for any reason.
    if (existing === null) {
      await runFn("sudo", ["-n", "rm", "-f", "--", dropInPath]);
    } else {
      await runFn("sudo", ["-n", "mv", "-f", "--", backup, dropInPath]);
    }
    throw new Error(
      `sshd rejected the TurboPanel configuration, and it has been rolled back: ${
        test.stderr || test.stdout || "sshd -t failed"
      }`,
    );
  }

  await reloadSshd(runFn);
  await runFn("sudo", ["-n", "rm", "-f", "--", backup]);
  return true;
}

/**
 * Reconcile this host's SSH access to exactly what the payload describes.
 *
 * With `prune: true`, `principals` is the **complete** managed set for this
 * host and an account missing from it has its key file removed — the same
 * containment doctrine as runtime entitlements: the control plane resolves the
 * effective set, the daemon reconciles to it, and "absent" is a real
 * instruction rather than an absence of one. A caller that holds only part of
 * the host (a deploy, which describes one environment) must leave `prune` off,
 * or it will revoke every other environment's access. See `SshApplyPaths`.
 */
export async function applySshAccess(
  principals: readonly PrincipalSshSpec[],
  paths: SshApplyPaths = {},
  runFn: RunFn = runDefault,
): Promise<SshApplyResult> {
  const dir = paths.authorizedKeysDir ?? AUTHORIZED_KEYS_DIR;
  const sshdConfigPath = paths.sshdConfigPath ?? SSHD_CONFIG_PATH;
  const dropInPath = paths.sshdDropInPath ?? SSHD_DROPIN_PATH;

  const { changed, removed } = await reconcileKeyFiles(
    runFn,
    dir,
    principals,
    paths.prune ?? false,
  );

  const warnings: string[] = [];
  const sshdConfig = await readPrivileged(runFn, sshdConfigPath);
  if (sshdConfig === null) {
    throw new Error(
      `Could not read ${sshdConfigPath}; SSH access cannot be configured on this host`,
    );
  }
  if (!sshdConfigIncludesDropIns(sshdConfig)) {
    // Never repaired. Editing an administrator's `sshd_config` so that our own
    // file starts taking effect is not a move a hosting panel makes silently.
    throw new Error(
      `${sshdConfigPath} does not include ${
        dirname(dropInPath)
      } before its first Match block. Add \`Include ${
        dirname(dropInPath)
      }/*.conf\` near the top of that file, then retry.`,
    );
  }
  for (const directive of sshdAccessRestrictions(sshdConfig)) {
    warnings.push(
      `${sshdConfigPath} sets \`${directive}\`, which is evaluated before any Match block. TurboPanel principals will be refused until they are permitted there.`,
    );
  }

  const sftpGroup = accessGroup("sftp");
  const shellGroup = accessGroup("shell");
  const passwordGroup = accessGroup("password");
  if (!sftpGroup || !shellGroup || !passwordGroup) {
    throw new Error("runtime registry is missing an SSH access group");
  }

  const sshdReloaded = await reconcileDropIn(
    runFn,
    dropInPath,
    sshdDropInContent({
      sftpGroup,
      shellGroup,
      passwordGroup,
      authorizedKeysDir: dir,
    }),
  );

  for (const warning of warnings) logWarn("deploy", warning);
  if (changed.length > 0 || removed.length > 0 || sshdReloaded) {
    logInfo(
      "deploy",
      `ssh access reconciled: ${changed.length} updated, ${removed.length} removed${
        sshdReloaded ? ", sshd reloaded" : ""
      }`,
    );
  }

  return {
    changedPrincipals: changed,
    removedPrincipals: removed,
    sshdReloaded,
    warnings,
  };
}
