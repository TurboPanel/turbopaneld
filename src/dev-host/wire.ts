/**
 * The development host on the cell wire (feature `dev-host-v1`).
 *
 * - `dev-host-status` (daemon → control plane, fire-and-forget): sent on
 *   attach, whenever the job changes, and after every 60 s status tick; only
 *   to a control plane that lists `dev-host-v1`.
 * - `dev-host-action` → `dev-host-action-result` (correlated on `id`): start
 *   Update and Restart (`update`) or Restart Only (`restart`). The action enum
 *   is the only input taken from the wire.
 *
 * The status is also written to `<state>/dev-updates/status.json` on every
 * change, so the Developer Console can read it while the control plane is
 * down. A daemon that is not a development install with
 * `TURBOPANEL_DEV_INSTANCE=1` has no service and answers `not_development`.
 */
import {
  type DaemonMessage,
  type DevHostActionMessage,
  type DevHostActionResultMessage,
  type DevHostJob,
  type DevHostStatus,
  MAX_DEV_HOST_STATUS_BYTES,
} from "../contracts/cell-messages.ts";
import { logWarn } from "../util/logger.ts";
import { getBuildInfo } from "../build-info.ts";
import { runCommand } from "./commands.ts";
import {
  devHostEnabled,
  type DevHostPartName,
  devHostParts,
  type DevHostPartSpec,
  type DevHostPaths,
  partCheckout,
  resolveDevHostPaths,
} from "./config.ts";
import {
  type DevHostAction,
  DevHostJobRunner,
  POSTGRES_CONTAINER,
  type StartResult,
  writeJsonAtomic,
} from "./job.ts";
import { DevHostStatusCollector } from "./status.ts";
import { readInstanceDatabaseUrl } from "./units.ts";
import { join } from "@std/path";
import {
  aheadOfTrunk,
  AutoMigrate,
  readAppliedHashes,
  readTrunkHashes,
} from "./auto-migrate.ts";
import { readHead, readRef, REMOTE_TRUNK_REF } from "./git.ts";

/** Status tick and the longest gap between two status frames. */
export const DEV_HOST_TICK_MS = 60_000;

/** The socket the status goes out on, as the instance client provides it. */
export type DevHostLink = {
  /** Send one frame; false when the socket is not open. */
  send: (message: DaemonMessage) => boolean;
  /** True while the control plane lists `dev-host-v1`. */
  peerSupports: () => boolean;
};

/** What the instance client needs from the development host. */
export type DevHostPort = {
  attach: (link: DevHostLink) => void;
  detach: () => void;
  /** The attach frame's feature list arrived or changed. */
  peerFeaturesChanged: () => void;
  /** The attach frame's `commit` (the control plane's running build). */
  setControlPlaneCommit: (commit: unknown) => void;
  start: (action: DevHostAction) => Promise<StartResult>;
};

/** Room left under the control plane's cap for the frame's own fields. */
const STATUS_BYTES_BUDGET = MAX_DEV_HOST_STATUS_BYTES - 4096;

function statusBytes(status: DevHostStatus): number {
  return new TextEncoder().encode(JSON.stringify(status)).length;
}

/**
 * Keep the status under the control plane's size cap: drop most dirty
 * entries first (`files` keeps the full count), then all of them and the log
 * tail. A normal status is far below the cap and comes back unchanged.
 */
export function boundStatus(status: DevHostStatus): DevHostStatus {
  if (statusBytes(status) <= STATUS_BYTES_BUDGET) return status;
  for (const keep of [10, 0]) {
    const smaller: DevHostStatus = {
      ...status,
      parts: status.parts.map((p) => ({
        ...p,
        dirty: { ...p.dirty, kinds: p.dirty.kinds.slice(0, keep) },
      })),
      job: status.job && keep === 0
        ? { ...status.job, logTail: [] }
        : status.job,
    };
    if (statusBytes(smaller) <= STATUS_BYTES_BUDGET || keep === 0) {
      return smaller;
    }
  }
  return status;
}

function isAction(value: unknown): value is DevHostAction {
  return value === "update" || value === "restart";
}

/**
 * Answer a `dev-host-action`. Null (nothing to send) when the frame is not a
 * well-formed action; `not_development` when this daemon has no development
 * host.
 */
export async function answerDevHostAction(
  port: Pick<DevHostPort, "start"> | undefined,
  message: Partial<DevHostActionMessage>,
  nowMs: () => number = Date.now,
): Promise<DevHostActionResultMessage | null> {
  if (typeof message.id !== "string" || !isAction(message.action)) {
    logWarn("dev-host", "ignored a malformed dev-host-action");
    return null;
  }
  const base = { type: "dev-host-action-result" as const, id: message.id };
  if (!port) {
    return {
      ...base,
      ok: false,
      error: "not_development",
      at: new Date(nowMs()).toISOString(),
    };
  }
  let result: StartResult | { ok: false; error: "start_failed" };
  try {
    result = await port.start(message.action);
  } catch (err) {
    // Not `job_running`: nothing is running, the job could not be started.
    logWarn("dev-host", "could not start the job:", String(err));
    result = { ok: false, error: "start_failed" };
  }
  const at = new Date(nowMs()).toISOString();
  return result.ok
    ? { ...base, ok: true, jobId: result.jobId, at }
    : { ...base, ok: false, error: result.error, at };
}

export type DevHostServiceDeps = {
  collector: DevHostStatusCollector;
  jobs: DevHostJobRunner;
  paths: Pick<DevHostPaths, "dir" | "statusFile">;
  nowMs?: () => number;
  tickMs?: number;
  writeStatus?: (status: DevHostStatus) => Promise<void>;
  /** Starts Update and Restart when trunk has migrations the database lacks. */
  autoMigrate?: Pick<AutoMigrate, "review">;
  /** Test seam for the minute timer. */
  every?: (fn: () => void, ms: number) => () => void;
};

export class DevHostService implements DevHostPort {
  readonly #deps: DevHostServiceDeps;
  #link: DevHostLink | undefined;
  #status: DevHostStatus | null = null;
  #cancelTimer: (() => void) | undefined;
  #ticking: Promise<void> | null = null;
  #controlPlaneCommit: string | null = null;

  constructor(deps: DevHostServiceDeps) {
    this.#deps = deps;
  }

  /** The control plane's running commit from the attach frame. */
  controlPlaneCommit(): string | null {
    return this.#controlPlaneCommit;
  }

  /** Recover the last job, take the first reading, then tick every minute. */
  async run(): Promise<void> {
    await this.#deps.jobs.recover();
    await this.tick();
    if (this.#cancelTimer) return;
    const every = this.#deps.every ?? ((fn: () => void, ms: number) => {
      const id = setInterval(fn, ms);
      return () => clearInterval(id);
    });
    this.#cancelTimer = every(() => {
      void this.tick();
    }, this.#deps.tickMs ?? DEV_HOST_TICK_MS);
  }

  stop(): void {
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
    this.#link = undefined;
  }

  /** The last status built (null before the first tick). */
  status(): DevHostStatus | null {
    return this.#status;
  }

  /** Build a fresh status, write it and send it. Overlapping calls share one run. */
  tick(): Promise<void> {
    this.#ticking ??= (async () => {
      try {
        let status = await this.#deps.collector.collect(
          this.#deps.jobs.current(),
        );
        if (this.#deps.autoMigrate) {
          try {
            status = await this.#deps.autoMigrate.review(status);
          } catch (err) {
            // The collected status still goes out.
            logWarn("dev-host", "migration review failed:", String(err));
          }
          // A job started by the review has already been published; keep it.
          status = { ...status, job: this.#deps.jobs.current() };
        }
        await this.#publish(status);
      } catch (err) {
        logWarn("dev-host", "status tick failed:", String(err));
      } finally {
        this.#ticking = null;
      }
    })();
    return this.#ticking;
  }

  /** A job step changed: send the new job at once; re-read everything when it ends. */
  jobChanged(job: DevHostJob): void {
    if (this.#status) void this.#publish({ ...this.#status, job });
    if (job.state !== "running") void this.tick();
  }

  attach(link: DevHostLink): void {
    this.#link = link;
    this.#send();
  }

  detach(): void {
    this.#link = undefined;
  }

  peerFeaturesChanged(): void {
    this.#send();
  }

  setControlPlaneCommit(commit: unknown): void {
    this.#controlPlaneCommit = typeof commit === "string" ? commit : null;
  }

  async start(action: DevHostAction): Promise<StartResult> {
    const result = await this.#deps.jobs.start(action);
    // A job always fetches fresh refs, so the next tick need not wait 10 min.
    if (result.ok && action === "update") this.#deps.collector.requestFetch();
    return result;
  }

  async #publish(full: DevHostStatus): Promise<void> {
    const status = boundStatus(full);
    this.#status = status;
    this.#send();
    try {
      await (this.#deps.writeStatus ?? ((s) => this.#writeStatusFile(s)))(
        status,
      );
    } catch (err) {
      logWarn("dev-host", "could not write status.json:", String(err));
    }
  }

  async #writeStatusFile(status: DevHostStatus): Promise<void> {
    await Deno.mkdir(this.#deps.paths.dir, { recursive: true, mode: 0o750 });
    await writeJsonAtomic(this.#deps.paths.statusFile, {
      ...status,
      writtenAt: new Date((this.#deps.nowMs ?? Date.now)()).toISOString(),
    });
  }

  #send(): void {
    const link = this.#link;
    const status = this.#status;
    if (!link || !status || !link.peerSupports()) return;
    link.send({
      type: "dev-host-status",
      status,
      at: new Date((this.#deps.nowMs ?? Date.now)()).toISOString(),
    });
  }
}

/** The migration watch on the real control plane checkout and database. */
function autoMigrateFor(
  paths: Pick<DevHostPaths, "devRoot" | "dir">,
  parts: readonly DevHostPartSpec[],
  controlPlaneRepo: string,
  databaseUrl: () => Promise<string | null>,
  ref: { service?: DevHostService },
): AutoMigrate {
  const repos = parts.map((spec) => ({
    name: spec.name,
    repo: partCheckout(paths, spec),
  }));
  const triedFile = join(paths.dir, "auto-migrate.json");
  return new AutoMigrate({
    // Every checkout's refs, so the ahead-of-trunk check reruns when any moves.
    refsKey: async () => {
      const keys = await Promise.all(repos.map(async ({ repo }) => {
        const remote = await readRef(repo, REMOTE_TRUNK_REF);
        const head = await readHead(repo);
        return `${remote ?? "-"}..${head?.commit ?? "-"}`;
      }));
      const controlPlane = await readRef(controlPlaneRepo, REMOTE_TRUNK_REF);
      return controlPlane ? keys.join(" ") : null;
    },
    trunkHashes: () => readTrunkHashes(runCommand, controlPlaneRepo),
    appliedHashes: async () =>
      readAppliedHashes(runCommand, await databaseUrl(), POSTGRES_CONTAINER),
    partsAheadOfTrunk: async () => {
      const ahead = await Promise.all(
        repos.map(async ({ name, repo }) =>
          (await aheadOfTrunk(runCommand, repo)) ? name : null
        ),
      );
      return ahead.filter((name): name is DevHostPartName => name !== null);
    },
    startUpdate: async () => (await ref.service?.start("update"))?.ok === true,
    loadTried: async () => {
      try {
        const saved = JSON.parse(await Deno.readTextFile(triedFile));
        return typeof saved?.trunk === "string" ? saved.trunk : null;
      } catch {
        return null;
      }
    },
    saveTried: async (trunk) => {
      await Deno.mkdir(paths.dir, { recursive: true, mode: 0o750 });
      await writeJsonAtomic(triedFile, { trunk });
    },
  });
}

/**
 * Build and start the development host when this is a development install
 * with `TURBOPANEL_DEV_INSTANCE=1`; null (inert) otherwise.
 */
export function startDevHostIfEnabled(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): DevHostService | null {
  if (!devHostEnabled(env)) return null;
  const paths = resolveDevHostPaths(env);
  const parts = devHostParts(env);
  const commit = getBuildInfo().commit;
  // The collector and the job runner call back into the service built below.
  const ref: { service?: DevHostService } = {};
  const collector = new DevHostStatusCollector({
    paths,
    parts,
    run: runCommand,
    daemonCommit: commit,
    controlPlaneCommit: () => ref.service?.controlPlaneCommit() ?? null,
  });
  const controlPlane = parts.find((p) => p.name === "control-plane");
  const databaseUrl = () =>
    readInstanceDatabaseUrl(
      runCommand,
      controlPlane?.unit ?? "turbopanel-instance",
    );
  const jobs = new DevHostJobRunner({
    paths,
    parts,
    run: runCommand,
    collector,
    databaseUrl,
    onChange: (job) => ref.service?.jobChanged(job),
  });
  const autoMigrate = controlPlane
    ? autoMigrateFor(
      paths,
      parts,
      partCheckout(paths, controlPlane),
      databaseUrl,
      ref,
    )
    : undefined;
  const service = new DevHostService({ collector, jobs, paths, autoMigrate });
  ref.service = service;
  void service.run().catch((err) =>
    logWarn("dev-host", "could not start:", String(err))
  );
  return service;
}
