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
import { BUILD_OUTPUT_LIMITS, pumpLines } from "../../logs/line-stream.ts";
import { redactCommandSummary } from "../../logs/redactor.ts";
import { PROD_LIB_DIR_DEFAULT } from "../../paths/layout.ts";
import { hostSudoArgs } from "../../permissions/host-sudo.ts";
import type { RunFn } from "../ensure-principal.ts";
import type { ReleaseOutputHandler } from "./checkout.ts";
import { runPrivileged } from "./release-layout.ts";
import { forEachSequential } from "../../util/sequential.ts";

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
const ERROR_TAIL_LINES = 80;

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

/** Root-owned facts that mark a host whose builds must be sandboxed. */
export type BuildSandboxMarkers = {
  /** The account database the build account is looked up in. */
  passwd: string;
  /** The managed install's root helper. */
  tpHost: string;
};

const HOST_MARKERS: BuildSandboxMarkers = {
  passwd: "/etc/passwd",
  tpHost: join(PROD_LIB_DIR_DEFAULT, "tp-host"),
};

/**
 * `hostSudoArgs` options for the build verbs: always the managed tp-host,
 * never a layout guessed from the daemon's working directory or HOME.
 */
const MANAGED = {
  installMode: "production" as const,
  env: { TURBOPANEL_LIB_DIR: PROD_LIB_DIR_DEFAULT },
};

/**
 * Whether tenant builds go through the sandbox. A **positive** check on
 * root-owned facts, never on the guessed install mode (a planted
 * `main.ts` or `ansible.cfg` under the daemon's working directory must not
 * turn a managed host into a "development" one): the sandbox is on wherever
 * the build account exists or the managed tp-host is installed, with no
 * opt-out. Only a machine with neither (a developer's checkout) builds
 * unsandboxed, as the developer.
 */
export async function buildSandboxEnabled(
  markers: BuildSandboxMarkers = HOST_MARKERS,
): Promise<boolean> {
  const [account, helper] = await Promise.all([
    Deno.readTextFile(markers.passwd).then(
      (text) => text.split("\n").some((line) => line.startsWith("tpbuild:")),
      () => false,
    ),
    lstatOrNull(markers.tpHost).then((info) => info !== null, () => true),
  ]);
  return account || helper;
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
    // A crashed run's unit may still be running: stop it before the tree
    // can be handed back (build-return refuses an active unit).
    await stopBuildUnit(work, runFn);
    await returnBuildWork(work, runFn);
    await Deno.remove(work.workDir, { recursive: true });
  }
  try {
    await Deno.mkdir(work.workDir, { mode: 0o700 });
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new TypeError(
        `no build tree at ${work.workDir}: run the build-user role (daemon-converge)`,
      );
    }
    throw err;
  }
}

/** A work tree older than this belongs to no live build (30 min + lock wait). */
export const STALE_BUILD_WORK_MS = 3 * 60 * 60 * 1000;

/**
 * Reclaim work trees no build will come back for (the daemon died mid-build):
 * stop any unit still named after one, take the tree back, remove it.
 * Best-effort; a tree that will not go is reported and left.
 */
export async function sweepStaleBuildWork(
  root: string = BUILD_SANDBOX_ROOT,
  options: {
    runFn?: RunFn;
    onOutput?: ReleaseOutputHandler;
    now?: number;
    maxAgeMs?: number;
  } = {},
): Promise<void> {
  const runFn = options.runFn ?? runPrivileged;
  const cutoff = (options.now ?? Date.now()) -
    (options.maxAgeMs ?? STALE_BUILD_WORK_MS);
  const workRoot = join(root, "work");
  let names: string[];
  try {
    names = (await Array.fromAsync(Deno.readDir(workRoot)))
      .filter((entry) => entry.isDirectory && SANDBOX_ID_RE.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return;
  }
  const ages = await Promise.all(
    names.map((name) => lstatOrNull(join(workRoot, name)).catch(() => null)),
  );
  const stale: BuildWork[] = names
    .filter((_, index) => (ages[index]?.mtime?.getTime() ?? cutoff) < cutoff)
    .map((name) => {
      const workDir = join(workRoot, name);
      return {
        buildId: name,
        projectKey: "",
        workDir,
        checkoutDir: join(workDir, "source"),
        cacheDir: "",
      };
    });
  // One at a time: each goes through tp-host's host-wide lock anyway.
  await forEachSequential(
    stale,
    (work) => reclaimStaleWork(work, runFn, options.onOutput),
  );
}

async function reclaimStaleWork(
  work: BuildWork,
  runFn: RunFn,
  onOutput?: ReleaseOutputHandler,
): Promise<void> {
  try {
    await stopBuildUnit(work, runFn);
    await returnBuildWork(work, runFn);
    await Deno.remove(work.workDir, { recursive: true });
    onOutput?.("stdout", `reclaimed a stale build tree ${work.workDir}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onOutput?.(
      "stderr",
      `could not reclaim the stale build tree ${work.workDir}: ${message}`,
    );
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
    hostSudoArgs(["-n", "build-return", work.buildId], MANAGED),
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
      ], MANAGED),
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
  /** Stop the build once it has printed this many characters. */
  maxOutputChars?: number;
};

// One build at a time per host: tp-host holds a root-only lock as well, but
// queueing here keeps a waiting deploy visible in its transcript.
type BuildWaiter = { projectKey: string; go: () => void };
const buildWaiters: BuildWaiter[] = [];
let buildBusy = false;
let lastBuildProject = "";

/** Hand the slot to the longest waiter, preferring a project that did not just build. */
function nextBuildWaiter(): void {
  const index = buildWaiters.findIndex((w) =>
    w.projectKey !== lastBuildProject
  );
  const [waiter] = buildWaiters.splice(Math.max(index, 0), 1);
  if (!waiter) {
    buildBusy = false;
    return;
  }
  lastBuildProject = waiter.projectKey;
  waiter.go();
}

/**
 * One build at a time on the host. Waiting builds are served round-robin by
 * project (oldest first within a project's turn), so one project that deploys
 * over and over cannot keep every other project's build waiting.
 */
export async function withBuildSlot<T>(
  onOutput: ReleaseOutputHandler | undefined,
  run: () => Promise<T>,
  projectKey = "",
): Promise<T> {
  if (buildBusy) {
    onOutput?.("stdout", "waiting for another build on this host to finish");
    await new Promise<void>((go) => buildWaiters.push({ projectKey, go }));
  } else {
    buildBusy = true;
    lastBuildProject = projectKey;
  }
  try {
    return await run();
  } finally {
    nextBuildWaiter();
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
    hostSudoArgs(["-n", "build-run", work.buildId, work.projectKey], MANAGED),
  );
  let aborted: Promise<void> | null = null;
  let abortReason = `build timed out after ${timeoutMs}ms`;
  // Kill the client first, so a tp-host still waiting on the host lock
  // cannot start the unit after the stop.
  const abort = (reason: string) => {
    if (aborted !== null) return;
    abortReason = reason;
    aborted = abortBuildUnit(child, work, runFn);
  };
  const timer = setTimeout(() => abort(abortReason), timeoutMs);
  const limits = {
    ...BUILD_OUTPUT_LIMITS,
    maxTotalChars: params.maxOutputChars ?? BUILD_OUTPUT_LIMITS.maxTotalChars,
    onLimit: () =>
      abort("build output exceeded the size limit; the build was stopped"),
  };
  let outcome: [Deno.CommandStatus, string, string, void];
  try {
    outcome = await Promise.all([
      child.status,
      pumpLines(child.stdout, (line) => onOutput?.("stdout", line), limits),
      pumpLines(child.stderr, (line) => onOutput?.("stderr", line), limits),
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
  if (aborted !== null) {
    await aborted;
    throw new Error(`${abortReason}; the build unit was stopped`);
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
  try {
    child.kill("SIGTERM");
  } catch {
    // Already gone.
  }
  await child.status.catch(() => undefined);
  await stopBuildUnit(work, runFn);
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
  }, params.work.projectKey);
}
