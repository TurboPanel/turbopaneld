import type { LayoutPaths } from "../paths/layout.ts";

export type PrincipalEnsureSpec = {
  principalId: string;
  username: string;
  uid: number;
  gid: number;
  home?: string;
};

/**
 * Primary group name created by {@link ensureSystemPrincipals}
 * (`groupadd … ${username}-grp`).
 */
export function principalUnixGroupName(username: string): string {
  return `${username}-grp`;
}

const decoder = new TextDecoder();

async function run(command: string, args: string[]): Promise<{ success: boolean; stderr: string }> {
  const result = await new Deno.Command(command, {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    success: result.success,
    stderr: decoder.decode(result.stderr).trim(),
  };
}

export async function ensureSystemPrincipals(
  _layout: LayoutPaths,
  principals: PrincipalEnsureSpec[],
): Promise<void> {
  for (const principal of principals) {
    const groupCheck = await run("getent", ["group", String(principal.gid)]);
    if (!groupCheck.success) {
      const groupAdd = await run("sudo", [
        "-n",
        "groupadd",
        "-g",
        String(principal.gid),
        `${principal.username}-grp`,
      ]);
      if (!groupAdd.success) {
        throw new Error(groupAdd.stderr || "Failed to create principal group");
      }
    }

    const userCheck = await run("getent", ["passwd", principal.username]);
    if (!userCheck.success) {
      const home = principal.home ?? `/var/lib/turbopanel/principals/${principal.username}`;
      const userAdd = await run("sudo", [
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
        "/usr/sbin/nologin",
        principal.username,
      ]);
      if (!userAdd.success) {
        throw new Error(userAdd.stderr || "Failed to create principal user");
      }
    }
  }
}

export async function ensureDirectoryOwnedByPrincipal(
  path: string,
  uid: number,
  gid: number,
): Promise<void> {
  await Deno.mkdir(path, { recursive: true, mode: 0o750 });
  const chown = await run("sudo", ["-n", "chown", `${uid}:${gid}`, path]);
  if (!chown.success) {
    throw new Error(chown.stderr || `Failed to chown ${path}`);
  }
}
