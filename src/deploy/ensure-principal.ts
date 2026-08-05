import { join } from "@std/path";
import type { LayoutPaths } from "../paths/layout.ts";

export type PrincipalEnsureSpec = {
  principalId: string;
  username: string;
  uid?: number;
  gid?: number;
  home?: string;
  shell?: string;
};

export const DEFAULT_PRINCIPAL_SHELL = "/usr/sbin/nologin";

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

    await ensureDir(layout.principalHomeRoot, "0755", "root:root", runFn);
    await ensurePrincipalGroup(principal, groupName, runFn);
    await ensurePrincipalUser(principal, home, shell, groupName, runFn);
    await ensurePrincipalHomeTree(
      home,
      principal.username,
      groupName,
      runFn,
    );
  }
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
