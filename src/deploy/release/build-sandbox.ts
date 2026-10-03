/**
 * Sandboxed tenant builds: the daemon half of `tp-host build-run`.
 *
 * Install and build commands are tenant code, and anyone who can deploy a
 * project may define them. On a managed host they therefore never run as the
 * daemon account (which can reach the Docker socket, the daemon's state and
 * `sudo tp-host`). The daemon clones into `work/<buildId>` under
 * {@link BUILD_SANDBOX_ROOT}, writes a spec, and asks `tp-host build-run` to
 * hand the tree to the unprivileged build account and run the spec in a
 * transient `turbopanel-build-<buildId>.service` whose sandbox and limits
 * tp-host fixes (no docker or tp group, daemon trees and sockets hidden,
 * private-range and metadata egress denied, 4G memory, 2 CPUs, 30 minutes).
 * `build-return` gives the tree back only once that unit is gone, and only
 * then does the daemon read it (`./safe-copy.ts`, contained in `work/<id>`).
 *
 * Spec format and runner semantics: `orchestration/scripts/tp-build-runner`.
 */

import { encodeBase64 } from "@std/encoding/base64";
import { encodeHex } from "@std/encoding/hex";
import { join } from "@std/path";
import type { CommandSummaryRedactor } from "../../logs/contracts.ts";
import { pumpLines } from "../../logs/line-stream.ts";
import { redactCommandSummary } from "../../logs/redactor.ts";
import { ORCHESTRATION_LAYOUT } from "../../orchestration/assets.ts";
import { hostSudoArgs } from "../../permissions/host-sudo.ts";
import type { RunFn } from "../ensure-principal.ts";
import type { ReleaseOutputHandler } from "./checkout.ts";
import { runPrivileged } from "./release-layout.ts";

/** The build-user role's tree; tp-host pins the same path. */
export const BUILD_SANDBOX_ROOT = "/var/lib/turbopanel-build";

/**
 * Daemon-side ceiling. The unit's own `RuntimeMaxSec=1800` is the hard bound;
 * this only stops waiting a little after it (then stops the unit itself).
 */
export const SANDBOX_BUILD_TIMEOUT_MS = 1_800_000 + 120_000;

/** Runner exits that mean the daemon wrote a bad spec, not a tenant failure. */
const RUNNER_REFUSED_EXITS = new Set([64, 65]);

/** `tp-host`'s id rule: lower-case letters, digits and `-`, not leading `-`. */
const SANDBOX_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SPEC_ENV_NAME_RE = /^[A-Za-z_]\w*$/;
const SPEC_CWD_RE = /^[\w.@+,=/-]+$/;
const SUDO_PATH = "/usr/sbin:/usr/bin:/sbin:/bin";
const ERROR_TAIL_LINES = 20;

export type BuildWork = {
  /** `turbopanel-build-<buildId>.service`; also the `work/` entry name. */
  buildId: string;
  /** The project's cache directory name (`cache/<projectKey>`). */
  projectKey: string;
  /** `work/<buildId>`: the containment root for everything the build wrote. */
  workDir: string;
  /** The clone, inside {@link workDir}. */
  checkoutDir: string;
  /** `cache/<projectKey>`, bound into the build unit at the same path. */
  cacheDir: string;
};

/**
 * Whether tenant builds go through the sandbox: on every managed
 * (production) install, with no opt-out, because nothing tenant-defined may
 * run as the daemon account there. A development install builds as the
 * developer, unsandboxed.
 */
export function buildSandboxEnabled(
  installMode: "development" | "production" = ORCHESTRATION_LAYOUT.mode,
): boolean {
  return installMode === "production";
}

/**
 * The work tree for one release build. The id is derived from the service and
 * release, so a rerun after a crash finds (and reclaims) the same tree.
 */
export async function resolveBuildWork(
  params: { serviceId: string; releaseId: string; projectId: string },
  root: string = BUILD_SANDBOX_ROOT,
): Promise<BuildWork> {
  if (!SANDBOX_ID_RE.test(params.projectId)) {
    throw new Error(
      `project id ${params.projectId} cannot name a build cache directory`,
    );
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${params.serviceId}/${params.releaseId}`),
  );
  const buildId = encodeHex(new Uint8Array(digest)).slice(0, 32);
  const workDir = join(root, "work", buildId);
  return {
    buildId,
    projectKey: params.projectId,
    workDir,
    checkoutDir: join(workDir, "source"),
    cacheDir: join(root, "cache", params.projectId),
  };
}

/** The spec's `cwd`: the checkout, or the declared subdirectory in it. */
export function buildSpecCwd(subdirectory?: string): string {
  if (!subdirectory) return "source";
  const segments = subdirectory.split("/").filter((part) => part !== "");
  const unsafe = !SPEC_CWD_RE.test(subdirectory) ||
    subdirectory.startsWith("/") ||
    segments.some((part) => part === "." || part === "..");
  if (unsafe || segments.length === 0) {
    throw new Error(
      `subdirectory ${subdirectory} cannot be built in the build sandbox`,
    );
  }
  return ["source", ...segments].join("/");
}

/**
 * The runner's stdin: `tp-build-spec 1`, the cwd, one `env` line per variable
 * and one `run` line per command, values base64, then `end`.
 */
export function renderBuildSpec(spec: {
  cwd: string;
  env: Record<string, string>;
  commands: readonly string[];
}): string {
  const encode = (value: string) =>
    encodeBase64(new TextEncoder().encode(value));
  const lines = ["tp-build-spec 1", `cwd ${spec.cwd}`];
  for (const [name, value] of Object.entries(spec.env)) {
    if (!SPEC_ENV_NAME_RE.test(name)) {
      throw new Error(`build variable name ${name} is not a shell name`);
    }
    lines.push(`env ${name} ${encode(value)}`);
  }
  for (const command of spec.commands) lines.push(`run ${encode(command)}`);
  lines.push("end", "");
  return lines.join("\n");
}

/** True for a tenant variable name the runner (and a shell) can carry. */
export function isSpecEnvName(name: string): boolean {
  return SPEC_ENV_NAME_RE.test(name);
}

/**
 * Create `work/<buildId>` for a fresh clone. A tree left by a crashed run is
 * handed back and removed first; a missing `work/` names the role to run.
 */
export async function createBuildWorkDir(
  work: BuildWork,
  runFn: RunFn = runPrivileged,
): Promise<void> {
  if (await lstatOrNull(work.workDir)) {
    await returnBuildWork(work, runFn);
    await Deno.remove(work.workDir, { recursive: true });
  }
  try {
    await Deno.mkdir(work.workDir, { mode: 0o700 });
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new Error(
        `no build tree at ${work.workDir}: run the build-user role (daemon-converge)`,
      );
    }
    throw err;
  }
}

/** Remove the returned work tree. Never throws; a leftover is reported. */
export async function removeBuildWork(
  work: BuildWork,
  onOutput?: ReleaseOutputHandler,
): Promise<void> {
  try {
    await Deno.remove(work.workDir, { recursive: true });
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    const message = err instanceof Error ? err.message : String(err);
    onOutput?.(
      "stderr",
      `could not remove the build tree ${work.workDir}: ${message}`,
    );
  }
}

/** `tp-host build-return <id>`: the tree back to the daemon, unit gone. */
export async function returnBuildWork(
  work: BuildWork,
  runFn: RunFn = runPrivileged,
): Promise<void> {
  const result = await runFn(
    "sudo",
    hostSudoArgs(["-n", "build-return", work.buildId]),
  );
  if (!result.success) {
    throw new Error(
      `could not take the build tree back: ${
        result.stderr.trim() || "build-return failed"
      }`,
    );
  }
}

/** Stop the build unit (abort path). Best-effort; the unit's RuntimeMaxSec backs it. */
export async function stopBuildUnit(
  work: BuildWork,
  runFn: RunFn = runPrivileged,
): Promise<void> {
  try {
    await runFn(
      "sudo",
      hostSudoArgs([
        "-n",
        "systemctl",
        "stop",
        `turbopanel-build-${work.buildId}.service`,
      ]),
    );
  } catch {
    // The unit ends at RuntimeMaxSec regardless.
  }
}

async function lstatOrNull(path: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.lstat(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

/** Spawns `sudo <args>` with the spec on stdin; a test seam. */
export type SandboxSpawn = (args: string[]) => Deno.ChildProcess;

const spawnSudo: SandboxSpawn = (args) =>
  new Deno.Command("sudo", {
    args,
    clearEnv: true,
    env: { PATH: SUDO_PATH },
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();

export type SandboxedBuildParams = {
  work: BuildWork;
  /** {@link renderBuildSpec} output. */
  spec: string;
  onOutput?: ReleaseOutputHandler;
  redactSummary?: CommandSummaryRedactor;
  /** Privileged runner for `systemctl stop` and `build-return`. */
  runFn?: RunFn;
  spawn?: SandboxSpawn;
  timeoutMs?: number;
};

// One build at a time per host: tp-host holds a root-only lock as well, but
// queueing here keeps a waiting deploy visible in its transcript.
let buildQueue: Promise<void> = Promise.resolve();
let buildsQueued = 0;

async function withBuildSlot<T>(
  onOutput: ReleaseOutputHandler | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (buildsQueued > 0) {
    onOutput?.("stdout", "waiting for another build on this host to finish");
  }
  buildsQueued += 1;
  const previous = buildQueue;
  let release = () => {};
  buildQueue = new Promise((resolve) => {
    release = resolve;
  });
  try {
    await previous;
    return await run();
  } finally {
    buildsQueued -= 1;
    release();
  }
}

/**
 * Write the spec and close stdin (the runner reads to EOF). A child that died
 * before reading it reports why on stderr, so a broken pipe here is not the
 * error worth surfacing.
 */
async function writeSpec(
  stdin: WritableStream<Uint8Array>,
  spec: string,
): Promise<void> {
  const writer = stdin.getWriter();
  await writer.write(new TextEncoder().encode(spec)).catch(() => {});
  await writer.close().catch(() => {});
}

function tail(text: string): string {
  return text.trim().split("\n").slice(-ERROR_TAIL_LINES).join("\n");
}

function failureMessage(
  code: number,
  stdout: string,
  stderr: string,
  redact: CommandSummaryRedactor,
): string {
  if (RUNNER_REFUSED_EXITS.has(code)) {
    return `the build sandbox refused the build spec (exit ${code}): ${
      redact(tail(stderr))
    }`;
  }
  return redact(tail(stderr)) || redact(tail(stdout)) ||
    `build failed in the build sandbox (exit ${code})`;
}

async function runBuildUnit(
  params: SandboxedBuildParams,
  runFn: RunFn,
): Promise<void> {
  const { work, onOutput } = params;
  const redact = params.redactSummary ??
    ((text: string) => redactCommandSummary(text));
  const timeoutMs = params.timeoutMs ?? SANDBOX_BUILD_TIMEOUT_MS;
  const child = (params.spawn ?? spawnSudo)(
    hostSudoArgs(["-n", "build-run", work.buildId, work.projectKey]),
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void stopBuildUnit(work, runFn);
  }, timeoutMs);
  let outcome: [Deno.CommandStatus, string, string, void];
  try {
    outcome = await Promise.all([
      child.status,
      pumpLines(child.stdout, (line) => onOutput?.("stdout", line)),
      pumpLines(child.stderr, (line) => onOutput?.("stderr", line)),
      writeSpec(child.stdin, params.spec),
    ]);
  } catch (err) {
    // Lost track of the client: the unit must not outlive it.
    await abortBuildUnit(child, work, runFn);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const [status, stdout, stderr] = outcome;
  if (timedOut) {
    throw new Error(
      `build timed out after ${timeoutMs}ms; the build unit was stopped`,
    );
  }
  if (!status.success) {
    throw new Error(failureMessage(status.code, stdout, stderr, redact));
  }
}

async function abortBuildUnit(
  child: Deno.ChildProcess,
  work: BuildWork,
  runFn: RunFn,
): Promise<void> {
  await stopBuildUnit(work, runFn);
  try {
    child.kill("SIGTERM");
  } catch {
    // Already gone.
  }
  await child.status.catch(() => undefined);
}

/**
 * Run one build spec in the sandbox and take the tree back. The tree is
 * returned whether the build succeeded or not (the unit is stopped first on
 * any abort), so the daemon can always remove it.
 */
export async function runSandboxedBuild(
  params: SandboxedBuildParams,
): Promise<void> {
  const runFn = params.runFn ?? runPrivileged;
  await withBuildSlot(params.onOutput, async () => {
    let failure: unknown = null;
    try {
      await runBuildUnit(params, runFn);
    } catch (err) {
      failure = err;
    }
    try {
      await returnBuildWork(params.work, runFn);
    } catch (err) {
      if (failure === null) throw err;
      const message = err instanceof Error ? err.message : String(err);
      params.onOutput?.("stderr", message);
    }
    if (failure !== null) throw failure;
  });
}
