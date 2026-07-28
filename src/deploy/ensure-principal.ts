import { join } from "@std/path";
import type { LayoutPaths } from "../paths/layout.ts";

export type PrincipalEnsureSpec = {
  principalId: string;
  username: string;
  uid: number;
  gid: number;
  home?: string;
  shell?: string;
};

export const DEFAULT_PRINCIPAL_SHELL = "/usr/sbin/nologin";

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
  runFn: RunFn,
): Promise<void> {
  const groupCheck = await runFn("getent", ["group", String(principal.gid)]);
  if (groupCheck.success) return;
  const groupAdd = await runFn("sudo", [
    "-n",
    "groupadd",
    "-g",
    String(principal.gid),
    principalUnixGroupName(principal.username),
  ]);
  if (!groupAdd.success) {
    throw new Error(groupAdd.stderr || "Failed to create principal group");
  }
}

async function ensurePrincipalUser(
  principal: PrincipalEnsureSpec,
  home: string,
  shell: string,
  runFn: RunFn,
): Promise<void> {
  const userCheck = await runFn("getent", ["passwd", principal.username]);
  if (!userCheck.success) {
    const userAdd = await runFn("sudo", [
      "-n",
      "useradd",
      "-u",
      String(principal.uid),
      "-g",
      String(principal.gid),
      "-d",
      home,
      "-M",
      "-s",
      shell,
      principal.username,
    ]);
    if (!userAdd.success) {
      throw new Error(userAdd.stderr || "Failed to create principal user");
    }
    return;
  }

  // Reconcile home/shell when they differ — never `usermod -m` (no data move).
  // Refuse to touch an existing username that is not this principal's UID/GID.
  const current = parsePasswdHomeShell(userCheck.stdout);
  if (!current) {
    throw new Error(
      `Failed to parse passwd entry for principal user ${principal.username}`,
    );
  }
  if (current.uid !== principal.uid || current.gid !== principal.gid) {
    throw new Error(
      `Principal username ${principal.username} already exists with uid=${current.uid} gid=${current.gid}; expected uid=${principal.uid} gid=${principal.gid}`,
    );
  }
  if (current.home !== home) {
    const usermodHome = await runFn("sudo", [
      "-n",
      "usermod",
      "-d",
      home,
      principal.username,
    ]);
    if (!usermodHome.success) {
      throw new Error(usermodHome.stderr || "Failed to update principal home");
    }
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
      throw new Error(usermodShell.stderr || "Failed to update principal shell");
    }
  }
}

async function ensurePrincipalHomeTree(
  home: string,
  uid: number,
  gid: number,
  runFn: RunFn,
): Promise<void> {
  const owner = `${uid}:${gid}`;
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
    const home = assertSafeAbsolutePath(
      principal.home ?? join(layout.principalHomeRoot, principal.principalId),
      "home",
    );
    const shell = assertSafeAbsolutePath(
      principal.shell ?? DEFAULT_PRINCIPAL_SHELL,
      "shell",
    );

    await ensureDir(layout.principalHomeRoot, "0755", "root:root", runFn);
    await ensurePrincipalGroup(principal, runFn);
    await ensurePrincipalUser(principal, home, shell, runFn);
    await ensurePrincipalHomeTree(home, principal.uid, principal.gid, runFn);
  }
}

export async function ensureDirectoryOwnedByPrincipal(
  path: string,
  uid: number,
  gid: number,
  runFn: RunFn = runDefault,
): Promise<void> {
  // Fast path when the parent is already daemon-writable.
  try {
    await Deno.mkdir(path, { recursive: true, mode: 0o750 });
  } catch {
    await ensureDir(path, "0750", `${uid}:${gid}`, runFn);
    return;
  }
  const chown = await runFn("sudo", ["-n", "chown", `${uid}:${gid}`, path]);
  if (!chown.success) {
    throw new Error(chown.stderr || `Failed to chown ${path}`);
  }
}
