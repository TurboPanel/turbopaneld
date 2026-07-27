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

export type RunDockerOptions = {
  /** Pipe this string to docker stdin (e.g. SQL / secrets — never put them on argv). */
  input?: string;
};

function isDockerSocketPermissionError(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return lower.includes("permission denied") && lower.includes("docker");
}

async function runRaw(
  command: string,
  args: string[],
  options?: RunDockerOptions,
): Promise<DockerCliResult> {
  try {
    const hasInput = options?.input !== undefined;
    const child = new Deno.Command(command, {
      args,
      stdin: hasInput ? "piped" : "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    if (hasInput) {
      const writer = child.stdin.getWriter();
      try {
        await writer.write(new TextEncoder().encode(options.input));
      } finally {
        await writer.close();
      }
    }

    const result = await child.output();
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
  options?: RunDockerOptions,
): Promise<DockerCliResult> {
  const user = await currentUsername();
  return await runRaw(
    SUDO_BIN,
    [
      "-n",
      "-u",
      user,
      "--",
      DOCKER_BIN,
      ...args,
    ],
    options,
  );
}

/**
 * Run `/usr/bin/docker …args`, retrying via `sudo -n -u <self>` when the
 * socket is permission-denied (stale process credentials after group
 * membership change).
 *
 * Optional `options.input` is piped to stdin so secrets/SQL never appear on
 * argv. Do not pass secrets via environment — the sudo fallback would drop it.
 */
export async function runDocker(
  args: string[],
  options?: RunDockerOptions,
): Promise<DockerCliResult> {
  const direct = await runRaw(DOCKER_BIN, args, options);
  if (direct.success || !isDockerSocketPermissionError(direct.stderr)) {
    return direct;
  }

  const refreshed = await runDockerWithFreshGroups(args, options);
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

export type DockerInvocation = {
  bin: string;
  prefixArgs: string[];
};

let cachedInvocation: DockerInvocation | undefined;
let cachedInvocationPromise: Promise<DockerInvocation> | undefined;

async function probeDockerInvocation(): Promise<DockerInvocation> {
  const direct = await runRaw(DOCKER_BIN, [
    "version",
    "--format",
    "{{.Server.Version}}",
  ]);
  if (direct.success || !isDockerSocketPermissionError(direct.stderr)) {
    return { bin: DOCKER_BIN, prefixArgs: [] };
  }
  const user = await currentUsername();
  return { bin: SUDO_BIN, prefixArgs: ["-n", "-u", user, "--", DOCKER_BIN] };
}

/**
 * Resolve (and cache for the lifetime of the process) whether docker must be
 * invoked directly or via `sudo -n -u <self> --` (stale group membership
 * before the daemon restarts after Docker install — see the module doc
 * comment). `runDocker` retries reactively after inspecting stderr, but a
 * streaming spawn cannot buffer-then-retry mid-stream, so this probes once
 * with a cheap `docker version` call and every `spawnDockerStreaming` call
 * reuses the cached result.
 */
export async function resolveDockerInvocation(): Promise<DockerInvocation> {
  if (cachedInvocation) return cachedInvocation;
  if (!cachedInvocationPromise) {
    cachedInvocationPromise = probeDockerInvocation().then((resolved) => {
      cachedInvocation = resolved;
      return resolved;
    });
  }
  return await cachedInvocationPromise;
}

export type SpawnDockerStreamingOptions = {
  stdin?: "piped" | "null";
  stdout?: "piped" | "inherit";
};

/**
 * Spawn docker with the resolved invocation and return the live
 * `Deno.ChildProcess` so callers can stream stdin/stdout without ever
 * decoding the payload into a string (`runDocker` buffers stdout as text —
 * unsafe for binary dump artifacts). Used only by `managed/backup.ts`;
 * everything else keeps using `runDocker`.
 */
export async function spawnDockerStreaming(
  args: string[],
  options?: SpawnDockerStreamingOptions,
): Promise<Deno.ChildProcess> {
  const invocation = await resolveDockerInvocation();
  return new Deno.Command(invocation.bin, {
    args: [...invocation.prefixArgs, ...args],
    stdin: options?.stdin ?? "null",
    stdout: options?.stdout ?? "piped",
    stderr: "piped",
  }).spawn();
}
