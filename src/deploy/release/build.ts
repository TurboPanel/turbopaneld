/**
 * Run a release's install / build commands inside the ephemeral checkout.
 *
 * **Sandboxed build, containerless runtime.** This is not container isolation
 * and does not claim to be. What it does guarantee:
 *
 * - the command runs in the scratch checkout, never in the live release tree
 *   or the principal home;
 * - `clearEnv` plus an explicit allow-list means no daemon credential material
 *   (no `GIT_ASKPASS`, no decrypted envelope, no daemon token) is inherited —
 *   only `EnvironmentDeploySourceBuild.env`, which is non-secret by contract;
 * - an rlimit wrapper caps CPU time, address space, and file size where the
 *   host provides `prlimit`, degrading to an unwrapped run (with a transcript
 *   note) where it does not;
 * - output is streamed line-by-line so it reaches the transcript under the
 *   `build` phase while the build is still running, not after it finishes.
 */

import { join } from "@std/path";
import { pumpLines } from "../../logs/line-stream.ts";
import type { CommandSummaryRedactor } from "../../logs/contracts.ts";
import { redactCommandSummary } from "../../logs/redactor.ts";
import type {
  EnvironmentDeployNativeAppService,
  EnvironmentDeploySourceBuild,
} from "../../instance/commands/contracts.ts";
import type { ReleaseOutputHandler } from "./checkout.ts";
import { normalizeNodePackageManagerCommand } from "../node-package-manager.ts";
import { copyTree } from "./promote.ts";

/** Build ceiling. Long enough for a cold dependency install, not unbounded. */
export const BUILD_TIMEOUT_MS = 1_800_000;

/** `prlimit` caps applied when the host has the binary. */
const BUILD_RLIMIT_CPU_SECONDS = 1_800;
/**
 * Virtual address-space cap. Must be **well above** 4 GiB per V8 isolate:
 * pointer compression reserves a 4 GiB CodeRange, and Corepack/pnpm spawn
 * worker threads that each need their own. 4 GiB dies at isolate init
 * (`Failed to reserve virtual memory for CodeRange`); 16 GiB lets Node
 * start but pnpm's fetch workers fail with `GET … error (unknown)` /
 * `ERR_PNPM_META_FETCH_FAIL`. 32 GiB is enough for a one-package install;
 * 64 GiB leaves room for a Next.js install + `next build`. This is virtual
 * size, not RSS.
 */
export const BUILD_RLIMIT_AS_BYTES = 64 * 1024 * 1024 * 1024;
const BUILD_RLIMIT_FSIZE_BYTES = 4 * 1024 * 1024 * 1024;
const PRLIMIT_BIN = "/usr/bin/prlimit";
/** `sg` applies a supplementary group without waiting for a daemon re-login. */
const SG_BIN = "/usr/bin/sg";
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
]);

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
   * `root:<group> 0750`; builds run as the daemon, so the child is entered
   * via `sg` after the playbook appends the daemon account to this group.
   */
  runtimeGroup?: string;
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
   * Test seam for prlimit detection. Defaults to checking {@link PRLIMIT_BIN}.
   * Host-free suites force `false` so the no-caps path is covered without
   * depending on whether `/usr/bin/prlimit` exists in the guest.
   */
  hasPrlimit?: () => Promise<boolean>;
  /**
   * Test seam for the build command runner. Defaults to spawning `sh` /
   * `prlimit`. Injected runners receive the same `(command, cwd, env,
   * withPrlimit, …)` shape so they can assert the fallback without forking.
   */
  runCommand?: (
    command: string,
    cwd: string,
    env: Record<string, string>,
    withPrlimit: boolean,
    onOutput?: ReleaseOutputHandler,
    redactSummary?: CommandSummaryRedactor,
  ) => Promise<void>;
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
  for (const [key, value] of Object.entries(build.env ?? {})) {
    if (RESERVED_BUILD_ENV_KEYS.has(key)) continue;
    env[key] = value;
  }
  return env;
}

async function prlimitAvailable(): Promise<boolean> {
  try {
    const stat = await Deno.stat(PRLIMIT_BIN);
    return stat.isFile;
  } catch {
    return false;
  }
}

/**
 * `prlimit --cpu=… --as=… --fsize=… -- sh -c <command>`, or a bare `sh -c`.
 * Exported so host-free suites can assert the argv shape without spawning.
 */
export function buildInvocation(
  command: string,
  withPrlimit: boolean,
  runtimeGroup?: string,
): { bin: string; args: string[] } {
  const runner = runtimeGroup
    ? { bin: SG_BIN, args: [runtimeGroup, "-c", command] }
    : { bin: "sh", args: ["-c", command] };
  if (!withPrlimit) return runner;
  return {
    bin: PRLIMIT_BIN,
    args: [
      `--cpu=${BUILD_RLIMIT_CPU_SECONDS}`,
      `--as=${BUILD_RLIMIT_AS_BYTES}`,
      `--fsize=${BUILD_RLIMIT_FSIZE_BYTES}`,
      "--",
      runner.bin,
      ...runner.args,
    ],
  };
}

async function runBuildCommand(
  command: string,
  cwd: string,
  env: Record<string, string>,
  withPrlimit: boolean,
  onOutput?: ReleaseOutputHandler,
  redactSummary: CommandSummaryRedactor = defaultSummaryRedactor,
  runtimeGroup?: string,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BUILD_TIMEOUT_MS);
  const { bin, args } = buildInvocation(command, withPrlimit, runtimeGroup);
  try {
    const child = new Deno.Command(bin, {
      args,
      cwd,
      env,
      clearEnv: true,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal,
    }).spawn();
    const [status, stdout, stderr] = await Promise.all([
      child.status,
      pumpLines(
        child.stdout,
        onOutput ? (line) => onOutput("stdout", line) : undefined,
      ),
      pumpLines(
        child.stderr,
        onOutput ? (line) => onOutput("stderr", line) : undefined,
      ),
    ]);
    if (!status.success) {
      throw new Error(
        redactSummary(stderr.trim()) || redactSummary(stdout.trim()) ||
          `build command failed: ${command}`,
      );
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(`build command timed out after ${BUILD_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * True when `package.json` pins Yarn Berry (2+), or a `.yarnrc.yml` marks the
 * checkout as a Berry project. Berry has no `--production` flag (and ignores
 * `NODE_ENV` during install), so the classic-only dev-deps flag must not be
 * passed to it.
 */
async function yarnIsBerry(workingDir: string): Promise<boolean> {
  try {
    const raw = await Deno.readTextFile(join(workingDir, "package.json"));
    const pin = JSON.parse(raw)?.packageManager;
    const match = typeof pin === "string" ? /^yarn@(\d+)/.exec(pin) : null;
    if (match) return Number(match[1]) >= 2;
  } catch {
    // Unreadable/unparseable package.json — fall through to the file probe.
  }
  return await fileExists(join(workingDir, ".yarnrc.yml"));
}

/**
 * Derive the install command for a native-app build from the operator's
 * package-manager choice, falling back to lockfile detection
 * (`pnpm-lock.yaml` > `yarn.lock` > `package-lock.json` > bare npm).
 *
 * The dev-deps flags (`--include=dev`, `--prod=false`, `--production=false`)
 * are load-bearing: the build environment sets `NODE_ENV=production`, under
 * which npm, pnpm, and classic yarn silently omit devDependencies — which is
 * where every build toolchain lives.
 *
 * Returns `undefined` when there is no `package.json` to install from.
 */
export async function deriveNodeInstallCommand(params: {
  packageManager?: EnvironmentDeploySourceBuild["packageManager"];
  workingDir: string;
}): Promise<string | undefined> {
  const has = (name: string) => fileExists(join(params.workingDir, name));
  if (!(await has("package.json"))) return undefined;

  const hasPnpmLock = await has("pnpm-lock.yaml");
  const hasYarnLock = await has("yarn.lock");
  let lockfileManager: "pnpm" | "yarn" | "npm" = "npm";
  if (hasPnpmLock) lockfileManager = "pnpm";
  else if (hasYarnLock) lockfileManager = "yarn";
  const manager = params.packageManager ?? lockfileManager;

  if (manager === "pnpm") {
    return hasPnpmLock
      ? "corepack pnpm install --frozen-lockfile --prod=false"
      : "corepack pnpm install --prod=false";
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

  const withPrlimit = await (params.hasPrlimit ?? prlimitAvailable)();
  if (!withPrlimit) {
    params.onOutput?.(
      "stderr",
      "prlimit unavailable — running build without resource caps",
    );
  }
  const env = buildEnvironment(
    params.build,
    params.workingDir,
    params.nativeRuntime,
  );
  const execute = params.runCommand ??
    ((
      command,
      cwd,
      commandEnv,
      commandWithPrlimit,
      commandOnOutput,
      commandRedactSummary,
    ) =>
      runBuildCommand(
        command,
        cwd,
        commandEnv,
        commandWithPrlimit,
        commandOnOutput,
        commandRedactSummary,
        params.nativeRuntime?.runtimeGroup,
      ));
  for (const command of commands) {
    params.onOutput?.("stdout", `$ ${command}`);
    await execute(
      command,
      params.workingDir,
      env,
      withPrlimit,
      params.onOutput,
      params.redactSummary,
    );
  }
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

async function directoryExists(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    return stat.isDirectory;
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    return stat.isFile;
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
async function hasNextStaticExport(workingDir: string): Promise<boolean> {
  const exportDir = join(workingDir, NEXT_EXPORT_DIR);
  if (!(await directoryExists(exportDir))) return false;
  return await fileExists(join(exportDir, "index.html"));
}

export type NativeAppBuildContext = {
  /** Declared runtime family; `auto` lets the built tree decide. */
  framework: EnvironmentDeployNativeAppService["framework"];
  /** Working directory the build ran in (checkout root + `subdirectory`). */
  workingDir: string;
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

  const standaloneDir = join(context.workingDir, NEXT_STANDALONE_DIR);
  if (!(await directoryExists(standaloneDir))) {
    if (await hasNextStaticExport(context.workingDir)) {
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

  for (
    const [from, to] of [
      [NEXT_STATIC_DIR, join(NEXT_STANDALONE_DIR, NEXT_STATIC_DIR)],
      [NEXT_PUBLIC_DIR, join(NEXT_STANDALONE_DIR, NEXT_PUBLIC_DIR)],
    ]
  ) {
    const source = join(context.workingDir, from);
    if (!(await directoryExists(source))) continue;
    await copyTree(source, join(context.workingDir, to));
  }

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
