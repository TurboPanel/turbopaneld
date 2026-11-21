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
 * do not grant that (roles/turbopanel-user/templates/sudoers.j2): the Docker
 * role adds `tp` to `docker`, so the self re-exec above is what reaches
 * dockerd before the daemon restarts; the root fallback only succeeds on a
 * development host whose user has full sudo.
 */

import { dirname, isAbsolute, join } from "@std/path";
import { emitBufferedLines, pumpLines } from "../logs/line-stream.ts";
import { PROD_RUN_DIR_DEFAULT } from "../paths/layout.ts";
import { composeCheckoutDirsForFile } from "./compose-checkout-marker.ts";
import {
  COMPOSE_ENV_FILENAME,
  COMPOSE_PREVIOUS_DIRNAME,
  COMPOSE_STAGE_DIRNAME,
} from "./compose-files.ts";

const decoder = new TextDecoder();
const SUDO_BIN = "/usr/bin/sudo";
const DOCKER_BIN = "/usr/bin/docker";
const ENV_BIN = "/usr/bin/env";

function configuredRunDir(): string {
  try {
    return Deno.env.get("TURBOPANEL_RUN_DIR")?.trim() || PROD_RUN_DIR_DEFAULT;
  } catch {
    return PROD_RUN_DIR_DEFAULT; // a caller without env access
  }
}

/**
 * The Docker client's config folder for every call this module makes.
 *
 * The CLI (and its compose and buildx plugins) writes `<config>/` on first
 * use, and with no `--config` it picks `$HOME/.docker`. The daemon's home is
 * the state root, which a hardened host keeps `root:tp 0750`, so the mkdir
 * failed there ("mkdir /var/lib/turbopanel/.docker: permission denied") and
 * every Compose or image build with it. The daemon already owns its run
 * folder (the control sockets live there), so the config goes in a folder of
 * its own under it: tmpfs, `0700`, nothing for the state root's mode to
 * decide. It is passed as the `--config` argument, which only the CLI and the
 * plugin it runs see, and as `DOCKER_CONFIG`, which also reaches the helper
 * processes a plugin starts on its own (`docker compose build` hands the build
 * to the buildx plugin without forwarding `--config`, and that one then made
 * `$HOME/.docker`). The `sudo` rungs below reset the environment, so they carry
 * the variable through `env` instead.
 */
export function dockerConfigDir(runDir: string = configuredRunDir()): string {
  return join(runDir, "docker-config");
}

let ensuredConfigDir: string | undefined;
let configDirResolved = false;
let warnedConfigDir = false;

function warnConfigDirOnce(reason: string): void {
  if (warnedConfigDir) return;
  warnedConfigDir = true;
  console.warn(
    `docker config folder: ${reason}; docker uses its own default config`,
  );
}

type ConfigDirStat = {
  isDirectory: boolean;
  isSymlink: boolean;
  uid: number | null;
  mode: number | null;
};

/** The folder is ours and private: a real directory (not a link), our uid, mode 0700. */
function trustConfigDir(dir: string): string | undefined {
  const lstat = ioOverride?.lstatSync ??
    ((p: string): ConfigDirStat => Deno.lstatSync(p));
  const myUid = ioOverride?.uid ?? Deno.uid();
  const check = (): string | undefined => {
    const info = lstat(dir);
    if (info.isSymlink || !info.isDirectory) return "not a plain directory";
    if (info.uid !== myUid) return "owned by another account";
    if (((info.mode ?? 0) & 0o7777) !== 0o700) return "mode is not 0700";
    return undefined;
  };
  try {
    let problem = check();
    // Only our own folder is worth fixing; a foreign or linked one is refused.
    if (problem === "mode is not 0700") {
      Deno.chmodSync(dir, 0o700);
      problem = check();
    }
    return problem;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Create and vet the config folder once; `undefined` leaves Docker its own
 * default. Docker runs plugins and credential helpers named in this folder as
 * the daemon account, and other accounts share the run dir's group, so
 * whatever is found at the path is trusted only when it is our own private
 * directory. Otherwise a fresh unguessable folder is made beside it.
 */
function ensureDockerConfigDir(): string | undefined {
  if (configDirResolved) return ensuredConfigDir;
  configDirResolved = true;
  const dir = ioOverride ? ioOverride.configDir : dockerConfigDir();
  if (dir === undefined) return undefined;
  let problem: string;
  try {
    Deno.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const found = trustConfigDir(dir);
    if (found === undefined) {
      ensuredConfigDir = dir;
      return ensuredConfigDir;
    }
    problem = `${dir} is unusable (${found})`;
  } catch (err) {
    problem = `${dir} cannot be created (${
      err instanceof Error ? err.message : String(err)
    })`;
  }
  try {
    const fresh = Deno.makeTempDirSync({
      dir: join(dir, ".."),
      prefix: "docker-config-",
    });
    const found = trustConfigDir(fresh);
    if (found === undefined) {
      warnConfigDirOnce(`${problem}, using ${fresh}`);
      ensuredConfigDir = fresh;
      return ensuredConfigDir;
    }
    problem += `; ${fresh} is unusable too (${found})`;
  } catch (err) {
    problem += `; no fallback folder (${
      err instanceof Error ? err.message : String(err)
    })`;
  }
  warnConfigDirOnce(problem);
  return undefined;
}

/** `args` behind the global `--config <folder>` flag, when a trusted folder exists. */
export function withDockerConfig(args: string[]): string[] {
  const dir = ensureDockerConfigDir();
  return dir === undefined ? args : ["--config", dir, ...args];
}

/**
 * `DOCKER_CONFIG=<folder>` for a docker process, when a trusted folder exists.
 * Every spawn of the docker client must pass this next to
 * {@link withDockerConfig}: a Compose plugin child never sees `--config`.
 */
export function dockerConfigEnv(): Record<string, string> {
  const dir = ensureDockerConfigDir();
  return dir === undefined ? {} : { DOCKER_CONFIG: dir };
}

/** `env DOCKER_CONFIG=<folder>` words that put the variable back after `sudo` resets it. */
function sudoEnvPrefix(): string[] {
  const dir = ensureDockerConfigDir();
  return dir === undefined ? [] : [ENV_BIN, `DOCKER_CONFIG=${dir}`];
}

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

/**
 * What the raw runner takes: stdin, the environment added to the child's and
 * the folder it starts in.
 */
export type RunRawOptions = RunDockerOptions & {
  env?: Record<string, string>;
  cwd?: string;
};

/**
 * The folder a `docker compose -f <file> …` call runs from: the folder of its
 * first compose file, which is also Compose's own project directory.
 *
 * Compose hands image builds to the builder's bake step, which refuses a build
 * context outside the folder the process started in unless it was granted
 * (`additional privileges requested: pass "--allow=fs.read=…"`). Build
 * contexts are confined to the deployment directory (`compose-host-paths.ts`),
 * which is where the live compose files sit, so starting there keeps every
 * allowed context inside bake's working directory. Nothing is granted and the
 * entitlement check stays on for anything else a build names. `undefined` for
 * any call that is not a compose call with an absolute file path.
 */
export function composeWorkingDirectory(
  args: readonly string[],
): string | undefined {
  if (args[0] !== "compose") return undefined;
  const flag = args.indexOf("-f");
  const file = flag === -1 ? undefined : args[flag + 1];
  if (file === undefined || !isAbsolute(file)) return undefined;
  return dirname(file);
}

/**
 * What a call runs with: the argv and the folder it starts in.
 *
 * A deployment that has a repository checkout (`compose-checkout-marker.ts`)
 * gets `--project-directory <folder of the repo's compose file>` right after
 * `compose`, and starts in the checkout root, so a path written for the
 * repository resolves as in a clone and every build context stays inside the
 * builder's working folder. Any other call is untouched apart from the plain
 * {@link composeWorkingDirectory}. A caller that already passes
 * `--project-directory` keeps its own.
 */
async function composeCall(
  args: readonly string[],
): Promise<{ args: string[]; cwd?: string }> {
  const plain = composeWorkingDirectory(args);
  if (plain === undefined || args.includes("--project-directory")) {
    return { args: [...args], ...(plain === undefined ? {} : { cwd: plain }) };
  }
  const file = args[args.indexOf("-f") + 1];
  const dirs = await composeCheckoutDirsForFile(
    file,
    COMPOSE_STAGE_DIRNAME,
    COMPOSE_PREVIOUS_DIRNAME,
  );
  if (dirs === null) return { args: [...args], cwd: plain };
  // Compose reads `.env` from the project directory, which is now inside the
  // checkout: name the one the daemon wrote beside the compiled file.
  const envFile = join(plain, COMPOSE_ENV_FILENAME);
  const hasEnv = await Deno.stat(envFile).then((s) => s.isFile, () => false);
  return {
    args: [
      "compose",
      "--project-directory",
      dirs.projectDir,
      ...(hasEnv && !args.includes("--env-file")
        ? ["--env-file", envFile]
        : []),
      ...args.slice(1),
    ],
    cwd: dirs.root,
  };
}

export type DockerCliRunRawFn = (
  command: string,
  args: string[],
  options?: RunRawOptions,
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
   * The `--config` folder to use. A test override leaves the flag off unless it
   * names one, so nothing here touches the real `/run/turbopanel`.
   */
  configDir?: string;
  /** Replaces `Deno.lstatSync` / `Deno.uid()` when vetting the config folder. */
  lstatSync?: (path: string) => {
    isDirectory: boolean;
    isSymlink: boolean;
    uid: number | null;
    mode: number | null;
  };
  uid?: number;
  /**
   * When set, {@link spawnDockerStreaming} uses this instead of
   * `Deno.Command.spawn` (binary dump path — never decode into a string).
   */
  spawnStreaming?: (
    bin: string,
    args: string[],
    options?: SpawnDockerStreamingOptions & { env?: Record<string, string> },
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

/**
 * True when the Docker CLI binary exists on this host. A site-only host never
 * installs Docker, so stop/teardown steps use this to skip Docker work
 * instead of failing with `Failed to spawn /usr/bin/docker`.
 */
export async function dockerBinaryInstalled(): Promise<boolean> {
  try {
    return (await Deno.stat(resolvedDockerBin())).isFile;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

function clearDockerInvocationCache(): void {
  cachedInvocation = undefined;
  cachedInvocationPromise = undefined;
  ensuredConfigDir = undefined;
  configDirResolved = false;
  warnedConfigDir = false;
}

function isDockerSocketPermissionError(text: string): boolean {
  const lower = text.toLowerCase();
  if (!lower.includes("permission denied")) return false;
  // Match only the CLI's socket-dial failure, not arbitrary daemon errors that
  // happen to contain "docker" + "permission denied" (e.g. a bind-mount EACCES
  // reported as "docker: Error response from daemon: … permission denied").
  return lower.includes("docker daemon socket") ||
    lower.includes("docker api at unix://") ||
    lower.includes("docker.sock");
}

/** True when docker CLI reported a socket permission error on stdout or stderr. */
export function dockerOutputLooksLikeSocketPermission(
  stdout: string,
  stderr: string,
): boolean {
  return isDockerSocketPermissionError(stderr) ||
    isDockerSocketPermissionError(stdout);
}

function isStdinClosedEarlyMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("writable stream is closed") ||
    lower.includes("broken pipe") ||
    lower.includes("epipe");
}

/**
 * Write `input` and close stdin. When the child already exited, Deno
 * throws EPIPE / "Writable stream is closed" — swallow that so callers
 * can surface the process's real stderr/exit instead of the stream error.
 */
async function writePipedStdin(
  stdin: WritableStream<Uint8Array>,
  input: string,
): Promise<string | undefined> {
  const writer = stdin.getWriter();
  try {
    await writer.write(new TextEncoder().encode(input));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writer.close().catch(() => {});
    if (isStdinClosedEarlyMessage(message)) return message;
    throw err;
  }
  try {
    await writer.close();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isStdinClosedEarlyMessage(message)) return message;
    throw err;
  }
  return undefined;
}

/**
 * Build the result for a finished child. A failed child keeps its own
 * stderr/stdout; the closed-stdin note is only used when it printed nothing.
 */
function dockerResultFromParts(
  success: boolean,
  code: number,
  stdout: string,
  stderr: string,
  stdinClosedEarly?: string,
): DockerCliResult {
  if (success) return { success: true, code, stdout, stderr };
  return {
    success: false,
    code,
    stdout,
    stderr: stderr || stdout ||
      (stdinClosedEarly ? `spawn failed: ${stdinClosedEarly}` : ""),
  };
}

function dockerResultFromChildOutput(
  result: Deno.CommandOutput,
  stdinClosedEarly?: string,
): DockerCliResult {
  return dockerResultFromParts(
    result.success,
    result.code,
    decoder.decode(result.stdout).trim(),
    decoder.decode(result.stderr).trim(),
    stdinClosedEarly,
  );
}

async function runRawDefault(
  command: string,
  args: string[],
  options?: RunRawOptions,
): Promise<DockerCliResult> {
  try {
    const hasInput = options?.input !== undefined;
    const child = new Deno.Command(command, {
      args,
      ...(options?.env === undefined ? {} : { env: options.env }),
      ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
      stdin: hasInput ? "piped" : "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    const stdinClosedEarly = hasInput
      ? await writePipedStdin(child.stdin, options?.input ?? "")
      : undefined;

    return dockerResultFromChildOutput(await child.output(), stdinClosedEarly);
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
  options?: RunRawOptions,
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
  options?: RunRawOptions,
): Promise<DockerCliResult> {
  const user = await currentUsername();
  return await runRaw(
    SUDO_BIN,
    [
      "-n",
      "-u",
      user,
      "--",
      ...sudoEnvPrefix(),
      resolvedDockerBin(),
      ...args,
    ],
    options,
  );
}

/** Last-resort: passwordless root docker when the daemon user cannot open the socket. */
async function runDockerAsRoot(
  args: string[],
  options?: RunRawOptions,
): Promise<DockerCliResult> {
  return await runRaw(
    SUDO_BIN,
    ["-n", "--", ...sudoEnvPrefix(), resolvedDockerBin(), ...args],
    options,
  );
}

/**
 * True when Deno refused the spawn itself because this process's `--allow-run`
 * list does not name the program (a scoped runner such as the scheduled-backup
 * one is not granted `sudo`). Nothing was run, so the escalation rung has told
 * us nothing about the Docker socket and must not mask its real error.
 */
function deniedByDenoPermissions(result: DockerCliResult): boolean {
  return result.stderr.includes("Requires run access");
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
 * True when a sudo rung failed to *reach the socket* (sudo itself refused, or
 * docker still hit the socket permission wall) rather than the docker command
 * genuinely running and failing. Only in the former case should the ladder
 * keep climbing / fall back to the original socket error — otherwise the real
 * command failure (e.g. a non-zero pg_basebackup) must be reported verbatim.
 */
function escalationBlocked(result: DockerCliResult): boolean {
  return deniedByDenoPermissions(result) ||
    result.stderr.toLowerCase().includes("sudo:") ||
    dockerOutputLooksLikeSocketPermission(result.stdout, result.stderr);
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
  userArgs: string[],
  options?: RunDockerOptions,
): Promise<DockerCliResult> {
  const call = await composeCall(userArgs);
  const args = withDockerConfig(call.args);
  const cwd = call.cwd === undefined ? {} : { cwd: call.cwd };
  const direct = await runRaw(resolvedDockerBin(), args, {
    ...options,
    ...cwd,
    env: dockerConfigEnv(),
  });
  if (
    direct.success ||
    !dockerOutputLooksLikeSocketPermission(direct.stdout, direct.stderr)
  ) {
    return direct;
  }

  const refreshed = await runDockerWithFreshGroups(args, {
    ...options,
    ...cwd,
  });
  // A non-blocked failure means the command actually ran via sudo and failed
  // on its own merits — return it verbatim instead of re-running as root and
  // masking the real error behind the direct socket-permission message.
  if (refreshed.success || !escalationBlocked(refreshed)) return refreshed;

  const asRoot = await runDockerAsRoot(args, { ...options, ...cwd });
  if (asRoot.success || !escalationBlocked(asRoot)) return asRoot;
  // Every rung failed to reach the socket; report the original docker.sock error.
  return preferOriginalSocketError(direct, asRoot);
}

/** `docker version` through the same escalation ladder as every other call. */
export async function dockerEngineProbe(): Promise<DockerCliResult> {
  return await runDocker([
    "version",
    "--format",
    "{{.Server.Version}}",
  ]);
}

/** True when `docker version` can talk to the Engine API. */
export async function dockerEngineReachable(): Promise<boolean> {
  return (await dockerEngineProbe()).success;
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
  const probeArgs = withDockerConfig(PROBE_ARGS);
  const direct = await runRaw(dockerBin, probeArgs, {
    env: dockerConfigEnv(),
  });
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
  const selfPrefix = ["-n", "-u", user, "--", ...sudoEnvPrefix(), dockerBin];
  const refreshed = await runRaw(SUDO_BIN, [...selfPrefix, ...probeArgs]);
  if (refreshed.success) return { bin: SUDO_BIN, prefixArgs: selfPrefix };
  // This process may not run sudo at all: keep the direct invocation so the
  // caller sees Docker's own socket error, not a Deno permission error.
  if (deniedByDenoPermissions(refreshed)) {
    return { bin: dockerBin, prefixArgs: [] };
  }

  const rootPrefix = ["-n", "--", ...sudoEnvPrefix(), dockerBin];
  const asRoot = await runRaw(SUDO_BIN, [...rootPrefix, ...probeArgs]);
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
  /** Kills the child when aborted (a bounded build, say). */
  signal?: AbortSignal;
  /** The folder the child starts in (see {@link composeWorkingDirectory}). */
  cwd?: string;
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
  const fullArgs = [
    ...invocation.prefixArgs,
    ...(withDockerConfig(args)),
  ];
  const spawnOverride = ioOverride?.spawnStreaming;
  if (spawnOverride) {
    return await spawnOverride(invocation.bin, fullArgs, {
      ...options,
      env: dockerConfigEnv(),
    });
  }
  return new Deno.Command(invocation.bin, {
    args: fullArgs,
    env: dockerConfigEnv(),
    stdin: options?.stdin ?? "null",
    stdout: options?.stdout ?? "piped",
    stderr: "piped",
    ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
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
  /** Kills docker when aborted; the result then reports the killed exit. */
  signal?: AbortSignal;
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
    const call = await composeCall(args);
    const child = await spawnDockerStreaming(call.args, {
      stdin: hasInput ? "piped" : "null",
      stdout: "piped",
      ...(call.cwd === undefined ? {} : { cwd: call.cwd }),
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });

    const stdinClosedEarly = hasInput
      ? await writePipedStdin(child.stdin, options?.input ?? "")
      : undefined;

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

    return dockerResultFromParts(
      status.success,
      status.code,
      stdout.trim(),
      stderr.trim(),
      stdinClosedEarly,
    );
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
