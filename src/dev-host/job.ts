/**
 * The development host job: Update and Restart, or Restart Only.
 *
 * Owner rules this file keeps: never reset, stash, switch branches or pull
 * anything but `git merge --ff-only origin/trunk`; a checkout on another
 * branch or with a content change is reported and left alone; the database
 * is migrated only with a backup taken first, and a failed backup or migrate
 * stops the job before any restart; restarts go control plane, then web
 * interface and website, then this daemon last, after the job is written as
 * `done`.
 *
 * One job at a time: an in-process flag plus a lock file holding the pid, so
 * a second daemon process cannot start one either. The job is written to
 * `job.json` at every step so it survives this daemon's own restart; a job
 * still `running` when a new process starts is marked `failed`.
 */
import { join } from "@std/path";
import {
  type DevHostJob,
  type DevHostJobStep,
  MAX_DEV_HOST_LOG_TAIL_LINES,
  MAX_DEV_HOST_TEXT_CHARS,
} from "../contracts/cell-messages.ts";
import { resolveInstanceSocket } from "../instance/sockets.ts";
import { hostSudoArgs } from "../permissions/host-sudo.ts";
import { resolveRuntimesDir } from "../paths/layout.ts";
import { logWarn } from "../util/logger.ts";
import {
  firstSequential,
  forEachSequential,
  mapSequential,
  repeatSequential,
} from "../util/sequential.ts";
import {
  clipText,
  combinedOutput,
  type CommandResult,
  lastLine,
  logTail,
  type RunCommand,
} from "./commands.ts";
import {
  type DevHostPartName,
  type DevHostPartSpec,
  type DevHostPaths,
  partCheckout,
} from "./config.ts";
import { readDirty } from "./dirty.ts";
import { fastForwardTrunk, fetchTrunk, readHead, TRUNK } from "./git.ts";
import { type DevHostStatusCollector, installNeeded } from "./status.ts";
import { readUnits } from "./units.ts";

export type DevHostAction = DevHostJob["action"];

/** Every step, in order. Restart Only runs the last three. */
export const UPDATE_STEPS = [
  "fetch",
  "pull",
  "install",
  "migrate",
  "restart-control-plane",
  "restart-web",
  "restart-daemon",
] as const;
export const RESTART_STEPS = [
  "restart-control-plane",
  "restart-web",
  "restart-daemon",
] as const;

type StepName = (typeof UPDATE_STEPS)[number];

/** Dumps kept in the backups folder. */
export const BACKUPS_KEEP = 5;
/** The development database container (postgres role default). */
export const POSTGRES_CONTAINER = "turbopanel-database";

export type WaitResult = { ok: true } | { ok: false; detail: string };

export type JobDeps = {
  paths: DevHostPaths;
  parts: readonly DevHostPartSpec[];
  run: RunCommand;
  collector: DevHostStatusCollector;
  gitEnv?: Record<string, string>;
  nowMs?: () => number;
  newId?: () => string;
  /** This process's pid (lock owner). */
  pid?: number;
  pidAlive?: (pid: number) => Promise<boolean>;
  /** `sudo` argv for a root host command (default {@link hostSudoArgs}). */
  sudoArgs?: (args: string[]) => string[];
  /** The pnpm program and the whole environment it runs with. */
  pnpm?: { program: string; env: Record<string, string> };
  /** The control plane unit's `TURBOPANEL_DATABASE_URL`. */
  databaseUrl?: () => Promise<string | null>;
  /** Wait until the control plane restarted after `sinceMs` and answers. */
  waitControlPlane?: (
    sinceMs: number,
    targetCommit: string | null,
  ) => Promise<WaitResult>;
  /** Wait until `unit` restarted after `sinceMs` and is active. */
  waitUnit?: (unit: string, sinceMs: number) => Promise<WaitResult>;
  /** Called after every write of the job. */
  onChange?: (job: DevHostJob) => void;
  postgresContainer?: string;
};

export type StartResult =
  | { ok: true; jobId: string }
  | { ok: false; error: "job_running" };

type StepOutcome = {
  state: "done" | "skipped" | "failed";
  detail?: string;
  /** Runs after the job is written as finished (the daemon's own restart). */
  after?: () => Promise<void>;
};

type JobContext = { secrets: string[] };

export class DevHostJobRunner {
  readonly #deps: JobDeps;
  #job: DevHostJob | null = null;
  #running = false;
  #finished: Promise<void> = Promise.resolve();

  constructor(deps: JobDeps) {
    this.#deps = deps;
  }

  #now(): number {
    return (this.#deps.nowMs ?? Date.now)();
  }

  #iso(): string {
    return new Date(this.#now()).toISOString();
  }

  /** The current or last job. */
  current(): DevHostJob | null {
    return this.#job;
  }

  /** Resolves when the running job (if any) has finished. */
  settled(): Promise<void> {
    return this.#finished;
  }

  /**
   * Load the last job from disk. A job still `running` was cut short by a
   * daemon stop (the planned self-restart writes `done` first), so it is
   * marked `failed`.
   */
  async recover(): Promise<void> {
    let job: DevHostJob | null = null;
    try {
      job = parseJob(
        JSON.parse(await Deno.readTextFile(this.#deps.paths.jobFile)),
      );
    } catch {
      job = null;
    }
    if (!job) return;
    if (job.state === "running") {
      job.state = "failed";
      job.endedAt = this.#iso();
      for (const step of job.steps) {
        if (step.state === "running") {
          step.state = "failed";
          step.detail = "the daemon stopped before this step finished";
        } else if (step.state === "pending") {
          step.state = "skipped";
        }
      }
      this.#job = job;
      await this.#persist();
      await this.#releaseLock();
      return;
    }
    this.#job = job;
  }

  /** Start a job unless one is running. Returns at once; the steps run on. */
  async start(action: DevHostAction): Promise<StartResult> {
    if (this.#running) return { ok: false, error: "job_running" };
    this.#running = true;
    try {
      await Deno.mkdir(this.#deps.paths.dir, { recursive: true, mode: 0o750 });
      if (!(await this.#acquireLock())) {
        this.#running = false;
        return { ok: false, error: "job_running" };
      }
    } catch (err) {
      this.#running = false;
      throw err;
    }
    const names: readonly StepName[] = action === "update"
      ? UPDATE_STEPS
      : RESTART_STEPS;
    const job: DevHostJob = {
      id: (this.#deps.newId ?? (() => crypto.randomUUID()))(),
      action,
      state: "running",
      step: names[0],
      steps: names.map((name) => ({ name, state: "pending" })),
      startedAt: this.#iso(),
      endedAt: null,
      logTail: [],
    };
    this.#job = job;
    await this.#persist();
    this.#finished = this.#execute(job).catch((err) => {
      logWarn("dev-host", "job stopped:", String(err));
    }).finally(() => {
      this.#running = false;
    });
    return { ok: true, jobId: job.id };
  }

  async #execute(job: DevHostJob): Promise<void> {
    const ctx: JobContext = { secrets: [] };
    let after: (() => Promise<void>) | undefined;
    // Steps run in order; the first failed one stops the job.
    const failed = await firstSequential(job.steps, async (step) => {
      const outcome = await this.#runOne(step, job, ctx);
      after = outcome.after;
      return outcome.state === "failed" ? true : undefined;
    });
    if (failed) {
      for (const rest of job.steps) {
        if (rest.state === "pending") rest.state = "skipped";
      }
      job.state = "failed";
    } else {
      job.state = "done";
    }
    job.endedAt = this.#iso();
    await this.#persist();
    await this.#releaseLock();
    if (after) await after();
  }

  /** Run one step, recording its state and detail on the job. */
  async #runOne(
    step: DevHostJobStep,
    job: DevHostJob,
    ctx: JobContext,
  ): Promise<StepOutcome> {
    job.step = step.name;
    step.state = "running";
    await this.#persist();
    let outcome: StepOutcome;
    try {
      outcome = await this.#runStep(step.name as StepName, job, ctx);
    } catch (err) {
      outcome = { state: "failed", detail: String(err) };
    }
    step.state = outcome.state;
    if (outcome.detail) {
      step.detail = clipText(outcome.detail, MAX_DEV_HOST_TEXT_CHARS);
    }
    return outcome;
  }

  #runStep(
    name: StepName,
    job: DevHostJob,
    ctx: JobContext,
  ): Promise<StepOutcome> {
    switch (name) {
      case "fetch":
        return this.#stepFetch(job);
      case "pull":
        return this.#stepPull(job);
      case "install":
        return this.#stepInstall(job);
      case "migrate":
        return this.#stepMigrate(job, ctx);
      case "restart-control-plane":
        return this.#stepRestartControlPlane(job);
      case "restart-web":
        return this.#stepRestartWeb(job);
      case "restart-daemon":
        return this.#stepRestartDaemon(job);
    }
  }

  #spec(name: DevHostPartName): DevHostPartSpec {
    const spec = this.#deps.parts.find((p) => p.name === name);
    if (!spec) throw new Error(`no ${name} part`);
    return spec;
  }

  #repo(spec: DevHostPartSpec): string {
    return partCheckout(this.#deps.paths, spec);
  }

  #tail(job: DevHostJob, result: CommandResult, secrets: string[] = []): void {
    job.logTail = logTail(combinedOutput(result), secrets);
  }

  async #stepFetch(job: DevHostJob): Promise<StepOutcome> {
    const failed: string[] = [];
    await forEachSequential(this.#deps.parts, async (spec) => {
      const repo = this.#repo(spec);
      if (!(await readHead(repo))) return;
      const result = await fetchTrunk(this.#deps.run, repo, this.#deps.gitEnv);
      this.#tail(job, result);
      if (result.code === 0) {
        this.#deps.collector.noteFetched(spec.name);
      } else {
        failed.push(`${spec.name}: ${lastLine(result, "fetch failed")}`);
      }
    });
    return failed.length > 0
      ? { state: "done", detail: `fetch failed for ${failed.join("; ")}` }
      : { state: "done" };
  }

  async #stepPull(job: DevHostJob): Promise<StepOutcome> {
    const lines = await mapSequential(
      this.#deps.parts,
      async (spec) => `${spec.name}: ${await this.#pullOne(spec, job)}`,
    );
    return { state: "done", detail: lines.join("; ") };
  }

  /** Fast-forward one checkout when it is on trunk with no content change. */
  async #pullOne(spec: DevHostPartSpec, job: DevHostJob): Promise<string> {
    const repo = this.#repo(spec);
    const head = await readHead(repo);
    if (!head) return "checkout missing";
    if (head.branch !== TRUNK) {
      return `on branch ${head.branch ?? "(detached)"}, not pulled`;
    }
    const { dirty, error } = await readDirty(
      this.#deps.run,
      repo,
      spec.repo,
      this.#deps.gitEnv,
    );
    if (error) return `${error}, not pulled`;
    if (dirty.blocking) return "has local changes, not pulled";
    const result = await fastForwardTrunk(
      this.#deps.run,
      repo,
      this.#deps.gitEnv,
    );
    this.#tail(job, result);
    if (result.code !== 0) {
      const reason = `fast-forward refused: ${
        lastLine(result, "git merge --ff-only failed")
      }`;
      await this.#deps.collector.noteBlocked(spec, reason);
      return reason;
    }
    const after = await readHead(repo);
    if (after?.commit && after.commit !== head.commit) {
      return `updated to ${after.commit.slice(0, 7)}`;
    }
    return "up to date";
  }

  async #stepInstall(job: DevHostJob): Promise<StepOutcome> {
    const pnpm = this.#pnpm();
    const done: string[] = [];
    const failure = await firstSequential(
      this.#deps.parts,
      async (spec): Promise<StepOutcome | undefined> => {
        const repo = this.#repo(spec);
        if (!spec.installs || !(await readHead(repo))) return undefined;
        if (!(await installNeeded(repo))) return undefined;
        const result = await this.#deps.run(
          pnpm.program,
          ["install", "--frozen-lockfile"],
          { cwd: repo, env: pnpm.env, clearEnv: true, timeoutMs: 20 * 60_000 },
        );
        this.#tail(job, result);
        if (result.code !== 0) {
          const why = lastLine(result, exitText(result));
          return {
            state: "failed",
            detail: `${spec.name}: pnpm install failed: ${why}`,
          };
        }
        done.push(spec.name);
        return undefined;
      },
    );
    if (failure) return failure;
    return done.length > 0
      ? { state: "done", detail: `installed packages for ${done.join(", ")}` }
      : { state: "skipped", detail: "packages are current" };
  }

  async #stepMigrate(job: DevHostJob, ctx: JobContext): Promise<StepOutcome> {
    const spec = this.#spec("control-plane");
    const repo = this.#repo(spec);
    if (!(await readHead(repo))) {
      return { state: "skipped", detail: "control plane checkout missing" };
    }
    const url =
      await (this.#deps.databaseUrl ?? (() => Promise.resolve(null)))();
    if (!url) {
      return {
        state: "failed",
        detail: "no database URL in the control plane unit; not migrating",
      };
    }
    ctx.secrets.push(...urlSecrets(url));
    const plan = buildBackupCommand(
      url,
      this.#deps.paths.backupsDir,
      this.#deps.postgresContainer ?? POSTGRES_CONTAINER,
    );
    if ("error" in plan) {
      return {
        state: "failed",
        detail: `cannot take a database backup (${plan.error}); not migrating`,
      };
    }
    try {
      await Deno.mkdir(this.#deps.paths.backupsDir, {
        recursive: true,
        mode: 0o700,
      });
    } catch (err) {
      return {
        state: "failed",
        detail: `cannot create the backups folder (${
          err instanceof Error ? err.message : String(err)
        }); not migrating`,
      };
    }
    const pnpm = this.#pnpm();
    // `pnpm migrate` is a no-op when the schema is current. When anything is
    // pending, the control plane's migrate script runs the backup command
    // first and refuses to migrate if it fails.
    const result = await this.#deps.run(pnpm.program, ["migrate"], {
      cwd: repo,
      env: {
        ...pnpm.env,
        TURBOPANEL_DATABASE_URL: url,
        TURBOPANEL_MIGRATE_BACKUP_COMMAND: plan.command,
      },
      clearEnv: true,
      timeoutMs: 30 * 60_000,
    });
    this.#tail(job, result, ctx.secrets);
    await pruneBackups(this.#deps.paths.backupsDir, BACKUPS_KEEP);
    if (result.code !== 0) {
      const tail = logTail(combinedOutput(result), ctx.secrets);
      const why = tail.at(-1) ?? exitText(result);
      return { state: "failed", detail: `migration failed: ${why}` };
    }
    const output = combinedOutput(result);
    return {
      state: "done",
      detail: output.includes("database backup finished")
        ? "migrated after a database backup"
        : "schema already current",
    };
  }

  async #restartUnit(unit: string): Promise<CommandResult> {
    const argv = this.#deps.sudoArgs
      ? this.#deps.sudoArgs(["-n", "systemctl", "restart", "--no-block", unit])
      : hostSudoArgs(["-n", "systemctl", "restart", "--no-block", unit]);
    return await this.#deps.run("sudo", argv, { timeoutMs: 30_000 });
  }

  async #stepRestartControlPlane(job: DevHostJob): Promise<StepOutcome> {
    const spec = this.#spec("control-plane");
    const requestedAt = this.#now();
    const result = await this.#restartUnit(spec.unit);
    this.#tail(job, result);
    if (result.code !== 0) {
      const why = lastLine(result, exitText(result));
      return { state: "failed", detail: `restart refused: ${why}` };
    }
    const head = await readHead(this.#repo(spec));
    const wait = this.#deps.waitControlPlane ??
      ((since: number, target: string | null) =>
        waitForControlPlane(this.#deps.run, spec.unit, since, target));
    const answered = await wait(requestedAt, head?.commit ?? null);
    if (!answered.ok) return { state: "failed", detail: answered.detail };
    return { state: "done", detail: "control plane is back" };
  }

  async #stepRestartWeb(job: DevHostJob): Promise<StepOutcome> {
    const web = this.#deps.parts.filter((p) =>
      p.name === "web-interface" || p.name === "website"
    );
    const needed = await Promise.all(
      web.map((spec) => this.#deps.collector.restartNeeded(spec)),
    );
    const targets = web.filter((_, i) => needed[i]);
    if (targets.length === 0) {
      return { state: "skipped", detail: "no restart needed" };
    }
    const requestedAt = this.#now();
    const refused = await firstSequential(
      targets,
      async (part): Promise<StepOutcome | undefined> => {
        const result = await this.#restartUnit(part.unit);
        this.#tail(job, result);
        if (result.code === 0) return undefined;
        const why = lastLine(result, exitText(result));
        return {
          state: "failed",
          detail: `${part.name}: restart refused: ${why}`,
        };
      },
    );
    if (refused) return refused;
    const wait = this.#deps.waitUnit ??
      ((unit: string, since: number) =>
        waitForUnit(this.#deps.run, unit, since));
    const late = await firstSequential(
      targets,
      async (part): Promise<StepOutcome | undefined> => {
        const up = await wait(part.unit, requestedAt);
        return up.ok
          ? undefined
          : { state: "failed", detail: `${part.name}: ${up.detail}` };
      },
    );
    if (late) return late;
    return {
      state: "done",
      detail: `restarted ${targets.map((p) => p.name).join(", ")}`,
    };
  }

  async #stepRestartDaemon(job: DevHostJob): Promise<StepOutcome> {
    const spec = this.#spec("daemon");
    if (!(await this.#deps.collector.restartNeeded(spec))) {
      return { state: "skipped", detail: "the daemon is up to date" };
    }
    return {
      state: "done",
      detail: "restarting the daemon",
      // Runs after `done` is on disk: this restart ends this process.
      after: async () => {
        const result = await this.#restartUnit(spec.unit);
        if (result.code === 0) return;
        const detail = `daemon restart refused: ${
          lastLine(result, exitText(result))
        }`;
        logWarn("dev-host", detail);
        const step = job.steps.find((s) => s.name === "restart-daemon");
        if (step) step.detail = clipText(detail, MAX_DEV_HOST_TEXT_CHARS);
        this.#tail(job, result);
        await this.#persist();
      },
    };
  }

  #pnpm(): { program: string; env: Record<string, string> } {
    return this.#deps.pnpm ?? defaultPnpm(Deno.env.toObject());
  }

  async #persist(): Promise<void> {
    const job = this.#job;
    if (!job) return;
    try {
      await writeJsonAtomic(this.#deps.paths.jobFile, job);
    } catch (err) {
      logWarn("dev-host", "could not write the job file:", String(err));
    }
    this.#deps.onChange?.(structuredClone(job));
  }

  async #acquireLock(): Promise<boolean> {
    const pid = this.#deps.pid ?? Deno.pid;
    if (await this.#createLock(pid)) return true;
    const owner = Number.parseInt(
      (await Deno.readTextFile(this.#deps.paths.lockFile).catch(() => ""))
        .trim(),
      10,
    );
    const alive = this.#deps.pidAlive ?? pidAlive;
    // Our own pid with no job running here, or a dead pid: a stale lock.
    if (Number.isFinite(owner) && owner !== pid && await alive(owner)) {
      return false;
    }
    await Deno.remove(this.#deps.paths.lockFile).catch(() => undefined);
    return await this.#createLock(pid);
  }

  /** Create the lock file holding `pid`; false when it already exists. */
  async #createLock(pid: number): Promise<boolean> {
    try {
      const file = await Deno.open(this.#deps.paths.lockFile, {
        createNew: true,
        write: true,
        mode: 0o640,
      });
      await file.write(new TextEncoder().encode(`${pid}\n`));
      file.close();
      return true;
    } catch (err) {
      if (err instanceof Deno.errors.AlreadyExists) return false;
      throw err;
    }
  }

  async #releaseLock(): Promise<void> {
    await Deno.remove(this.#deps.paths.lockFile).catch(() => undefined);
  }
}

/** Every value in a database URL that must never reach a log line. */
export function urlSecrets(url: string): string[] {
  const out = [url];
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      out.push(parsed.password, decodeURIComponent(parsed.password));
    }
  } catch {
    // Unparseable: only the whole URL is known.
  }
  return out.filter((s) => s.length > 0);
}

const SAFE_NAME = /^\w[\w.-]{0,62}$/;
const SAFE_DIR = /^\/[A-Za-z0-9_./-]+$/;

/**
 * The shell command `TURBOPANEL_MIGRATE_BACKUP_COMMAND` runs before a
 * migration: `pg_dump -Fc` inside the database container over its local
 * connection (the same way the nightly backup does, so no password is passed),
 * written to a `.part` file and renamed when complete. The user and database
 * come from the URL and must be plain names; the folder must be a plain
 * absolute path. Anything else is refused, so the migration never runs
 * without a backup.
 */
export function buildBackupCommand(
  url: string,
  backupsDir: string,
  container: string,
): { command: string } | { error: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: "the database URL cannot be read" };
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    return { error: "the database URL is not a Postgres URL" };
  }
  const user = decodeURIComponent(parsed.username);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!SAFE_NAME.test(user)) return { error: "no plain user name in the URL" };
  if (!SAFE_NAME.test(database)) {
    return { error: "no plain database name in the URL" };
  }
  if (!SAFE_DIR.test(backupsDir) || backupsDir.includes("..")) {
    return { error: "the backups folder is not a plain path" };
  }
  if (!SAFE_NAME.test(container)) return { error: "bad container name" };
  const command = [
    "set -eu",
    "umask 077",
    `f='${backupsDir}'/turbopanel-$(date -u +%Y%m%dT%H%M%SZ).dump`,
    `trap 'rm -f -- "$f.part"' EXIT`,
    `docker exec ${container} pg_dump -Fc -U '${user}' -d '${database}' > "$f.part"`,
    `test -s "$f.part"`,
    `mv -- "$f.part" "$f"`,
    "trap - EXIT",
    `echo "backup written to $f"`,
  ].join("; ");
  return { command };
}

/** Keep the newest `keep` `turbopanel-*.dump` files (names sort by time). */
export async function pruneBackups(dir: string, keep: number): Promise<void> {
  let names: string[];
  try {
    names = (await Array.fromAsync(Deno.readDir(dir)))
      .filter((e) =>
        e.isFile && e.name.startsWith("turbopanel-") && e.name.endsWith(".dump")
      )
      .map((e) => e.name)
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return;
  }
  await Promise.all(
    names.slice(keep).map((name) =>
      Deno.remove(join(dir, name)).catch(() => undefined)
    ),
  );
}

/** `exit <code>`, the fallback reason when a command printed nothing. */
function exitText(result: CommandResult): string {
  return "exit " + String(result.code);
}

/** pnpm from the vendored Node, with a clean environment. */
export function defaultPnpm(
  env: Record<string, string | undefined>,
): { program: string; env: Record<string, string> } {
  const runtimes = resolveRuntimesDir(env, { forceMode: "development" });
  const nodeBin = join(runtimes, "node", "current", "bin");
  const home = env.TURBOPANEL_DEV_HOME?.trim() || env.HOME?.trim() || "/tmp";
  return {
    program: join(nodeBin, "pnpm"),
    env: {
      PATH: `${nodeBin}:/usr/local/bin:/usr/bin:/bin`,
      HOME: home,
      CI: "1",
    },
  };
}

export async function pidAlive(pid: number): Promise<boolean> {
  try {
    await Deno.stat(`/proc/${pid}`);
    return true;
  } catch {
    return false;
  }
}

export async function writeJsonAtomic(
  path: string,
  value: unknown,
): Promise<void> {
  const temp = `${path}.tmp-${Deno.pid}`;
  try {
    await Deno.writeTextFile(temp, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o640,
    });
    await Deno.rename(temp, path);
  } catch (err) {
    await Deno.remove(temp).catch(() => undefined);
    throw err;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const STEP_STATES = new Set([
  "pending",
  "running",
  "done",
  "skipped",
  "failed",
]);

function parseStep(s: unknown): DevHostJobStep | null {
  if (!isRecord(s) || typeof s.name !== "string") return null;
  if (typeof s.state !== "string" || !STEP_STATES.has(s.state)) return null;
  return {
    name: s.name,
    state: s.state as DevHostJobStep["state"],
    ...(typeof s.detail === "string" ? { detail: s.detail } : {}),
  };
}

/** A job read back from disk, or null when it is not one. */
export function parseJob(value: unknown): DevHostJob | null {
  if (!isRecord(value)) return null;
  const { id, action, state, step, steps, startedAt, endedAt, logTail } = value;
  if (typeof id !== "string" || typeof step !== "string") return null;
  if (action !== "update" && action !== "restart") return null;
  if (state !== "running" && state !== "done" && state !== "failed") {
    return null;
  }
  if (typeof startedAt !== "string") return null;
  if (endedAt !== null && typeof endedAt !== "string") return null;
  if (!Array.isArray(steps) || !Array.isArray(logTail)) return null;
  const parsedSteps = steps.map(parseStep);
  if (parsedSteps.includes(null)) return null;
  return {
    id,
    action,
    state,
    step,
    steps: parsedSteps as DevHostJobStep[],
    startedAt,
    endedAt,
    logTail: logTail.filter((l): l is string => typeof l === "string").slice(
      -MAX_DEV_HOST_LOG_TAIL_LINES,
    ),
  };
}

const POLL_MS = 2_000;
export const CONTROL_PLANE_WAIT_MS = 5 * 60_000;
export const UNIT_WAIT_MS = 2 * 60_000;

export type PollDeps = {
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
};

function shortSha(sha: string | null): string {
  return String(sha).slice(0, 7);
}

/** A unit started at or after `sinceMs` (systemd stamps are whole seconds). */
function startedSince(startedAtMs: number | null, sinceMs: number): boolean {
  return startedAtMs !== null &&
    startedAtMs >= Math.floor(sinceMs / 1000) * 1000;
}

async function pollUntil(
  check: () => Promise<boolean>,
  deps: PollDeps,
  timeoutMs: number,
): Promise<boolean> {
  const now = deps.nowMs ?? Date.now;
  const sleep = deps.sleep ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + (deps.timeoutMs ?? timeoutMs);
  let ok = false;
  await repeatSequential(async () => {
    ok = await check();
    if (ok || now() >= deadline) return false;
    await sleep(POLL_MS);
    return true;
  });
  return ok;
}

/** Wait until `unit` was restarted after `sinceMs` and is active. */
export async function waitForUnit(
  run: RunCommand,
  unit: string,
  sinceMs: number,
  deps: PollDeps = {},
): Promise<WaitResult> {
  const ok = await pollUntil(
    async () => {
      const state = (await readUnits(run, [unit])).get(unit);
      return !!state?.active && startedSince(state.startedAtMs, sinceMs);
    },
    deps,
    UNIT_WAIT_MS,
  );
  return ok
    ? { ok: true }
    : { ok: false, detail: `${unit} did not come back in time` };
}

export type HealthAnswer = { ok: boolean; commit: string | null };

/** `GET /api/health` on the control plane socket. */
export async function readControlPlaneHealth(
  socketPath: string,
): Promise<HealthAnswer> {
  let client: Deno.HttpClient | undefined;
  try {
    client = Deno.createHttpClient({
      proxy: { transport: "unix", path: socketPath },
    });
    const response = await fetch("http://localhost/api/health", { client });
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, commit: null };
    }
    const body = await response.json().catch(() => null) as
      | { revision?: { commit?: unknown } }
      | null;
    const commit = body?.revision?.commit;
    return { ok: true, commit: typeof commit === "string" ? commit : null };
  } catch {
    return { ok: false, commit: null };
  } finally {
    client?.close();
  }
}

/**
 * Wait until the control plane unit restarted after `sinceMs`, is active and
 * answers `/api/health`. A development control plane usually reports no
 * commit (`unknown`); when it does report one, it must be `targetCommit`.
 */
export async function waitForControlPlane(
  run: RunCommand,
  unit: string,
  sinceMs: number,
  targetCommit: string | null,
  deps: PollDeps & {
    readHealth?: () => Promise<HealthAnswer>;
    socketPath?: string;
  } = {},
): Promise<WaitResult> {
  const readHealth = deps.readHealth ??
    (() => readControlPlaneHealth(deps.socketPath ?? resolveInstanceSocket()));
  let mismatch: string | null = null;
  const ok = await pollUntil(
    async () => {
      const state = (await readUnits(run, [unit])).get(unit);
      if (!state?.active || !startedSince(state.startedAtMs, sinceMs)) {
        return false;
      }
      const health = await readHealth();
      if (!health.ok) return false;
      const reported = health.commit ?? "";
      if (!/^[0-9a-f]{40}$/.test(reported) || !targetCommit) return true;
      if (reported === targetCommit) return true;
      mismatch = reported;
      return false;
    },
    deps,
    CONTROL_PLANE_WAIT_MS,
  );
  if (ok) return { ok: true };
  return {
    ok: false,
    detail: mismatch
      ? `control plane answered on ${
        shortSha(mismatch)
      }, not the checkout's commit`
      : "control plane did not answer in time",
  };
}
