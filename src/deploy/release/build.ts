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

import { isAbsolute, join, relative } from "@std/path";
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
  type ContainedPath,
  copyContainedTree,
  inspectContainedDir,
} from "./safe-copy.ts";
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
 * Refresh supplementary groups (`tpnodeNN`) without a login shell. `sg` execs
 * the passwd shell and dies on `/usr/sbin/nologin` with "This account is
 * currently not available" — the managed daemon user `tp` is nologin, and so
 * is a tenant principal. Same `sudo -n -u <self>` pattern as docker-cli.ts.
 */
const SUDO_BIN = "/usr/bin/sudo";
/** Apply the sandboxed build env after sudo's env_reset / secure_path. */
const ENV_BIN = "/usr/bin/env";
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
  /** `dirname(nativeAppNodeBinary(layout, series))` — prefixed onto `PATH`. */
  nodeBinDir: string;
  /** Operator's application mode; `production` when undeclared. */
  nodeEnv: "production" | "development";
  /**
   * Per-series entitlement group (`tpnode24`). The vendored tree is
   * `root:<group> 0750`; builds run as the daemon, so the child is
   * `sudo -n -u <self>` after the playbook appends the daemon account to this
   * group (`sg` cannot — it execs `/usr/sbin/nologin`).
   */
  runtimeGroup?: string;
};

/** Group-refresh context for a native-app build child. */
export type BuildInvocationIdentity = {
  username: string;
  env: Record<string, string>;
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
   * spawning `sh -c` (or the `sudo -n -u <self>` group refresh).
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
  if (nativeRuntime) {
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
    env.COREPACK_HOME = join(work.cacheDir, "corepack");
    env.COREPACK_ENABLE_DOWNLOAD_PROMPT = "0";
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
 * A bare `sh -c` (development builds). Native-app builds wrap with
 * `sudo -n -u <self> -- env … sh -c` so `initgroups()` picks up `tpnodeNN`
 * without exec'ing the passwd shell. Exported so host-free suites can assert
 * the argv shape without spawning.
 */
export function buildInvocation(
  command: string,
  runtimeGroup?: string,
  identity?: BuildInvocationIdentity,
): { bin: string; args: string[] } {
  if (!runtimeGroup) return { bin: "sh", args: ["-c", command] };
  if (!identity) {
    throw new TypeError(
      "native build group refresh requires the daemon username",
    );
  }
  return {
    bin: SUDO_BIN,
    args: [
      "-n",
      "-u",
      identity.username,
      "--",
      ENV_BIN,
      // Without `--`, a name that starts with `-` would be read as an option.
      "--",
      ...Object.entries(identity.env).map(([key, value]) => `${key}=${value}`),
      "sh",
      "-c",
      command,
    ],
  };
}

async function currentUsername(): Promise<string> {
  const fromEnv = Deno.env.get("USER")?.trim() ||
    Deno.env.get("LOGNAME")?.trim();
  if (fromEnv) return fromEnv;
  const output = await new Deno.Command("/usr/bin/id", {
    args: ["-un"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const name = new TextDecoder().decode(output.stdout).trim();
  if (output.success && name) return name;
  throw new Error(
    "cannot resolve daemon username for native build group refresh",
  );
}

async function resolveBuildInvocation(
  command: string,
  env: Record<string, string>,
  runtimeGroup?: string,
): Promise<{ bin: string; args: string[] }> {
  if (!runtimeGroup) return buildInvocation(command);
  const username = await currentUsername();
  return buildInvocation(command, runtimeGroup, { username, env });
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
  runtimeGroup?: string,
  cancelSignal?: AbortSignal,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BUILD_TIMEOUT_MS);
  const signal = withCancelSignal(controller.signal, cancelSignal);
  const { bin, args } = await resolveBuildInvocation(
    command,
    env,
    runtimeGroup,
  );
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

/** The manager and major version `package.json`'s `packageManager` pins. */
async function readPackageManagerPin(
  workingDir: string,
): Promise<{ name: NodeManagerName; major: number } | undefined> {
  try {
    const raw = await Deno.readTextFile(join(workingDir, "package.json"));
    const pin = JSON.parse(raw)?.packageManager;
    const match = typeof pin === "string"
      ? /^(pnpm|yarn|npm)@(\d+)/.exec(pin)
      : null;
    if (!match) return undefined;
    return {
      name: match[1] as NodeManagerName,
      major: Number(match[2]),
    };
  } catch {
    return undefined;
  }
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
  // Regular files only: the checkout is tenant content, and a link named
  // package.json must not make the daemon read whatever it points at.
  const has = (name: string) =>
    regularFileExists(join(params.workingDir, name));
  if (!(await has("package.json"))) return undefined;

  const hasPnpmLock = await has("pnpm-lock.yaml");
  const hasYarnLock = await has("yarn.lock");
  let lockfileManager: NodeManagerName = "npm";
  if (hasPnpmLock) lockfileManager = "pnpm";
  else if (hasYarnLock) lockfileManager = "yarn";
  const pin = await readPackageManagerPin(params.workingDir);
  const manager = params.packageManager ?? pin?.name ?? lockfileManager;

  if (manager === "pnpm") {
    return [
      "corepack pnpm install",
      ...(hasPnpmLock ? ["--frozen-lockfile"] : []),
      ...pnpmDevDepsArgs(pin?.name === "pnpm" ? pin.major : undefined),
    ].join(" ");
  }
  if (manager === "yarn") {
    // CI=1 already makes Berry installs immutable when a lockfile exists.
    if (await yarnIsBerry(params.workingDir)) return "corepack yarn install";
    return hasYarnLock
      ? "corepack yarn install --frozen-lockfile --production=false"
      : "corepack yarn install --production=false";
  }
  return (await has("package-lock.json"))
    ? "npm ci --include=dev"
    : "npm install --include=dev";
}

/** @deprecated Use {@link normalizeNodePackageManagerCommand}. */
export {
  normalizeNodePackageManagerCommand as normalizeNodeBuildCommand,
} from "../node-package-manager.ts";

/**
 * Run `installCommand` then `buildCommand`. A missing command is a no-op — a
 * source with neither is a valid "ship the repository as-is" release — except
 * for a native-app build, where a missing `installCommand` is derived from the
 * package manager / lockfile so all three managers deploy without the operator
 * typing an install line.
 */
export async function runReleaseBuild(
  params: ReleaseBuildParams,
): Promise<void> {
  let installCommand = params.build.installCommand;
  if (installCommand === undefined && params.nativeRuntime) {
    installCommand = await deriveNodeInstallCommand({
      packageManager: params.build.packageManager,
      workingDir: params.workingDir,
    });
    if (installCommand !== undefined) {
      params.onOutput?.(
        "stdout",
        `derived install command from ${
          params.build.packageManager ?? "lockfile detection"
        }`,
      );
    }
  }
  let buildCommand = params.build.buildCommand;
  if (buildCommand && params.nativeRuntime) {
    const normalized = normalizeNodePackageManagerCommand(buildCommand);
    if (normalized !== buildCommand) {
      params.onOutput?.(
        "stdout",
        "normalized build command for Corepack (bare pnpm/yarn is not on the native build PATH)",
      );
      buildCommand = normalized;
    }
  }
  const commands = [
    installCommand,
    buildCommand,
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
        params.nativeRuntime?.runtimeGroup,
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
  /** Working directory the build ran in (checkout root + `subdirectory`). */
  workingDir: string;
  /**
   * The sandboxed build's `work/<id>`: every path is checked from here down,
   * so a build that swapped its checkout for a link is refused.
   */
  containmentRoot?: string;
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
};

/**
 * Decide what a native app's release payload is, after its build has run.
 *
 * When `.next/standalone` exists, fold `.next/static` and `public/` into it
 * (the layout Next documents for a standalone deployment) and ship *that*
 * subtree — `server.js` then sits at the release root, which is exactly where
 * the generated systemd unit's default `ExecStart` looks for it.
 *
 * When the build instead emitted `output: 'export'` (an `out/` tree with an
 * `index.html` and no standalone server), that subtree is published as the
 * release **and** flagged `staticExport`. There is no server process in a
 * static export, so the caller hands the service to the site static
 * lane instead of generating a systemd unit for it; the operator does not have
 * to re-declare `serviceKind` to get a working deploy. `out/` at the release
 * root is what lets the generated vhost serve `current` directly.
 *
 * Everything else ships the working tree unchanged, which is the correct answer
 * for a plain Node service.
 */
export async function prepareNativeAppBuildOutput(
  context: NativeAppBuildContext,
): Promise<NativeAppBuildOutput> {
  if (context.framework === "node") {
    return { standaloneOutput: false, staticExport: false };
  }

  const tree = buildTree(context.workingDir, context.containmentRoot);
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
    return { standaloneOutput: false, staticExport: false };
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
  return {
    outputDirectory: NEXT_STANDALONE_DIR,
    standaloneOutput: true,
    staticExport: false,
  };
}
