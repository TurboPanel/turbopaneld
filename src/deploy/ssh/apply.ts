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
import { hostSudoArgs } from "../../permissions/host-sudo.ts";
import { logInfo, logWarn } from "../../util/logger.ts";
import { forEachSequential } from "../../util/sequential.ts";
import { accessGroup } from "../../runtime/registry.ts";
import { playbooksNeedRootHelper } from "../../orchestration/privileged.ts";
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
  SSHD_SAMPLE_NAME,
  sshdAccessRestrictions,
  sshdConfigIncludesDropIns,
  sshdDropInContent,
  sshdEffectiveSpec,
  sshdForwardingViolations,
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
  /**
   * Whether root is reached through `tp-host`, which owns the SFTP chroot
   * switch. Off (a development host, or a daemon already running as root)
   * there is no switch and nothing is jailed. Defaults to
   * {@link playbooksNeedRootHelper}.
   */
  tpHostManaged?: boolean;
};

export type SshApplyResult = {
  /** Accounts whose key file was created or rewritten. */
  changedPrincipals: string[];
  /** Accounts whose key file was removed because they are no longer managed. */
  removedPrincipals: string[];
  /** True when the drop-in changed and `sshd` was reloaded. */
  sshdReloaded: boolean;
  /** True when the drop-in jails `tpsftp` members (the host's switch is on). */
  sftpChroot: boolean;
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
  const result = await runFn("sudo", hostSudoArgs(["-n", "cat", "--", path]));
  return result.success ? result.stdout : null;
}

/**
 * An `sshd` config file — the administrator's `sshd_config` or our drop-in —
 * read directly when it is readable (both are `root:root 0644`) and through
 * `sudo` only when it is not.
 *
 * Direct first because tp-host's `cat` serves only TurboPanel's own trees and
 * refuses both paths: the privileged read alone failed every SSH reconcile on
 * a managed host, and made every existing drop-in look absent, so a refused
 * rewrite "rolled back" by deleting it.
 */
async function readSshdFile(
  runFn: RunFn,
  path: string,
): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return await readPrivileged(runFn, path);
  }
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
    const same = await runFn(
      "sudo",
      hostSudoArgs(["-n", "cmp", "-s", "--", staged, path]),
    );
    if (same.success) return false;
    const install = await runFn(
      "sudo",
      hostSudoArgs([
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
      ]),
    );
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
  const listing = await runFn(
    "sudo",
    hostSudoArgs(["-n", "ls", "-1", "--", dir]),
  );
  if (!listing.success) return [];
  const removed: string[] = [];
  const names = listing.stdout.split("\n").map((line) => line.trim());
  await forEachSequential(names, async (name) => {
    if (name.length === 0 || managed.has(name)) return;
    if (!isKeyFileUsername(name)) return;
    const result = await runFn(
      "sudo",
      hostSudoArgs([
        "-n",
        "rm",
        "-f",
        "--",
        `${dir}/${name}`,
      ]),
    );
    // A failed removal is loud: an access grant that outlives its revocation is
    // a security problem, not an inconvenience.
    if (!result.success) {
      throw new Error(
        result.stderr || `Failed to remove stale key file for ${name}`,
      );
    }
    removed.push(name);
  });
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
  return await runFn("sudo", hostSudoArgs(["-n", "sshd", "-t"]));
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
    const result = await runFn(
      "sudo",
      hostSudoArgs(["-n", "systemctl", "reload", unit]),
    );
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
  const mkdir = await runFn(
    "sudo",
    hostSudoArgs([
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
    ]),
  );
  if (!mkdir.success) {
    throw new Error(mkdir.stderr || `Failed to create ${dir}`);
  }

  const changed: string[] = [];
  await forEachSequential(principals, async (principal) => {
    const path = authorizedKeysPath(principal.username, dir);
    // Throws on a key that is not in canonical form — see
    // `authorizedKeysContent`. Failing the reconcile is deliberate: a silently
    // dropped key is an account that half-works, and a silently kept one is
    // worse.
    const contents = authorizedKeysContent(principal.keys);
    if (await installRootFile(runFn, path, contents, "0644")) {
      changed.push(principal.username);
    }
  });

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

/** An effective-config assertion run after `sshd -t`, before any reload. */
type Verifier = {
  run: () => Promise<RunResult>;
  refusal: string;
  fallback: string;
};

/** Members of `group`: supplementary (`getent group`) and primary (`getent passwd`). */
function groupMembers(
  group: string,
  groupLine: string,
  passwd: string,
): string[] {
  const parts = groupLine.trim().split(":");
  if (parts[0] !== group) return [];
  const members = (parts[3] ?? "").split(",");
  for (const entry of passwd.split("\n")) {
    const fields = entry.split(":");
    if (fields[3] === parts[2]) members.push(fields[0]);
  }
  return members.filter((name) => SSHD_SAMPLE_NAME.test(name)).sort();
}

/**
 * One real account per access level to ask `sshd -T` about: the first sftp
 * member, the first shell member, and the first principal in neither. `Match
 * Group` resolves groups from the account database, so a made-up user name
 * would match nothing and prove nothing; a level with no account has nothing
 * to leak and is skipped. Read with plain `getent`, no root needed.
 */
async function sampleAccounts(runFn: RunFn): Promise<string[]> {
  const sftp = accessGroup("sftp");
  const shell = accessGroup("shell");
  const principal = accessGroup("principal");
  if (!sftp || !shell || !principal) return [];
  const passwd = (await runFn("getent", ["passwd"])).stdout;
  const members = async (group: string) => {
    const line = await runFn("getent", ["group", group]);
    return line.success ? groupMembers(group, line.stdout, passwd) : [];
  };
  const [sftpOnes, shellOnes, principalOnes] = await Promise.all([
    members(sftp),
    members(shell),
    members(principal),
  ]);
  const leveled = new Set([...sftpOnes, ...shellOnes]);
  const bare = principalOnes.filter((name) => !leveled.has(name));
  return [sftpOnes[0], shellOnes[0], bare[0]].filter((name) =>
    name !== undefined
  );
}

/**
 * Refuse a drop-in (or an administrator's earlier one that outranks it) under
 * which any sampled account would still be able to forward. Fails closed: an
 * `sshd -T` that cannot answer is a refusal, not a pass.
 */
async function assertForwardingOff(runFn: RunFn): Promise<RunResult> {
  const findings: string[] = [];
  const samples = [...new Set(await sampleAccounts(runFn))];
  const results = await Promise.all(samples.map(async (user) => ({
    user,
    result: await runFn(
      "sudo",
      hostSudoArgs(["-n", "sshd", "-T", "-C", sshdEffectiveSpec(user)]),
    ),
  })));
  for (const { user, result } of results) {
    if (!result.success) {
      findings.push(`${user}: sshd -T failed`);
      continue;
    }
    for (const finding of sshdForwardingViolations(result.stdout)) {
      findings.push(`${user}: ${finding}`);
    }
  }
  return findings.length === 0
    ? { success: true, stdout: "", stderr: "" }
    : { success: false, stdout: findings.join("; "), stderr: "" };
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
  verifiers: readonly Verifier[] = [],
): Promise<boolean> {
  const backup = `${dropInPath}.tpprev`;
  const existing = await readSshdFile(runFn, dropInPath);
  if (existing !== null) {
    const snapshot = await runFn(
      "sudo",
      hostSudoArgs([
        "-n",
        "cp",
        "-p",
        "--",
        dropInPath,
        backup,
      ]),
    );
    if (!snapshot.success) {
      throw new Error(
        snapshot.stderr || `Failed to snapshot ${dropInPath} before rewriting`,
      );
    }
  }

  const mkdir = await runFn(
    "sudo",
    hostSudoArgs([
      "-n",
      "install",
      "-d",
      "-m",
      "0755",
      dirname(dropInPath),
    ]),
  );
  if (!mkdir.success) {
    throw new Error(mkdir.stderr || `Failed to create ${dirname(dropInPath)}`);
  }

  if (!await installRootFile(runFn, dropInPath, contents, "0644")) {
    await runFn("sudo", hostSudoArgs(["-n", "rm", "-f", "--", backup]));
    return false;
  }

  // Put the host back exactly as it was before a refused swap. Leaving a
  // rejected drop-in in place would break the next unrelated
  // `systemctl reload ssh`, by anyone, for any reason.
  const restore = () =>
    existing === null
      ? runFn("sudo", hostSudoArgs(["-n", "rm", "-f", "--", dropInPath]))
      : runFn(
        "sudo",
        hostSudoArgs(["-n", "mv", "-f", "--", backup, dropInPath]),
      );

  const test = await sshdConfigTest(runFn);
  if (!test.success) {
    await restore();
    throw new Error(
      `sshd rejected the TurboPanel configuration, and it has been rolled back: ${
        test.stderr || test.stdout || "sshd -t failed"
      }`,
    );
  }
  for (const verifier of verifiers) {
    const effective = await verifier.run();
    if (!effective.success) {
      await restore();
      throw new Error(
        `${verifier.refusal}, and the change has been rolled back: ${
          effective.stdout || effective.stderr || verifier.fallback
        }`,
      );
    }
  }

  await reloadSshd(runFn);
  await runFn("sudo", hostSudoArgs(["-n", "rm", "-f", "--", backup]));
  return true;
}

type SftpChroot = { root: string | null; warnings: string[] };

/** `on <absolute root>` or `off`; anything else is not an answer. */
function parseSftpChrootStatus(stdout: string): string | null | undefined {
  const status = stdout.trim();
  if (status === "off") return null;
  const match = /^on (\/[A-Za-z0-9._/-]+)$/.exec(status);
  return match ? match[1] : undefined;
}

/**
 * Is this host's SFTP chroot switch on, under which root, and does every
 * `tpsftp` member still pass the layout check `tp-host sftp-chroot on` ran?
 *
 * Only `tp-host` turns the switch on, and only after that check passes, so the
 * daemon never decides to jail anyone. The root comes from `tp-host` too — the
 * root it validated — never from the daemon's own environment. An unreadable
 * switch aborts the reconcile: rendering the unjailed block because `sudo`
 * hiccuped would fail open. A later finding (a member whose home drifted off
 * the layout) keeps the jail and becomes a warning: that member's logins fail
 * closed until the home is fixed.
 */
async function readSftpChroot(
  runFn: RunFn,
  managed: boolean,
): Promise<SftpChroot> {
  if (!managed) return { root: null, warnings: [] };
  const status = await runFn(
    "sudo",
    hostSudoArgs(["-n", "sftp-chroot", "status"]),
  );
  const root = status.success
    ? parseSftpChrootStatus(status.stdout)
    : undefined;
  if (root === undefined) {
    throw new Error(
      `Could not read the SFTP chroot switch; SSH access was not changed: ${
        status.stderr || status.stdout || "no answer"
      }`,
    );
  }
  if (root === null) return { root, warnings: [] };
  const check = await runFn(
    "sudo",
    hostSudoArgs(["-n", "sftp-chroot", "check"]),
  );
  if (check.success) return { root, warnings: [] };
  const findings = (check.stdout || check.stderr || "layout check failed")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return {
    root,
    warnings: findings.map((finding) =>
      `SFTP chroot is on, but ${finding}. That member cannot sign in until its home is back on the layout.`
    ),
  };
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
  const sshdConfig = await readSshdFile(runFn, sshdConfigPath);
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

  const chroot = await readSftpChroot(
    runFn,
    paths.tpHostManaged ?? playbooksNeedRootHelper(),
  );
  warnings.push(...chroot.warnings);

  const sftpGroup = accessGroup("sftp");
  const shellGroup = accessGroup("shell");
  const passwordGroup = accessGroup("password");
  const principalGroup = accessGroup("principal");
  if (!sftpGroup || !shellGroup || !passwordGroup || !principalGroup) {
    throw new Error("runtime registry is missing an SSH access group");
  }

  const sshdReloaded = await reconcileDropIn(
    runFn,
    dropInPath,
    sshdDropInContent({
      sftpGroup,
      shellGroup,
      passwordGroup,
      principalGroup,
      authorizedKeysDir: dir,
      ...(chroot.root === null ? {} : { sftpChrootRoot: chroot.root }),
    }),
    [
      {
        run: () => assertForwardingOff(runFn),
        refusal: "sshd would still allow forwarding as configured",
        fallback: "forwarding check failed",
      },
      ...(chroot.root === null ? [] : [{
        run: () => runFn("sudo", hostSudoArgs(["-n", "sftp-chroot", "verify"])),
        refusal: "sshd would not jail SFTP members as configured",
        fallback: "sftp-chroot verify failed",
      }]),
    ],
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
    sftpChroot: chroot.root !== null,
    warnings,
  };
}
