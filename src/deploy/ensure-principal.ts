import { join } from "@std/path";
import { logWarn } from "../logger.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import {
  allAccessGroups,
  allManagedGroups,
  isRuntimeName,
  runtimeGroup,
} from "../runtime/registry.ts";

export type PrincipalEnsureSpec = {
  principalId: string;
  username: string;
  uid?: number;
  gid?: number;
  home?: string;
  shell?: string;
  /**
   * Runtimes this principal may execute, as `{ runtime, series }` pairs. The
   * **effective** set (explicit operator grants plus what its services imply),
   * resolved control-plane side — the daemon reconciles, it does not derive.
   */
  runtimes?: readonly { runtime: string; series: string }[];
  /**
   * SSH access groups this principal should hold (`tpsftp` / `tpshell`), or
   * `[]` for an account that may not log in.
   *
   * Resolved control-plane side from the account's shell *and* whether it holds
   * any key, for the same reason `runtimes` is: the daemon reconciles a stated
   * set rather than deriving one, so there is exactly one place that decides.
   * Same containment rule too — a name outside the registry is refused, not
   * created.
   */
  accessGroups?: readonly string[];
  /**
   * Canonical `<type> <base64>` public keys, already parsed and re-rendered by
   * the control plane. `undefined` means "this payload says nothing about
   * keys"; `[]` means "this account has none" and **revokes** every key it had.
   *
   * The daemon re-validates shape before writing — see `./ssh/authorized-keys.ts`
   * — because these lines land in a file `sshd` authenticates against, and a
   * control plane that was compromised or simply out of date is exactly the
   * case the second check is for.
   */
  sshKeys?: readonly string[];
};

export const DEFAULT_PRINCIPAL_SHELL = "/usr/sbin/nologin";

/**
 * Shells a principal may be given. The daemon re-validates rather than trusting
 * the wire: `shell` reaches `useradd -s` / `usermod -s`, and
 * {@link ensurePrincipalUser} will reconcile an **adopted** account's shell to
 * whatever it is handed — so a control plane that was compromised, out of date,
 * or simply wrong could otherwise repoint an existing account at any executable.
 *
 * Keep in step with `ALLOWED_PRINCIPAL_SHELLS` in the instance's
 * `src/lib/principal-options.ts` and the wire validator in
 * `../instance/commands/contracts.ts`.
 */
export const ALLOWED_PRINCIPAL_SHELLS: readonly string[] = [
  "/usr/sbin/nologin",
  "/sbin/nologin",
  "/bin/false",
  "/bin/sh",
  "/bin/bash",
];

const PRINCIPAL_USERNAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
/**
 * Cap so `${username}-grp` fits the Linux 32-char group-name limit.
 * Keep in sync with instance `MAX_PRINCIPAL_USERNAME_LENGTH`.
 */
const MAX_PRINCIPAL_USERNAME_LENGTH = 28;

/**
 * Primary group name created by {@link ensureSystemPrincipals}
 * (`groupadd … ${username}-grp`).
 */
export function principalUnixGroupName(username: string): string {
  return `${username}-grp`;
}

export type RunResult = {
  success: boolean;
  stdout: string;
  stderr: string;
};

export type RunFn = (
  command: string,
  args: string[],
) => Promise<RunResult>;

const decoder = new TextDecoder();

async function runDefault(
  command: string,
  args: string[],
): Promise<RunResult> {
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

function assertSafeAbsolutePath(value: string, label: string): string {
  if (
    value.length === 0 ||
    value.length > 255 ||
    !value.startsWith("/") ||
    /\s/.test(value) ||
    value.includes("\0") ||
    value.includes("\n") ||
    value.split("/").includes("..")
  ) {
    throw new Error(`Invalid principal ${label}: ${value}`);
  }
  return value;
}

function assertSafePrincipalUsername(username: string): string {
  if (
    username.length === 0 ||
    username.length > MAX_PRINCIPAL_USERNAME_LENGTH ||
    !PRINCIPAL_USERNAME_RE.test(username)
  ) {
    throw new Error(`Invalid principal username: ${username}`);
  }
  return username;
}

/**
 * Parse UID (field 2), GID (field 3), home (field 5), and shell (field 6)
 * from a `getent passwd` line.
 */
export function parsePasswdHomeShell(
  passwdLine: string,
): { uid: number; gid: number; home: string; shell: string } | null {
  const fields = passwdLine.split(":");
  if (fields.length < 7) return null;
  const uid = Number(fields[2]);
  const gid = Number(fields[3]);
  const home = fields[5] ?? "";
  const shell = fields[6] ?? "";
  if (
    !Number.isInteger(uid) ||
    !Number.isInteger(gid) ||
    home.length === 0 ||
    shell.length === 0
  ) {
    return null;
  }
  return { uid, gid, home, shell };
}

/**
 * Parse GID (field 2) from a `getent group` line
 * (`name:passwd:GID:memberlist`).
 */
export function parseGroupGid(groupLine: string): number | null {
  const fields = groupLine.split(":");
  if (fields.length < 3) return null;
  const gid = Number(fields[2]);
  if (!Number.isInteger(gid)) return null;
  return gid;
}

/**
 * Privileged directory creation — the single `sudo -n install -d` seam.
 *
 * Exported so callers that need a directory the principal must **not** own
 * (a root-owned `releases/`, for instance) reuse this rather than inventing a
 * second privileged mkdir. `owner` is `user` or `user:group`; both accept
 * numeric ids, which is how a caller names the daemon's own account without
 * knowing its username.
 *
 * `install -d` is idempotent and also *repairs*: an existing directory is
 * re-chowned and re-chmoded to the requested owner and mode, so a tree created
 * by an older layout converges on the next deploy.
 */
export async function ensureDirectoryWithOwner(
  path: string,
  mode: string,
  owner: string,
  runFn: RunFn = runDefault,
): Promise<void> {
  await ensureDir(path, mode, owner, runFn);
}

/**
 * Traverse without list on {@link LayoutPaths.principalHomeRoot}.
 *
 * `install -d -m 0750` is the mode Sonar wants (no world bit). The other:x
 * ACL is what actually lets a principal reach `/srv/users/<name>` without
 * being able to `ls` its siblings. Applied after mkdir because chmod
 * rewrites the other ACL class.
 */
async function ensurePrincipalHomeRootTraverse(
  path: string,
  runFn: RunFn,
): Promise<void> {
  const result = await runFn("sudo", ["-n", "setfacl", "-m", "o::x", path]);
  if (!result.success) {
    throw new Error(
      result.stderr || `Failed to grant traverse ACL on ${path}`,
    );
  }
}

async function ensureDir(
  path: string,
  mode: string,
  owner: string,
  runFn: RunFn,
): Promise<void> {
  const sep = owner.indexOf(":");
  const user = sep === -1 ? owner : owner.slice(0, sep);
  const group = sep === -1 ? owner : owner.slice(sep + 1);
  const result = await runFn("sudo", [
    "-n",
    "install",
    "-d",
    "-m",
    mode,
    "-o",
    user,
    "-g",
    group,
    path,
  ]);
  if (!result.success) {
    throw new Error(result.stderr || `Failed to create directory ${path}`);
  }
}

async function ensurePrincipalGroup(
  principal: PrincipalEnsureSpec,
  groupName: string,
  runFn: RunFn,
): Promise<void> {
  const groupCheck = await runFn("getent", ["group", groupName]);
  if (groupCheck.success) {
    // Explicit gid overrides must match the existing group — never silently
    // attach a principal to a colliding group with a different numeric id.
    if (principal.gid !== undefined) {
      const currentGid = parseGroupGid(groupCheck.stdout);
      if (currentGid === null) {
        throw new Error(
          `Failed to parse group entry for principal group ${groupName}`,
        );
      }
      if (currentGid !== principal.gid) {
        throw new Error(
          `Principal group ${groupName} already exists with gid=${currentGid}; expected gid=${principal.gid}`,
        );
      }
    }
    return;
  }
  const args = ["-n", "groupadd"];
  if (principal.gid !== undefined) {
    args.push("-g", String(principal.gid));
  }
  args.push(groupName);
  const groupAdd = await runFn("sudo", args);
  if (!groupAdd.success) {
    throw new Error(groupAdd.stderr || "Failed to create principal group");
  }
}

async function ensurePrincipalUser(
  principal: PrincipalEnsureSpec,
  home: string,
  shell: string,
  groupName: string,
  runFn: RunFn,
): Promise<void> {
  const userCheck = await runFn("getent", ["passwd", principal.username]);
  if (!userCheck.success) {
    const args = ["-n", "useradd"];
    if (principal.uid !== undefined) {
      args.push("-u", String(principal.uid));
    }
    args.push(
      "-g",
      groupName,
      "-d",
      home,
      "-M",
      "-s",
      shell,
      principal.username,
    );
    const userAdd = await runFn("sudo", args);
    if (!userAdd.success) {
      throw new Error(userAdd.stderr || "Failed to create principal user");
    }
    return;
  }

  // Adopt only when the passwd home matches — never `usermod -m` / `-d`.
  // Explicit uid/gid overrides must still match the existing account.
  const current = parsePasswdHomeShell(userCheck.stdout);
  if (!current) {
    throw new Error(
      `Failed to parse passwd entry for principal user ${principal.username}`,
    );
  }
  if (
    (principal.uid !== undefined && current.uid !== principal.uid) ||
    (principal.gid !== undefined && current.gid !== principal.gid)
  ) {
    throw new Error(
      `Principal username ${principal.username} already exists with uid=${current.uid} gid=${current.gid}; expected uid=${principal.uid} gid=${principal.gid}`,
    );
  }
  if (current.home !== home) {
    throw new Error(
      `refusing to adopt existing account \`${principal.username}\` — home \`${current.home}\` does not match \`${home}\``,
    );
  }
  if (current.shell !== shell) {
    const usermodShell = await runFn("sudo", [
      "-n",
      "usermod",
      "-s",
      shell,
      principal.username,
    ]);
    if (!usermodShell.success) {
      throw new Error(
        usermodShell.stderr || "Failed to update principal shell",
      );
    }
  }
}

async function ensurePrincipalHomeTree(
  home: string,
  username: string,
  groupName: string,
  runFn: RunFn,
): Promise<void> {
  const owner = `${username}:${groupName}`;
  await ensureDir(home, "0750", owner, runFn);
  await ensureDir(join(home, ".ssh"), "0700", owner, runFn);
  await ensureDir(join(home, "volumes"), "0750", owner, runFn);
}

export async function ensureSystemPrincipals(
  layout: LayoutPaths,
  principals: PrincipalEnsureSpec[],
  runFn: RunFn = runDefault,
): Promise<void> {
  for (const principal of principals) {
    assertSafePrincipalUsername(principal.username);
    const groupName = principalUnixGroupName(principal.username);
    const home = assertSafeAbsolutePath(
      principal.home ?? join(layout.principalHomeRoot, principal.username),
      "home",
    );
    const shell = assertSafeAbsolutePath(
      principal.shell ?? DEFAULT_PRINCIPAL_SHELL,
      "shell",
    );
    if (!ALLOWED_PRINCIPAL_SHELLS.includes(shell)) {
      throw new TypeError(`Principal shell is not allowed: ${shell}`);
    }

    // 0750 plus other:x, not 0751. A world bit trips ansible:S2612; the ACL
    // is traverse without list. A principal with a shell can otherwise
    // `ls /srv/users` and enumerate every other tenant. Homes are 0750 so
    // contents were never exposed — the account names were. `install -d -m`
    // resets the other class, so the ACL is applied after, not instead of.
    await ensureDir(layout.principalHomeRoot, "0750", "root:root", runFn);
    await ensurePrincipalHomeRootTraverse(layout.principalHomeRoot, runFn);
    await ensurePrincipalGroup(principal, groupName, runFn);
    await ensurePrincipalUser(principal, home, shell, groupName, runFn);
    await ensurePrincipalHomeTree(
      home,
      principal.username,
      groupName,
      runFn,
    );
    // Runs here, before any unit is installed or pool staged: systemd resolves
    // supplementary groups at `execve`, so a unit started before its principal
    // joined the runtime group dies `203/EXEC`.
    await ensurePrincipalManagedGroups(
      principal.username,
      resolveManagedGroups(principal),
      runFn,
    );
  }
}

/**
 * Every group one principal should hold: runtime entitlements plus SSH access.
 *
 * Resolved together because they are reconciled together — see
 * {@link ensurePrincipalManagedGroups} for why the containment set has to be a
 * single one.
 *
 * Unknown **runtime** series are dropped rather than thrown: a newer control
 * plane must not fail every deploy on a host that has simply not learned about
 * a series yet, and the site's own version gate is what reports that. Unknown
 * **access** groups are dropped for the opposite reason — there is a fixed pair
 * of them, so a third name is a control-plane bug, and inventing the group
 * would hand out an `sshd` Match block nobody wrote.
 */
function resolveManagedGroups(principal: PrincipalEnsureSpec): Set<string> {
  const groups = new Set<string>();
  for (const entry of principal.runtimes ?? []) {
    if (!isRuntimeName(entry.runtime)) continue;
    const group = runtimeGroup(entry.runtime, entry.series);
    if (group) groups.add(group);
  }
  const known = allAccessGroups();
  for (const group of principal.accessGroups ?? []) {
    if (known.has(group)) groups.add(group);
  }
  return groups;
}

/**
 * Add `user` as a **supplementary** member of `groupName` (`usermod -aG`).
 *
 * `-a` is load-bearing — without it `usermod -G` *replaces* the account's
 * supplementary groups, which would silently strip the account of every other
 * group it had already joined.
 *
 * Callers decide whether membership actually changed (and therefore whether a
 * service needs a restart rather than a reload); this stays a thin command
 * wrapper like its siblings in this module.
 */
export async function ensureSupplementaryGroupMembership(
  user: string,
  groupName: string,
  runFn: RunFn = runDefault,
): Promise<void> {
  const result = await runFn("sudo", ["-n", "usermod", "-aG", groupName, user]);
  if (!result.success) {
    throw new Error(
      result.stderr || `Failed to add ${user} to group ${groupName}`,
    );
  }
}

/**
 * Supplementary groups a user currently holds. Empty on failure — the caller
 * treats "cannot read" as "nothing to reconcile" rather than guessing.
 */
export async function userSupplementaryGroups(
  user: string,
  runFn: RunFn = runDefault,
): Promise<Set<string>> {
  const result = await runFn("id", ["-nG", user]);
  if (!result.success) return new Set();
  return new Set(result.stdout.split(/\s+/).filter((g) => g.length > 0));
}

/**
 * Remove `user` from a supplementary group (`gpasswd -d`).
 *
 * Only ever called for names in {@link allManagedGroups}; see
 * {@link ensurePrincipalManagedGroups} for why that containment matters.
 */
async function removeSupplementaryGroupMembership(
  user: string,
  groupName: string,
  runFn: RunFn = runDefault,
): Promise<void> {
  const result = await runFn("sudo", ["-n", "gpasswd", "-d", user, groupName]);
  if (!result.success) {
    throw new Error(
      result.stderr || `Failed to remove ${user} from group ${groupName}`,
    );
  }
}

/**
 * Reconcile every group TurboPanel manages on a principal — which runtimes it
 * may execute, and how it may log in.
 *
 * A runtime entitlement is a **unix group**, because that is the only form the
 * kernel enforces at `execve` time. Anything derived only into a generated
 * systemd unit or an FPM pool is invisible to an interactive shell or a cron
 * job — both of which run as the principal and are exactly the cases the group
 * has to cover. SSH access is a group for a different reason: `sshd` matches on
 * groups, not on shells.
 *
 * **Revocation is the reason this exists.** `usermod -aG` alone can only ever
 * add, so a principal that once deployed a Node app could execute Node forever,
 * and one downgraded from a shell to files-only would keep its shell. Stale
 * membership is dropped here — but **only** for group names the registry
 * defines. That containment is what makes revoking safe: `<username>-grp`,
 * `tp`, an engine group, and anything an operator added by hand are never
 * touched, no matter what the wire asks for.
 *
 * Adds are best-effort and logged (a host provisioned some other way may
 * legitimately not have the group yet, and the unit's own health probe is what
 * catches a genuinely unreachable runtime). A failed **revoke** is loud: an
 * entitlement or a login that silently outlives its grant is a security
 * problem, not an inconvenience.
 */
export async function ensurePrincipalManagedGroups(
  username: string,
  desiredGroups: ReadonlySet<string>,
  runFn: RunFn = runDefault,
): Promise<void> {
  const registryGroups = allManagedGroups();
  for (const group of desiredGroups) {
    if (!registryGroups.has(group)) {
      throw new Error(`unknown managed group: ${group}`);
    }
  }
  const current = await userSupplementaryGroups(username, runFn);
  const sorted = (values: Iterable<string>) =>
    [...values].sort((a, b) => a.localeCompare(b));

  for (const group of sorted(desiredGroups)) {
    if (current.has(group)) continue;
    try {
      await ensureSupplementaryGroupMembership(username, group, runFn);
    } catch (err) {
      logWarn(
        "deploy",
        `could not add ${username} to ${group}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  for (const group of sorted(current)) {
    // Never touch a group outside the registry, even if it looks like ours.
    if (!registryGroups.has(group) || desiredGroups.has(group)) continue;
    await removeSupplementaryGroupMembership(username, group, runFn);
  }
}

/**
 * Let a web engine read one principal's published releases.
 *
 * A published release is root-owned, group `<username>-grp`, mode `0550` — the
 * group bit is the only way anything other than root reads it, and re-chowning
 * an immutable tree to a serving engine would defeat the point. So the engine
 * service account (`tpnginx` / `tpapache` / `tpols`) joins the principal's own
 * group instead: read + traverse, never write.
 */
export function ensureEngineGroupMembership(
  user: string,
  groupName: string,
  runFn: RunFn = runDefault,
): Promise<void> {
  return ensureSupplementaryGroupMembership(user, groupName, runFn);
}

export async function ensureDirectoryOwnedByPrincipal(
  path: string,
  username: string,
  groupName: string,
  runFn: RunFn = runDefault,
): Promise<void> {
  const owner = `${username}:${groupName}`;
  // Fast path when the parent is already daemon-writable.
  try {
    await Deno.mkdir(path, { recursive: true, mode: 0o750 });
  } catch {
    await ensureDir(path, "0750", owner, runFn);
    return;
  }
  const chown = await runFn("sudo", ["-n", "chown", owner, path]);
  if (!chown.success) {
    throw new Error(chown.stderr || `Failed to chown ${path}`);
  }
}
