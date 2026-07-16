/**
 * Docker CLI helper for deploy/ingress.
 *
 * After Ansible adds the daemon user to the `docker` group, the already-running
 * process still lacks that supplementary group until restart. Fall back to
 * `sudo -n -u <self> -- docker …` so the first environment.deploy after Docker
 * install works. (`sg docker` is unsuitable: service accounts use
 * `/usr/sbin/nologin`, and `sg` then fails with "This account is currently not
 * available.")
 */

const decoder = new TextDecoder();
const SUDO_BIN = "/usr/bin/sudo";
const DOCKER_BIN = "/usr/bin/docker";

export type DockerCliResult = {
  success: boolean;
  code: number;
  stdout: string;
  stderr: string;
};

function isDockerSocketPermissionError(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return lower.includes("permission denied") && lower.includes("docker");
}

async function runRaw(
  command: string,
  args: string[],
): Promise<DockerCliResult> {
  try {
    const result = await new Deno.Command(command, {
      args,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      success: result.success,
      code: result.code,
      stdout: decoder.decode(result.stdout).trim(),
      stderr: decoder.decode(result.stderr).trim(),
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

async function currentUsername(): Promise<string> {
  const fromEnv = Deno.env.get("USER")?.trim() ||
    Deno.env.get("LOGNAME")?.trim();
  if (fromEnv) return fromEnv;
  const result = await runRaw("/usr/bin/id", ["-un"]);
  if (result.success && result.stdout) return result.stdout;
  throw new Error(
    `cannot resolve daemon username for docker group refresh: ${result.stderr}`,
  );
}

/**
 * Re-run docker as the same user via sudo so initgroups() picks up a newly
 * added `docker` group without requiring a login shell or CAP_SETGID.
 */
async function runDockerWithFreshGroups(
  args: string[],
): Promise<DockerCliResult> {
  const user = await currentUsername();
  return await runRaw(SUDO_BIN, [
    "-n",
    "-u",
    user,
    "--",
    DOCKER_BIN,
    ...args,
  ]);
}

/**
 * Run `/usr/bin/docker …args`, retrying via `sudo -n -u <self>` when the
 * socket is permission-denied (stale process credentials after group
 * membership change).
 */
export async function runDocker(args: string[]): Promise<DockerCliResult> {
  const direct = await runRaw(DOCKER_BIN, args);
  if (direct.success || !isDockerSocketPermissionError(direct.stderr)) {
    return direct;
  }

  const refreshed = await runDockerWithFreshGroups(args);
  if (refreshed.success) return refreshed;
  // Prefer the original docker.sock error when the refresh path also fails.
  return {
    success: false,
    code: refreshed.code || direct.code,
    stdout: refreshed.stdout || direct.stdout,
    stderr: refreshed.stderr || direct.stderr,
  };
}

/** True when `docker version` can talk to the Engine API. */
export async function dockerEngineReachable(): Promise<boolean> {
  const result = await runDocker([
    "version",
    "--format",
    "{{.Server.Version}}",
  ]);
  return result.success;
}
