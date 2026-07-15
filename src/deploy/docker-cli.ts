/**
 * Docker CLI helper for deploy/ingress.
 *
 * After Ansible adds the daemon user to the `docker` group, the already-running
 * process still lacks that supplementary group until restart. Fall back to
 * `sg docker` so the first environment.deploy after Docker install works.
 */

const decoder = new TextDecoder();

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
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/**
 * Run `/usr/bin/docker …args`, retrying via `sg docker` when the socket is
 * permission-denied (stale process credentials after group membership change).
 */
export async function runDocker(args: string[]): Promise<DockerCliResult> {
  const direct = await runRaw("/usr/bin/docker", args);
  if (direct.success || !isDockerSocketPermissionError(direct.stderr)) {
    return direct;
  }

  const quoted = ["docker", ...args].map(shellSingleQuote).join(" ");
  const viaSg = await runRaw("sg", ["docker", "-c", quoted]);
  if (viaSg.success) return viaSg;
  // Prefer the original docker.sock error when sg also fails.
  return {
    success: false,
    code: viaSg.code || direct.code,
    stdout: viaSg.stdout || direct.stdout,
    stderr: viaSg.stderr || direct.stderr,
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
