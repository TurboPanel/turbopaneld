/**
 * Run a release's install / build commands.
 *
 * On a managed host they run in the **build sandbox** (`./build-sandbox.ts`):
 * as the unprivileged build account, in a transient systemd unit tp-host
 * fixes (no Docker, no daemon state or secrets, no private-range or metadata
 * egress, memory / CPU / task / time caps), over the work tree the daemon
 * cloned into and gets back only once the unit is gone. Anyone who can deploy
 * may define these commands, so nothing about them is trusted.
 *
 * A development install runs them as the developer in the checkout, with `clearEnv` plus an explicit
 * allow-list so no daemon credential material is inherited.
 *
 * Either way output is streamed line-by-line so it reaches the transcript
 * under the `build` phase while the build is still running.
 */

import { dirname, isAbsolute, join, relative } from "@std/path";
import {
  BUILD_OUTPUT_LIMITS,
  type PumpLimits,
  pumpLines,
} from "../../logs/line-stream.ts";
import type { CommandSummaryRedactor } from "../../logs/contracts.ts";
import { redactCommandSummary } from "../../logs/redactor.ts";
import type {
  EnvironmentDeployNativeAppService,
  EnvironmentDeploySourceBuild,
} from "../../contracts/commands-contracts.ts";
import type { ReleaseOutputHandler } from "./checkout.ts";
import { normalizeNodePackageManagerCommand } from "../node-package-manager.ts";
import {
  describeNativeAppStart,
  type NativeAppStart,
  NEXT_CLI_PATH,
  normalizeNativeAppStartPath,
} from "../native/start-entry.ts";
import {
  type ContainedPath,
  copyContainedTree,
  inspectContainedDir,
} from "./safe-copy.ts";
import {
  type DenoConfig,
  type DenoProjectFiles,
  deriveDenoBuildCommand,
  deriveDenoCacheCommand,
  deriveDenoInstallCommand,
  detectDenoStart,
  readDenoConfig,
} from "./deno-build.ts";
import { forEachSequential } from "../../util/sequential.ts";
import { throwIfAborted, withCancelSignal } from "../deploy-cancel.ts";
import { definedFields } from "../../util/optional-fields.ts";
import type { RunFn } from "../ensure-principal.ts";
import {
  type BuildWork,
  isSpecEnvName,
  renderBuildSpec,
  runSandboxedBuild,
} from "./build-sandbox.ts";

/** Build ceiling. Long enough for a cold dependency install, not unbounded. */
export const BUILD_TIMEOUT_MS = 1_800_000;

/**
 * Host binaries a native build may resolve after the tenant Node `bin/`.
 * Do not inherit the daemon PATH: Deno's `node_compat_bin` would shadow
 * `node`, and an unreadable `/usr/local/sbin` makes dash report
 * `Permission denied` for a missing `corepack` (POSIX `eacces` sticky bit).
 */
const NATIVE_BUILD_PATH_TAIL = "/usr/bin:/bin";

/** Environment keys a build command may never set — they are the sandbox. */
const RESERVED_BUILD_ENV_KEYS = new Set([
  "GIT_ASKPASS",
  "GIT_SSH_COMMAND",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "PATH",
  "HOME",
  // Shell start-up files and options: `sh -c` reads `ENV` / `BASH_ENV`, and
  // `SHELLOPTS` / `BASHOPTS` / `PS4` / `PROMPT_COMMAND` run code or reshape it.
  "ENV",
  "BASH_ENV",
  "SHELLOPTS",
  "BASHOPTS",
  "PS4",
  "PROMPT_COMMAND",
  "IFS",
  // libc and git lookups that load code from a tenant-chosen path.
  "GCONV_PATH",
  "GLIBC_TUNABLES",
  "LOCPATH",
  "NLSPATH",
  "HOSTALIASES",
  "GIT_EXEC_PATH",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_COUNT",
]);

/** `LD_*` is the dynamic loader's namespace (`LD_AUDIT`, `LD_DEBUG_OUTPUT`, …). */
function isReservedBuildEnvKey(key: string): boolean {
  return RESERVED_BUILD_ENV_KEYS.has(key) || key.startsWith("LD_");
}

const defaultSummaryRedactor: CommandSummaryRedactor = (text) =>
  redactCommandSummary(text);

/**
 * Native-app runtime context for a build. Present only when the release
 * belongs to a `nativeAppServices[]` entry — it is what puts the vendored
 * tenant Node (and its bundled npm/npx/corepack) on the build `PATH`, and what
 * lets `NODE_ENV` follow the operator's application mode.
 */
export type NativeBuildRuntime = {
  /**
   * `node` (the default) or `deno`. A Deno build puts Deno on `PATH`, gets a
   * `DENO_DIR` and derives `deno install` / `deno task build` instead of the
   * Node package-manager commands.
   */
  runtime?: "node" | "deno";
  /**
   * `dirname(nativeAppNodeBinary(layout, series))` — prefixed onto `PATH`. For
   * a Deno build, the vendored Deno's `bin` directory instead.
   */
  nodeBinDir: string;
  /** Operator's application mode; `production` when undeclared. */
  nodeEnv: "production" | "development";
};

export type ReleaseBuildParams = {
  build: EnvironmentDeploySourceBuild;
  /** Checked-out working tree; commands run here (or in `subdirectory`). */
  workingDir: string;
  /** Set for native-app builds; absent for every other release kind. */
  nativeRuntime?: NativeBuildRuntime;
  onOutput?: ReleaseOutputHandler;
  redactSummary?: CommandSummaryRedactor;
  /**
   * Run in the build sandbox (a managed host). `workingDir` must then be the
   * spec's `cwd` inside `sandbox.work.workDir`.
   */
  sandbox?: SandboxBuildTarget;
  /**
   * Cancel signal of the deploy. Aborting it stops the running build (the
   * sandbox unit on a managed host) and throws `DeployCancelledError`.
   */
  signal?: AbortSignal;
  /**
   * Test seam for the unsandboxed (development) command runner. Defaults to
   * spawning `sh -c`.
   */
  runCommand?: (
    command: string,
    cwd: string,
    env: Record<string, string>,
    onOutput?: ReleaseOutputHandler,
    redactSummary?: CommandSummaryRedactor,
  ) => Promise<void>;
};

/** Where and how a sandboxed build runs. */
export type SandboxBuildTarget = {
  work: BuildWork;
  /** The build directory relative to `work.workDir` (`source[/subdir]`). */
  cwd: string;
  /** Privileged runner for `build-return` / `systemctl stop`. */
  runFn?: RunFn;
  /** Test seam — defaults to {@link runSandboxedBuild}. */
  run?: typeof runSandboxedBuild;
};

/**
 * Non-secret build environment. Build secrets ride `variableMaterial[]` /
 * `secretPlan[]` and are materialized as files by the deploy path — they are
 * deliberately not merged in here.
 */
export function buildEnvironment(
  build: EnvironmentDeploySourceBuild,
  workingDir: string,
  nativeRuntime?: NativeBuildRuntime,
): Record<string, string> {
  const daemonPath = Deno.env.get("PATH") ?? "/usr/local/bin:/usr/bin:/bin";
  const env: Record<string, string> = {
    // The vendored tenant Node leads PATH for a native-app build so `node`,
    // `npm`, `npx`, and `corepack` all resolve to the series the app runs on.
    PATH: nativeRuntime
      ? `${nativeRuntime.nodeBinDir}:${NATIVE_BUILD_PATH_TAIL}`
      : daemonPath,
    HOME: workingDir,
    CI: "1",
    // Signals to the usual toolchains that this is a production build.
    NODE_ENV: nativeRuntime?.nodeEnv ?? "production",
  };
  if (nativeRuntime?.runtime === "deno") {
    Object.assign(env, denoBuildEnvironment(join(workingDir, ".deno")));
  } else if (nativeRuntime) {
    // Corepack caches per checkout, never in the daemon's own home, and must
    // not stop a build to ask whether downloading yarn/pnpm is okay.
    env.COREPACK_HOME = join(workingDir, ".corepack");
    env.COREPACK_ENABLE_DOWNLOAD_PROMPT = "0";
  }
  // A name no shell can carry also cannot ride an `env NAME=value` argv.
  const tenant = Object.fromEntries(
    Object.entries(tenantBuildEnv(build)).filter(([key]) => isSpecEnvName(key)),
  );
  return { ...env, ...tenant };
}

/**
 * Deno's build environment: its cache in `denoDir` (never the daemon's home),
 * no update check, and no permission prompt (there is no terminal to answer).
 */
function denoBuildEnvironment(denoDir: string): Record<string, string> {
  return {
    DENO_DIR: denoDir,
    DENO_NO_UPDATE_CHECK: "1",
    DENO_NO_PROMPT: "1",
  };
}

/** The tenant's own `build.env`, minus the keys that are the sandbox. */
function tenantBuildEnv(
  build: EnvironmentDeploySourceBuild,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(build.env ?? {}).filter(([key]) =>
      !isReservedBuildEnvKey(key)
    ),
  );
}

/**
 * Environment for a sandboxed build, on top of the runner's own `HOME` (the
 * work tree), `PATH=/usr/local/bin:/usr/bin:/bin` and `TMPDIR` (in the work tree).
 * Package-manager caches live in the project's bound cache directory, never in
 * the checkout (which a release may ship as-is). A tenant variable whose name
 * no shell can carry is dropped with a transcript line.
 */
export function sandboxBuildEnvironment(
  build: EnvironmentDeploySourceBuild,
  work: BuildWork,
  nativeRuntime?: NativeBuildRuntime,
  onOutput?: ReleaseOutputHandler,
): Record<string, string> {
  const env: Record<string, string> = {
    CI: "1",
    NODE_ENV: nativeRuntime?.nodeEnv ?? "production",
    XDG_CACHE_HOME: join(work.cacheDir, "xdg"),
    npm_config_cache: join(work.cacheDir, "npm"),
  };
  if (nativeRuntime) {
    env.PATH = `${nativeRuntime.nodeBinDir}:${NATIVE_BUILD_PATH_TAIL}`;
    if (nativeRuntime.runtime === "deno") {
      Object.assign(env, denoBuildEnvironment(join(work.cacheDir, "deno")));
    } else {
      env.COREPACK_HOME = join(work.cacheDir, "corepack");
      env.COREPACK_ENABLE_DOWNLOAD_PROMPT = "0";
    }
  }
  for (const [key, value] of Object.entries(tenantBuildEnv(build))) {
    if (isSpecEnvName(key)) {
      env[key] = value;
    } else {
      onOutput?.("stderr", `skipping build variable ${key}: not a shell name`);
    }
  }
  return env;
}

/**
 * A bare `sh -c` (development builds). Exported so host-free suites can
 * assert the argv shape without spawning.
 */
export function buildInvocation(command: string): {
  bin: string;
  args: string[];
} {
  return { bin: "sh", args: ["-c", command] };
}

const OUTPUT_LIMIT_MESSAGE =
  "build output exceeded the size limit; the build was stopped";

/** Wait for the build, tailing its output through `onOutput` under the output cap. */
function collectBuildOutput(
  child: Deno.ChildProcess,
  onOutput: ReleaseOutputHandler | undefined,
  limits: PumpLimits,
): Promise<[Deno.CommandStatus, string, string]> {
  const forward = (stream: "stdout" | "stderr") =>
    onOutput ? (line: string) => onOutput(stream, line) : undefined;
  return Promise.all([
    child.status,
    pumpLines(child.stdout, forward("stdout"), limits),
    pumpLines(child.stderr, forward("stderr"), limits),
  ]);
}

async function runBuildCommand(
  command: string,
  cwd: string,
  env: Record<string, string>,
  onOutput?: ReleaseOutputHandler,
  redactSummary: CommandSummaryRedactor = defaultSummaryRedactor,
  cancelSignal?: AbortSignal,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BUILD_TIMEOUT_MS);
  const signal = withCancelSignal(controller.signal, cancelSignal);
  const { bin, args } = buildInvocation(command);
  let outputExceeded = false;
  const limits = {
    ...BUILD_OUTPUT_LIMITS,
    onLimit: () => {
      outputExceeded = true;
      controller.abort();
    },
  };
  const abortMessage = () =>
    outputExceeded
      ? OUTPUT_LIMIT_MESSAGE
      : `build command timed out after ${BUILD_TIMEOUT_MS}ms`;
  try {
    const child = new Deno.Command(bin, {
      args,
      cwd,
      env,
      clearEnv: true,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal,
    }).spawn();
    const [status, stdout, stderr] = await collectBuildOutput(
      child,
      onOutput,
      limits,
    );
    if (outputExceeded) throw new Error(OUTPUT_LIMIT_MESSAGE);
    if (!status.success) {
      throw new Error(
        redactSummary(stderr.trim()) || redactSummary(stdout.trim()) ||
          `build command failed: ${command}`,
      );
    }
  } catch (err) {
    throwIfAborted(cancelSignal, "while the build was running");
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(abortMessage());
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
  throwIfAborted(cancelSignal, "while the build was running");
}

/**
 * True when `package.json` pins Yarn Berry (2+), or a `.yarnrc.yml` marks the
 * checkout as a Berry project. Berry has no `--production` flag (and ignores
 * `NODE_ENV` during install), so the classic-only dev-deps flag must not be
 * passed to it.
 */
async function yarnIsBerry(workingDir: string): Promise<boolean> {
  try {
    if (!(await regularFileExists(join(workingDir, "package.json")))) {
      return await regularFileExists(join(workingDir, ".yarnrc.yml"));
    }
    const raw = await Deno.readTextFile(join(workingDir, "package.json"));
    const pin = JSON.parse(raw)?.packageManager;
    const match = typeof pin === "string" ? /^yarn@(\d+)/.exec(pin) : null;
    if (match) return Number(match[1]) >= 2;
  } catch {
    // Unreadable/unparseable package.json — fall through to the file probe.
  }
  return await regularFileExists(join(workingDir, ".yarnrc.yml"));
}

type NodeManagerName = "pnpm" | "yarn" | "npm";

type PackageJson = Record<string, unknown>;

/**
 * `package.json` at the root of `dir`, parsed — only when it is a regular file
 * (not a link: the checkout is tenant content, and a link named package.json
 * must not make the daemon read whatever it points at) holding a JSON object.
 */
async function readPackageJson(dir: string): Promise<PackageJson | undefined> {
  const path = join(dir, "package.json");
  if (!(await regularFileExists(path))) return undefined;
  try {
    const parsed: unknown = JSON.parse(await Deno.readTextFile(path));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return Array.isArray(parsed) ? undefined : parsed as PackageJson;
  } catch {
    return undefined;
  }
}

/** A non-empty `scripts.<name>` from `package.json`, or `undefined`. */
function packageScript(pkg: PackageJson, name: string): string | undefined {
  const scripts = pkg.scripts;
  if (typeof scripts !== "object" || scripts === null) return undefined;
  const value = (scripts as Record<string, unknown>)[name];
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

/** The manager and major version `package.json`'s `packageManager` pins. */
function packageManagerPin(
  pkg: PackageJson | undefined,
): { name: NodeManagerName; major: number } | undefined {
  const pin = pkg?.packageManager;
  const match = typeof pin === "string"
    ? /^(pnpm|yarn|npm)@(\d+)/.exec(pin)
    : null;
  if (!match) return undefined;
  return { name: match[1] as NodeManagerName, major: Number(match[2]) };
}

/** Which package manager a native build uses, and what told us. */
type NodeManagerChoice = {
  manager: NodeManagerName;
  pin: { name: NodeManagerName; major: number } | undefined;
  hasPnpmLock: boolean;
  hasYarnLock: boolean;
  pkg: PackageJson | undefined;
};

/**
 * The package manager for a native build, by the usual convention: the operator's `build.packageManager` wins, then `package.json`'s
 * `packageManager` pin, then the lockfile (`pnpm-lock.yaml` > `yarn.lock` >
 * npm). `undefined` when there is no `package.json` at all.
 */
async function resolveNodeManager(params: {
  packageManager?: EnvironmentDeploySourceBuild["packageManager"];
  workingDir: string;
}): Promise<NodeManagerChoice | undefined> {
  const has = (name: string) =>
    regularFileExists(join(params.workingDir, name));
  if (!(await has("package.json"))) return undefined;
  const [hasPnpmLock, hasYarnLock, pkg] = await Promise.all([
    has("pnpm-lock.yaml"),
    has("yarn.lock"),
    readPackageJson(params.workingDir),
  ]);
  let lockfileManager: NodeManagerName = "npm";
  if (hasPnpmLock) lockfileManager = "pnpm";
  else if (hasYarnLock) lockfileManager = "yarn";
  const pin = packageManagerPin(pkg);
  return {
    manager: params.packageManager ?? pin?.name ?? lockfileManager,
    pin,
    hasPnpmLock,
    hasYarnLock,
    pkg,
  };
}

/**
 * The flag that keeps `devDependencies` in a pnpm install under the build's
 * `NODE_ENV=production`, per pnpm major (checked against the real binaries):
 *
 * - pnpm 9 drops dev dependencies under `NODE_ENV=production` and takes
 *   `--prod=false` to keep them.
 * - pnpm 10, 11 and 12 install them anyway, and pnpm 12 rejects
 *   `--prod=false` outright (`--prod` became a plain boolean flag), so no flag.
 * - With no pin the version Corepack resolves is unknown, so use
 *   `--config.production=false`, a setting override every pnpm 9-12 accepts.
 */
function pnpmDevDepsArgs(major: number | undefined): string[] {
  if (major === undefined) return ["--config.production=false"];
  return major < 10 ? ["--prod=false"] : [];
}

/**
 * Derive the install command for a native-app build from the operator's
 * package-manager choice, falling back to lockfile detection
 * (`pnpm-lock.yaml` > `yarn.lock` > `package-lock.json` > bare npm).
 *
 * The dev-deps flags (`--include=dev`, `--production=false`, and for pnpm
 * whatever `pnpmDevDepsArgs` picks for the pinned major) are load-bearing: the build environment sets `NODE_ENV=production`, under
 * which npm, pnpm, and classic yarn silently omit devDependencies — which is
 * where every build toolchain lives.
 *
 * Returns `undefined` when there is no `package.json` to install from.
 */
export async function deriveNodeInstallCommand(params: {
  packageManager?: EnvironmentDeploySourceBuild["packageManager"];
  workingDir: string;
}): Promise<string | undefined> {
  const choice = await resolveNodeManager(params);
  if (!choice) return undefined;
  const { manager, pin } = choice;

  if (manager === "pnpm") {
    return [
      "corepack pnpm install",
      ...(choice.hasPnpmLock ? ["--frozen-lockfile"] : []),
      ...pnpmDevDepsArgs(pin?.name === "pnpm" ? pin.major : undefined),
    ].join(" ");
  }
  if (manager === "yarn") {
    // CI=1 already makes Berry installs immutable when a lockfile exists.
    if (await yarnIsBerry(params.workingDir)) return "corepack yarn install";
    return choice.hasYarnLock
      ? "corepack yarn install --frozen-lockfile --production=false"
      : "corepack yarn install --production=false";
  }
  const [hasLock, hasShrinkwrap] = await Promise.all([
    regularFileExists(join(params.workingDir, "package-lock.json")),
    regularFileExists(join(params.workingDir, "npm-shrinkwrap.json")),
  ]);
  return hasLock || hasShrinkwrap
    ? "npm ci --include=dev"
    : "npm install --include=dev";
}

/**
 * Derive the build command for a native-app build: the package's own `build`
 * script, run through the same package manager the install picked
 * ({@link resolveNodeManager}) — `corepack pnpm run build`,
 * `corepack yarn run build`, or `npm run build`. Corepack, because bare
 * `pnpm` / `yarn` are not on the native build `PATH`.
 *
 * Returns `undefined` when there is no `package.json` or it has no `build`
 * script: a plain Node app with nothing to compile ships as installed.
 */
export async function deriveNodeBuildCommand(params: {
  packageManager?: EnvironmentDeploySourceBuild["packageManager"];
  workingDir: string;
}): Promise<string | undefined> {
  const choice = await resolveNodeManager(params);
  if (!choice?.pkg || packageScript(choice.pkg, "build") === undefined) {
    return undefined;
  }
  return choice.manager === "npm"
    ? "npm run build"
    : `corepack ${choice.manager} run build`;
}

/** @deprecated Use {@link normalizeNodePackageManagerCommand}. */
export {
  normalizeNodePackageManagerCommand as normalizeNodeBuildCommand,
} from "../node-package-manager.ts";

/** What the transcript says decided a derived command. */
function derivationSource(params: ReleaseBuildParams): string {
  return params.build.packageManager ?? "lockfile detection";
}

/**
 * The install command: the author's, else (native app only) one derived from
 * the package manager / lockfile ({@link deriveNodeInstallCommand}).
 */
async function resolveInstallCommand(
  params: ReleaseBuildParams,
): Promise<string | undefined> {
  const explicit = params.build.installCommand;
  if (explicit !== undefined || !params.nativeRuntime) return explicit;
  if (params.nativeRuntime.runtime === "deno") {
    const files = preBuildDenoFiles(params.workingDir);
    const derived = await deriveDenoInstallCommand(
      files,
      await readDenoConfig(files),
    );
    if (derived !== undefined) {
      params.onOutput?.(
        "stdout",
        "derived install command from the Deno project files (lockfile, package.json or nodeModulesDir)",
      );
    }
    return derived;
  }
  const derived = await deriveNodeInstallCommand({
    packageManager: params.build.packageManager,
    workingDir: params.workingDir,
  });
  if (derived !== undefined) {
    params.onOutput?.(
      "stdout",
      `derived install command from ${derivationSource(params)}`,
    );
  }
  return derived;
}

/**
 * The build command: the author's (with bare `pnpm` / `yarn` put through
 * Corepack on the native lane), else (native app only) the package's `build`
 * script ({@link deriveNodeBuildCommand}), or for a Deno app the config's
 * `build` task.
 */
async function resolveBuildCommand(
  params: ReleaseBuildParams,
): Promise<string | undefined> {
  const explicit = params.build.buildCommand;
  if (!params.nativeRuntime) return explicit;
  if (params.nativeRuntime.runtime === "deno") {
    if (explicit !== undefined) return explicit;
    const derived = deriveDenoBuildCommand(
      await readDenoConfig(preBuildDenoFiles(params.workingDir)),
    );
    if (derived !== undefined) {
      params.onOutput?.(
        "stdout",
        "derived build command from deno.json (it has a build task)",
      );
    }
    return derived;
  }
  if (explicit === undefined) {
    const derived = await deriveNodeBuildCommand({
      packageManager: params.build.packageManager,
      workingDir: params.workingDir,
    });
    if (derived !== undefined) {
      params.onOutput?.(
        "stdout",
        `derived build command from ${
          derivationSource(params)
        } (package.json has a build script)`,
      );
    }
    return derived;
  }
  const normalized = normalizeNodePackageManagerCommand(explicit);
  if (explicit && normalized !== explicit) {
    params.onOutput?.(
      "stdout",
      "normalized build command for Corepack (bare pnpm/yarn is not on the native build PATH)",
    );
    return normalized;
  }
  return explicit;
}

/**
 * A Deno app whose author typed no install or build command also fetches its
 * entry's imports at build time, with the build's network, and so writes
 * `deno.lock` into the tree: `deno cache <entry>`. Without a lockfile `deno run`
 * dies on a read-only release trying to write one.
 */
async function deriveDenoCacheStep(
  params: ReleaseBuildParams,
): Promise<string | undefined> {
  const files = preBuildDenoFiles(params.workingDir);
  const cache = await deriveDenoCacheCommand(
    files,
    await readDenoConfig(files),
  );
  if (cache !== undefined) {
    params.onOutput?.(
      "stdout",
      "caching the app's imports and writing deno.lock (the release is read-only at run time)",
    );
  }
  return cache;
}

/** The tree before the build runs: the checkout, read as plain files. */
function preBuildDenoFiles(workingDir: string): DenoProjectFiles {
  return denoProjectFiles(
    workingDir,
    (path) => regularFileExists(join(workingDir, path)),
  );
}

/** Regular files only (a link named `deno.json` is not read). */
function denoProjectFiles(
  rootDir: string,
  entryExists: (path: string) => Promise<boolean>,
): DenoProjectFiles {
  return {
    async read(name) {
      const path = join(rootDir, name);
      if (!(await regularFileExists(path))) return undefined;
      try {
        return await Deno.readTextFile(path);
      } catch {
        return undefined;
      }
    },
    exists: (name) => regularFileExists(join(rootDir, name)),
    entryExists,
  };
}

/**
 * Run `installCommand` then `buildCommand`. A missing command is a no-op — a
 * source with neither is a valid "ship the repository as-is" release — except
 * for a native-app build, where both are derived by the usual Node convention: the install from the package manager / lockfile, the build from the
 * package's `build` script. So all three managers deploy without the operator
 * typing a command, and an explicit command always wins.
 */
export async function runReleaseBuild(
  params: ReleaseBuildParams,
): Promise<void> {
  const installCommand = await resolveInstallCommand(params);
  const buildCommand = await resolveBuildCommand(params);
  // After a derived install / build too: the lock they leave may not cover
  // the entry's own imports, and the release is read-only at run time.
  const cacheCommand = params.nativeRuntime?.runtime === "deno" &&
      params.build.installCommand === undefined &&
      params.build.buildCommand === undefined
    ? await deriveDenoCacheStep(params)
    : undefined;
  const commands = [
    installCommand,
    buildCommand,
    cacheCommand,
  ].filter((command): command is string => Boolean(command));
  if (commands.length === 0) {
    params.onOutput?.(
      "stdout",
      "no install or build command — shipping the checkout as-is",
    );
    return;
  }

  if (params.sandbox) {
    await runSandboxedCommands(params, params.sandbox, commands);
    return;
  }
  const env = buildEnvironment(
    params.build,
    params.workingDir,
    params.nativeRuntime,
  );
  const execute = params.runCommand ??
    ((command, cwd, commandEnv, commandOnOutput, commandRedactSummary) =>
      runBuildCommand(
        command,
        cwd,
        commandEnv,
        commandOnOutput,
        commandRedactSummary,
        params.signal,
      ));
  // Build commands run in order and stop at the first failure.
  await forEachSequential(commands, async (command) => {
    throwIfAborted(params.signal, "before the build ran");
    params.onOutput?.("stdout", `$ ${command}`);
    await execute(
      command,
      params.workingDir,
      env,
      params.onOutput,
      params.redactSummary,
    );
  });
}

/**
 * One spec, one unit: the runner runs the commands in order and stops at the
 * first failure, exactly like the unsandboxed loop.
 */
async function runSandboxedCommands(
  params: ReleaseBuildParams,
  sandbox: SandboxBuildTarget,
  commands: string[],
): Promise<void> {
  const env = sandboxBuildEnvironment(
    params.build,
    sandbox.work,
    params.nativeRuntime,
    params.onOutput,
  );
  for (const command of commands) params.onOutput?.("stdout", `$ ${command}`);
  params.onOutput?.(
    "stdout",
    `running ${commands.length} command(s) as the build account in turbopanel-build-${sandbox.work.buildId}.service`,
  );
  await (sandbox.run ?? runSandboxedBuild)(definedFields({
    work: sandbox.work,
    spec: renderBuildSpec({ cwd: sandbox.cwd, env, commands }),
    onOutput: params.onOutput,
    redactSummary: params.redactSummary,
    runFn: sandbox.runFn,
    signal: params.signal,
  }));
}

/**
 * Next.js standalone output, relative to the build working directory.
 *
 * `next build` with `output: 'standalone'` emits a self-contained server tree
 * here — including a pruned `node_modules` — but deliberately **not** the
 * static assets, which Next expects the deployer to copy in. Shipping the
 * standalone tree instead of the whole checkout is what makes a native release
 * small enough to keep several of them around for rollback.
 */
export const NEXT_STANDALONE_DIR = join(".next", "standalone");
const NEXT_STATIC_DIR = join(".next", "static");
const NEXT_PUBLIC_DIR = "public";

/**
 * `output: 'export'` output, relative to the build working directory.
 *
 * A statically exported Next build emits a complete, server-free site here.
 * There is no `server.js` and no runtime to supervise, so this is the signal
 * that the release belongs on the site **static** lane rather than
 * on the native systemd one.
 */
export const NEXT_EXPORT_DIR = "out";

/**
 * Whether `relative` is a real directory of the build tree. A symlink on the
 * way is refused outright (`./safe-copy.ts`): the build controls these names,
 * and following one would let it pick what the daemon reads or writes.
 */
async function buildDirExists(
  tree: BuildTree,
  relative: string,
): Promise<boolean> {
  return await inspectContainedDir(tree.at(relative)) === "directory";
}

/**
 * The build directory as seen from its containment root: `work/<id>` for a
 * sandboxed build (everything under it, the checkout included, was the
 * build's to rename), else the build directory itself.
 */
type BuildTree = { at: (relative: string) => ContainedPath };

function buildTree(workingDir: string, containmentRoot?: string): BuildTree {
  const root = containmentRoot ?? workingDir;
  const prefix = relative(root, workingDir);
  if (prefix.startsWith("..") || isAbsolute(prefix)) {
    throw new Error(`build directory ${workingDir} is outside ${root}`);
  }
  return { at: (path) => ({ root, relative: join(prefix, path) }) };
}

/** A regular file, not a link to one. */
async function regularFileExists(path: string): Promise<boolean> {
  try {
    return (await Deno.lstat(path)).isFile;
  } catch {
    return false;
  }
}

/**
 * True when the build emitted a static export rather than a server.
 *
 * Deliberately narrow: an `out/` directory alone is a name plenty of unrelated
 * toolchains use, so an `index.html` inside it is required as corroboration
 * before a service is moved off the lane it was declared on. A build that also
 * emitted `.next/standalone` is a server build and is never considered here —
 * the caller checks standalone first.
 */
async function hasNextStaticExport(
  workingDir: string,
  tree: BuildTree,
): Promise<boolean> {
  if (!(await buildDirExists(tree, NEXT_EXPORT_DIR))) return false;
  return await regularFileExists(
    join(workingDir, NEXT_EXPORT_DIR, "index.html"),
  );
}

export type NativeAppBuildContext = {
  /** Declared runtime family; `auto` lets the built tree decide. */
  framework: EnvironmentDeployNativeAppService["framework"];
  /**
   * `deno` looks for a Deno start (the config's `start` task, then an entry
   * file) and never treats the tree as a Next.js build. Omitted means Node.
   */
  runtime?: "node" | "deno";
  /** Working directory the build ran in (checkout root + `subdirectory`). */
  workingDir: string;
  /**
   * The sandboxed build's `work/<id>`: every path is checked from here down,
   * so a build that swapped its checkout for a link is refused.
   */
  containmentRoot?: string;
  /**
   * The author's `outputDirectory`, relative to `workingDir`. It is the
   * release root as declared, so it is never second-guessed: no Next fold, no
   * static-export detection; only the start is looked for inside it.
   */
  outputDirectory?: string;
  /**
   * Work out how the release starts ({@link NativeAppBuildOutput.start}). Set
   * when the author typed neither a start command nor a `startupFile`; a build
   * where nothing can start the app then fails here, with the fix spelled out,
   * rather than promoting a release whose unit can only crash-loop.
   */
  detectStart?: boolean;
  onOutput?: ReleaseOutputHandler;
};

export type NativeAppBuildOutput = {
  /**
   * Release payload directory relative to the build working directory, or
   * `undefined` to ship the working tree as-is.
   */
  outputDirectory?: string;
  /** True when a Next standalone tree was detected and folded. */
  standaloneOutput: boolean;
  /**
   * True when the build emitted `output: 'export'` static files instead of a
   * server. The caller moves the service onto the site static lane
   * and generates **no** systemd unit for it — a static export has no process
   * to supervise, so a native unit would be a unit that can never come up.
   */
  staticExport: boolean;
  /**
   * How the unit starts the release when the author said nothing
   * (`detectStart`). Recorded with the release so a rollback restarts it the
   * same way.
   */
  start?: NativeAppStart;
};

/**
 * Decide what a native app's release payload is, after its build has run.
 *
 * When `.next/standalone` exists, fold `.next/static` and `public/` into it
 * (the layout Next documents for a standalone deployment) and ship *that*
 * subtree — `server.js` then sits at the release root, and the unit runs
 * `node server.js`.
 *
 * When the build instead emitted `output: 'export'` (an `out/` tree with an
 * `index.html` and no standalone server), that subtree is published as the
 * release **and** flagged `staticExport`. There is no server process in a
 * static export, so the caller hands the service to the site static
 * lane instead of generating a systemd unit for it; the operator does not have
 * to re-declare `serviceKind` to get a working deploy. `out/` at the release
 * root is what lets the generated vhost serve `current` directly.
 *
 * Everything else ships the working tree unchanged, and (with `detectStart`)
 * {@link detectNativeAppStart} picks how it starts.
 */
export async function prepareNativeAppBuildOutput(
  context: NativeAppBuildContext,
): Promise<NativeAppBuildOutput> {
  const tree = buildTree(context.workingDir, context.containmentRoot);
  if (context.outputDirectory !== undefined) {
    return await withDetectedStart(context, tree, context.outputDirectory, {
      standaloneOutput: false,
      staticExport: false,
    });
  }
  if (context.framework !== "node" && context.runtime !== "deno") {
    const next = await prepareNextOutput(context, tree);
    if (next) return next;
  }
  return await withDetectedStart(context, tree, ".", {
    standaloneOutput: false,
    staticExport: false,
  });
}

/**
 * The Next.js shapes that change the release payload: a standalone server
 * (folded and published, started with `node server.js`) or a static export
 * (published, no process). `undefined` for any other tree.
 */
async function prepareNextOutput(
  context: NativeAppBuildContext,
  tree: BuildTree,
): Promise<NativeAppBuildOutput | undefined> {
  if (!(await buildDirExists(tree, NEXT_STANDALONE_DIR))) {
    if (await hasNextStaticExport(context.workingDir, tree)) {
      context.onOutput?.(
        "stdout",
        "detected a statically exported Next.js build — publishing out/ as the release and serving it on the site static lane (no app process is started)",
      );
      return {
        outputDirectory: NEXT_EXPORT_DIR,
        standaloneOutput: false,
        staticExport: true,
      };
    }
    if (context.framework === "next") {
      context.onOutput?.(
        "stderr",
        'framework=next but neither .next/standalone nor an exported out/ was emitted — shipping the build tree as-is. Set `output: "standalone"` in next.config for a smaller release.',
      );
    }
    return undefined;
  }

  await forEachSequential([
    [NEXT_STATIC_DIR, join(NEXT_STANDALONE_DIR, NEXT_STATIC_DIR)],
    [NEXT_PUBLIC_DIR, join(NEXT_STANDALONE_DIR, NEXT_PUBLIC_DIR)],
  ], async ([from, to]) => {
    if (!(await buildDirExists(tree, from))) return;
    // Destination components are created or checked one at a time, so a
    // planted `.next/standalone/.next -> elsewhere` is refused, not followed.
    await copyContainedTree({ source: tree.at(from), dest: tree.at(to) });
  });

  context.onOutput?.(
    "stdout",
    "detected Next.js standalone output — publishing .next/standalone as the release",
  );
  const output: NativeAppBuildOutput = {
    outputDirectory: NEXT_STANDALONE_DIR,
    standaloneOutput: true,
    staticExport: false,
  };
  if (context.detectStart) {
    output.start = { kind: "file", path: STANDALONE_SERVER_FILE };
    reportStart(context, output.start);
  }
  return output;
}

/** The file `next build` writes at the standalone root. */
const STANDALONE_SERVER_FILE = "server.js";

/** Files a plain Node app is started from when nothing else says (in order). */
const DEFAULT_ENTRY_FILES = ["index.js", "server.js"] as const;

function reportStart(context: NativeAppBuildContext, start: NativeAppStart) {
  context.onOutput?.(
    "stdout",
    `no start command set — the app will start with ${
      describeNativeAppStart(start)
    }`,
  );
}

/** The release root a start is looked for in. */
type StartRoot = {
  tree: BuildTree;
  /** Relative to the build working directory (`.` for the checkout itself). */
  releaseRoot: string;
  /** Absolute path of the release root. */
  rootDir: string;
};

/** `base` plus the detected start, when `detectStart` asked for one. */
async function withDetectedStart(
  context: NativeAppBuildContext,
  tree: BuildTree,
  releaseRoot: string,
  base: NativeAppBuildOutput,
): Promise<NativeAppBuildOutput> {
  if (!context.detectStart) return base;
  // A declared release root that is a link the build planted is refused here
  // (`buildDirExists` throws), exactly as the promote would refuse it.
  const rootExists = releaseRoot === "." ||
    await buildDirExists(tree, releaseRoot);
  const root: StartRoot = {
    tree,
    releaseRoot,
    rootDir: join(context.workingDir, releaseRoot),
  };
  if (context.runtime === "deno") {
    return await withDetectedDenoStart(context, root, rootExists, base);
  }
  const pkg = rootExists ? await readPackageJson(root.rootDir) : undefined;
  if (rootExists) await assertNotPlugAndPlay(root);
  const start = rootExists
    ? await detectNativeAppStart(context.framework, root, pkg)
    : undefined;
  if (!start) {
    throw new Error(
      "no start command: the release has no package.json start script, no " +
        "Next.js build, no package.json main file, and no index.js or " +
        "server.js at its root. Add a start script to package.json, or set a " +
        "start command for this service.",
    );
  }
  reportStart(context, start);
  if (start.kind === "start-script" && pkg) reportStartScript(context, pkg);
  return { ...base, start };
}

/**
 * The start of a Deno release ({@link detectDenoStart}). Nothing found fails
 * the build, before promote, saying how to give the app a start.
 */
async function withDetectedDenoStart(
  context: NativeAppBuildContext,
  root: StartRoot,
  rootExists: boolean,
  base: NativeAppBuildOutput,
): Promise<NativeAppBuildOutput> {
  const files = denoProjectFiles(
    root.rootDir,
    (path) => entryFileExists(root, path),
  );
  const config = rootExists ? await readDenoConfig(files) : undefined;
  const start = rootExists ? await detectDenoStart(files, config) : undefined;
  if (!start) {
    throw new Error(
      "no start command: the release has no start task in deno.json, no main " +
        "or exports entry that exists, and none of main.ts, mod.ts, server.ts, " +
        "main.js or index.ts at its root. Add a start task to deno.json, or " +
        "set a start command for this service.",
    );
  }
  reportStart(context, start);
  reportDenoStart(context, config);
  return { ...base, start };
}

/** Build-log notes a Deno start needs: where it must listen, and a missing config. */
function reportDenoStart(
  context: NativeAppBuildContext,
  config: DenoConfig | undefined,
) {
  if (config === undefined) {
    context.onOutput?.(
      "stdout",
      "note: no deno.json or deno.jsonc found, so the app runs without a project config",
    );
  }
  context.onOutput?.(
    "stdout",
    "the app must listen on 127.0.0.1 and $PORT (the unit sets HOST, HOSTNAME and PORT): pass Deno.serve the hostname from HOSTNAME and the port from PORT, because Deno.serve alone listens on every address on port 8000",
  );
}

/**
 * Yarn Plug'n'Play installs no `node_modules`: packages are resolved through
 * `.pnp.cjs`, which only Yarn's own runner loads. An app run directly by Node
 * then fails on its first `require`, so stop at build time with the fix.
 */
async function assertNotPlugAndPlay(root: StartRoot): Promise<void> {
  if (!(await regularFileExists(join(root.rootDir, ".pnp.cjs")))) return;
  if (
    await containedDirExists(root.tree, join(root.releaseRoot, NODE_MODULES))
  ) {
    return;
  }
  throw new Error(
    "this app was installed with Yarn Plug'n'Play (a .pnp.cjs file and no " +
      "node_modules folder), which apps run directly on the server do not " +
      "support. Add `nodeLinker: node-modules` to .yarnrc.yml and deploy again.",
  );
}

const NODE_MODULES = "node_modules";

/** Like {@link buildDirExists}, but a link on the way is "no", not an error. */
async function containedDirExists(
  tree: BuildTree,
  relativePath: string,
): Promise<boolean> {
  try {
    return await buildDirExists(tree, relativePath);
  } catch {
    return false;
  }
}

/**
 * Build-log notes for a start script the platform runs as written: it has to
 * listen on loopback itself, `poststart` never runs, and a `next start` buried
 * in it binds every address unless it is given `--hostname`.
 */
function reportStartScript(context: NativeAppBuildContext, pkg: PackageJson) {
  const script = packageScript(pkg, "start") ?? "";
  if (
    /(?:^|\s)next\s+start(?:\s|$)/.test(script) &&
    !/--hostname|-H\s/.test(script)
  ) {
    context.onOutput?.(
      "stderr",
      "warning: the start script runs next start inside other commands, so it runs as written, and next start listens on every address unless told otherwise. Add `--hostname 127.0.0.1` to it so the app is reachable only through the proxy.",
    );
  } else {
    context.onOutput?.(
      "stdout",
      "the start script must listen on 127.0.0.1 and $PORT (the unit sets HOST, HOSTNAME and PORT)",
    );
  }
  if (packageScript(pkg, "poststart") !== undefined) {
    context.onOutput?.(
      "stdout",
      "note: the poststart script is not run — a server's start script only finishes when the app stops",
    );
  }
}

/**
 * True for a `start` script that is just `next start` (with or without its own
 * flags). That one is run as Next's CLI with the platform's `--hostname` and
 * `--port` instead, whatever `framework` says: `next start` reads no hostname
 * from the environment and binds every interface by default, which would put
 * the app on the public address next to the proxy. A script that chains other
 * commands is the author's and runs as written (with a warning).
 */
function isPlainNextStart(script: string): boolean {
  const trimmed = script.trim();
  if (/[;&|]/.test(trimmed)) return false;
  return /^next\s+start(?:\s|$)/.test(trimmed);
}

/**
 * How a release starts when its author typed nothing, by the usual Node
 * convention:
 *
 * 1. a Next standalone tree (`server.js` beside a `.next/` folder, e.g. a
 *    declared `outputDirectory: .next/standalone`) → `node server.js`: the
 *    `package.json` Next copies in there still says `next start`, which that
 *    tree cannot run;
 * 2. the `package.json` `start` script (`node --run start`, after `prestart`
 *    when there is one; a plain `next start` becomes Next's CLI bound to
 *    127.0.0.1, see {@link isPlainNextStart});
 * 3. a Next.js app (`framework: next`, or a `.next/` build in the release
 *    root) → `next start`, once the build and the CLI are both there;
 * 4. the `package.json` `main` file, when it exists;
 * 5. `index.js`, then `server.js`, at the release root.
 *
 * A standalone build the daemon found itself never gets here: it always runs
 * `node server.js`. `undefined` when nothing applies.
 */
async function detectNativeAppStart(
  framework: NativeAppBuildContext["framework"],
  root: StartRoot,
  pkg: PackageJson | undefined,
): Promise<NativeAppStart | undefined> {
  const hasNextBuild = await containedDirExists(
    root.tree,
    join(root.releaseRoot, ".next"),
  );
  if (
    hasNextBuild &&
    await regularFileExists(join(root.rootDir, STANDALONE_SERVER_FILE))
  ) {
    return { kind: "file", path: STANDALONE_SERVER_FILE };
  }
  const startScript = pkg ? packageScript(pkg, "start") : undefined;
  if (startScript !== undefined) {
    if (isPlainNextStart(startScript)) return await nextStart(root);
    return pkg && packageScript(pkg, "prestart") !== undefined
      ? { kind: "start-script", prestart: true }
      : { kind: "start-script" };
  }
  if (framework !== "node" && hasNextBuild) return await nextStart(root);
  const entry = await detectEntryFile(root);
  // Declared Next with no build and no entry file: say what is missing.
  if (entry || framework !== "next") return entry;
  return await nextStart(root);
}

/**
 * `next start`, but only for a tree that can run it: a `.next/` build and
 * Next's CLI in `node_modules`. Otherwise the build fails now, with the
 * reason, instead of promoting a release that can only crash-loop.
 */
async function nextStart(root: StartRoot): Promise<NativeAppStart> {
  if (!(await containedDirExists(root.tree, join(root.releaseRoot, ".next")))) {
    throw new Error(
      "the app starts with next start, but the build left no .next folder. " +
        "Make sure the package.json build script runs next build.",
    );
  }
  if (!(await nextCliExists(root.rootDir))) {
    throw new Error(
      "the app starts with next start, but next is not installed in " +
        "node_modules. Add next to the package.json dependencies.",
    );
  }
  return { kind: "next-start" };
}

/**
 * Whether Next's CLI file is there. Links are followed on purpose: pnpm makes
 * `node_modules/next` a link into its own store inside the tree, and this is
 * only an existence check (nothing is read).
 */
async function nextCliExists(rootDir: string): Promise<boolean> {
  try {
    return (await Deno.stat(join(rootDir, NEXT_CLI_PATH))).isFile;
  } catch {
    return false;
  }
}

/**
 * `main`, then the conventional entry files, whichever exists first: a regular
 * file (not a link) in a real directory of the tree (no link on the way).
 */
async function detectEntryFile(
  root: StartRoot,
): Promise<NativeAppStart | undefined> {
  const pkg = await readPackageJson(root.rootDir);
  const main = typeof pkg?.main === "string"
    ? normalizeNativeAppStartPath(pkg.main)
    : undefined;
  const candidates = [
    ...(main === undefined ? [] : [main]),
    ...DEFAULT_ENTRY_FILES,
  ];
  const present = await Promise.all(
    candidates.map((candidate) => entryFileExists(root, candidate)),
  );
  const index = present.indexOf(true);
  return index === -1 ? undefined : { kind: "file", path: candidates[index] };
}

async function entryFileExists(
  root: StartRoot,
  candidate: string,
): Promise<boolean> {
  const dir = dirname(candidate);
  if (
    dir !== "." &&
    !(await containedDirExists(root.tree, join(root.releaseRoot, dir)))
  ) {
    return false;
  }
  return await regularFileExists(join(root.rootDir, candidate));
}
