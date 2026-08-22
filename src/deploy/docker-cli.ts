/**
 * Docker CLI helper for deploy/ingress.
 *
 * After Ansible adds the daemon user to the `docker` group, the already-running
 * process still lacks that supplementary group until restart. Fall back to
 * `sudo -n -u <self> -- docker …` so the first environment.deploy after Docker
 * install works. (`sg docker` is unsuitable: service accounts use
 * `/usr/sbin/nologin`, and `sg` then fails with "This account is currently not
 * available.")
 *
 * If the self-refresh still cannot reach the socket (user not in `docker`, or
 * the socket is root-only), fall back to `sudo -n -- docker …`. Managed hosts
 * grant `tp` passwordless sudo (`NOPASSWD:ALL`); that path reaches dockerd
 * without waiting for a daemon restart.
 */

import { emitBufferedLines, pumpLines } from "../logs/line-stream.ts";

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

export type DockerCliRunRawFn = (
  command: string,
  args: string[],
  options?: RunDockerOptions,
) => Promise<DockerCliResult>;

/** Optional I/O override for host-free unit tests (never call real docker). */
export type DockerCliIo = {
  runRaw?: DockerCliRunRawFn;
  /**
   * When `runRaw` is unset, {@link runRawDefault} / probe use this instead of
   * `/usr/bin/docker` (host-free spawn coverage via `/bin/true` / `/bin/cat`).
   */
  dockerBin?: string;
  /**
   * When set, {@link spawnDockerStreaming} uses this instead of
   * `Deno.Command.spawn` (binary dump path — never decode into a string).
   */
  spawnStreaming?: (
    bin: string,
    args: string[],
    options?: SpawnDockerStreamingOptions,
  ) => Promise<Deno.ChildProcess>;
};

let ioOverride: DockerCliIo | undefined;

/**
 * Test-only injection for {@link runDocker} / {@link resolveDockerInvocation}.
 * Returns a restore function that clears the override and invocation cache.
 */
export function setDockerCliIoForTest(io?: DockerCliIo): () => void {
  const previous = ioOverride;
  ioOverride = io;
  clearDockerInvocationCache();
  return () => {
    ioOverride = previous;
    clearDockerInvocationCache();
  };
}

function resolvedDockerBin(): string {
  return ioOverride?.dockerBin ?? DOCKER_BIN;
}

function clearDockerInvocationCache(): void {
  cachedInvocation = undefined;
  cachedInvocationPromise = undefined;
}

function isDockerSocketPermissionError(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes("permission denied") && lower.includes("docker");
}

/** True when docker CLI reported a socket permission error on stdout or stderr. */
export function dockerOutputLooksLikeSocketPermission(
  stdout: string,
  stderr: string,
): boolean {
  return isDockerSocketPermissionError(stderr) ||
    isDockerSocketPermissionError(stdout);
}

async function runRawDefault(
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
        await writer.write(new TextEncoder().encode(options?.input ?? ""));
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

async function runRaw(
  command: string,
  args: string[],
  options?: RunDockerOptions,
): Promise<DockerCliResult> {
  const impl = ioOverride?.runRaw ?? runRawDefault;
  return await impl(command, args, options);
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
      resolvedDockerBin(),
      ...args,
    ],
    options,
  );
}

/** Last-resort: passwordless root docker when the daemon user cannot open the socket. */
async function runDockerAsRoot(
  args: string[],
  options?: RunDockerOptions,
): Promise<DockerCliResult> {
  return await runRaw(
    SUDO_BIN,
    ["-n", "--", resolvedDockerBin(), ...args],
    options,
  );
}

function preferOriginalSocketError(
  direct: DockerCliResult,
  fallback: DockerCliResult,
): DockerCliResult {
  return {
    success: false,
    code: fallback.code || direct.code,
    stdout: fallback.stdout || direct.stdout,
    stderr: direct.stderr || fallback.stderr,
  };
}

/**
 * Run `/usr/bin/docker …args`, retrying via `sudo -n -u <self>` when the
 * socket is permission-denied (stale process credentials after group
 * membership change), then `sudo -n -- docker` when that still cannot open
 * the socket.
 *
 * Optional `options.input` is piped to stdin so secrets/SQL never appear on
 * argv. Do not pass secrets via environment — the sudo fallback would drop it.
 */
export async function runDocker(
  args: string[],
  options?: RunDockerOptions,
): Promise<DockerCliResult> {
  const direct = await runRaw(resolvedDockerBin(), args, options);
  if (
    direct.success ||
    !dockerOutputLooksLikeSocketPermission(direct.stdout, direct.stderr)
  ) {
    return direct;
  }

  const refreshed = await runDockerWithFreshGroups(args, options);
  if (refreshed.success) return refreshed;

  const asRoot = await runDockerAsRoot(args, options);
  if (asRoot.success) return asRoot;
  // Prefer the original docker.sock error when both sudo paths also fail.
  return preferOriginalSocketError(direct, asRoot);
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

const PROBE_ARGS = ["version", "--format", "{{.Server.Version}}"];

async function probeDockerInvocation(): Promise<DockerInvocation> {
  const dockerBin = resolvedDockerBin();
  const direct = await runRaw(dockerBin, PROBE_ARGS);
  if (
    direct.success ||
    !dockerOutputLooksLikeSocketPermission(direct.stdout, direct.stderr)
  ) {
    return { bin: dockerBin, prefixArgs: [] };
  }

  // Same escalation ladder `runDocker` walks reactively: self-refresh first
  // (stale `docker` group membership), then passwordless root (root-only
  // socket). Probing both keeps the streamed path's effective Docker access
  // identical to the buffered one.
  const user = await currentUsername();
  const selfPrefix = ["-n", "-u", user, "--", dockerBin];
  const refreshed = await runRaw(SUDO_BIN, [...selfPrefix, ...PROBE_ARGS]);
  if (refreshed.success) return { bin: SUDO_BIN, prefixArgs: selfPrefix };

  const rootPrefix = ["-n", "--", dockerBin];
  const asRoot = await runRaw(SUDO_BIN, [...rootPrefix, ...PROBE_ARGS]);
  if (asRoot.success) return { bin: SUDO_BIN, prefixArgs: rootPrefix };

  // Nothing reached the socket; keep the self-refresh invocation so the
  // failure surfaces with the same error `runDocker` would report.
  return { bin: SUDO_BIN, prefixArgs: selfPrefix };
}

/**
 * Resolve (and cache for the lifetime of the process) whether docker must be
 * invoked directly, via `sudo -n -u <self> --` (stale group membership before
 * the daemon restarts after Docker install), or via `sudo -n --` (root-only
 * socket) — see the module doc comment. `runDocker` retries reactively after inspecting stderr, but a
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
  const fullArgs = [...invocation.prefixArgs, ...args];
  const spawnOverride = ioOverride?.spawnStreaming;
  if (spawnOverride) {
    return await spawnOverride(invocation.bin, fullArgs, options);
  }
  return new Deno.Command(invocation.bin, {
    args: fullArgs,
    stdin: options?.stdin ?? "null",
    stdout: options?.stdout ?? "piped",
    stderr: "piped",
  }).spawn();
}

/** One decoded output line, tagged with the stream it came from. */
export type DockerStreamEvent = {
  stream: "stdout" | "stderr";
  line: string;
};

export type DockerLineHandler = (event: DockerStreamEvent) => void;

export type RunDockerStreamedOptions = RunDockerOptions & {
  /** Called once per decoded line while docker is still running. */
  onLine?: DockerLineHandler;
};

/** Buffered `runDocker`-shaped callable (the handler test seam). */
export type RunDockerFn = (
  args: string[],
  options?: RunDockerOptions,
) => Promise<DockerCliResult>;

/** Streaming `runDockerStreamed`-shaped callable. */
export type RunDockerStreamedFn = (
  args: string[],
  options?: RunDockerStreamedOptions,
) => Promise<DockerCliResult>;

/** Split already-buffered text into lines and replay them through `onLine`. */
export function emitBufferedDockerLines(
  text: string,
  stream: DockerStreamEvent["stream"],
  onLine?: DockerLineHandler,
): void {
  if (!onLine) return;
  emitBufferedLines(text, (line) => onLine({ stream, line }));
}

/**
 * Run docker with the resolved invocation, teeing stdout/stderr line-by-line to
 * `options.onLine` while still buffering both into the same
 * {@link DockerCliResult} {@link runDocker} returns.
 *
 * Without `onLine` this behaves like `runDocker` minus the reactive sudo retry
 * (a streaming spawn cannot buffer-then-retry mid-stream — the invocation is
 * probed once by {@link resolveDockerInvocation} instead).
 */
export async function runDockerStreamed(
  args: string[],
  options?: RunDockerStreamedOptions,
): Promise<DockerCliResult> {
  try {
    const hasInput = options?.input !== undefined;
    const child = await spawnDockerStreaming(args, {
      stdin: hasInput ? "piped" : "null",
      stdout: "piped",
    });

    if (hasInput) {
      const writer = child.stdin.getWriter();
      try {
        await writer.write(new TextEncoder().encode(options?.input ?? ""));
      } finally {
        await writer.close();
      }
    }

    const onLine = options?.onLine;
    const [status, stdout, stderr] = await Promise.all([
      child.status,
      pumpLines(
        child.stdout,
        onLine ? (line) => onLine({ stream: "stdout", line }) : undefined,
      ),
      pumpLines(
        child.stderr,
        onLine ? (line) => onLine({ stream: "stderr", line }) : undefined,
      ),
    ]);

    return {
      success: status.success,
      code: status.code,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
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

/**
 * Resolve the streaming docker runner for a handler.
 *
 * When a buffered `runDocker` test seam is supplied, keep using it and replay
 * its buffered output through `onLine` once it completes — host-free suites
 * still exercise the transcript path without ever spawning docker.
 */
export function createStreamedRunner(
  runOverride?: RunDockerFn,
): RunDockerStreamedFn {
  if (!runOverride) return runDockerStreamed;
  return async (args, options) => {
    const result = await runOverride(
      args,
      options?.input === undefined ? undefined : { input: options.input },
    );
    emitBufferedDockerLines(result.stdout, "stdout", options?.onLine);
    emitBufferedDockerLines(result.stderr, "stderr", options?.onLine);
    return result;
  };
}
