/**
 * A site's background workers (queue workers and the like): long-running
 * commands kept running as managed units under the site's own account.
 *
 * One template unit per worker, `turbopanel-worker-<env>-<service>-<name>@.service`,
 * with instances `@1` to `@<processes>`. The default kill mode and
 * `KillSignal=SIGTERM` give a worker the time to finish the job it is on:
 * systemd waits `TimeoutStopSec` before it kills. Every deploy that reaches
 * the apply restarts the instances in one call (`--no-block`, so a long job
 * does not hold the deploy), so a worker always runs the new release without
 * the owner restarting anything by hand.
 *
 * The template file names its environment, site and instance count in
 * `X-TurboPanel-*` lines, so the stop, lifecycle and patch-restart paths can
 * find a site's workers from the unit files alone.
 */

import { join } from "node:path";
import { safeConfigToken } from "../../contracts/config-values.ts";
import type { EnvironmentDeploySiteWorker } from "../../contracts/commands-contracts.ts";
import { hostSudoArgs } from "../../permissions/host-sudo.ts";
import { quoteExecArg } from "../cron/unit.ts";
import type { RunFn } from "../ensure-principal.ts";
import { SYSTEMD_UNIT_DIR } from "../native/unit.ts";
import {
  installedUnitNames,
  installUnit,
  systemctl,
} from "../systemd-unit-set.ts";
import { forEachSequential } from "../../util/sequential.ts";
import {
  JOURNAL_PREFIX_RE,
  readUnitJournal,
  siteLifecycleHeadLines,
  siteLifecycleTailLines,
  type SiteLifecycleUnitBase,
} from "./lifecycle-unit.ts";

export const WORKER_UNIT_PREFIX = "turbopanel-worker-";

/** The most instances a worker can have; also how far the disable sweep reaches. */
export const MAX_WORKER_INSTANCES = 8;
export const DEFAULT_WORKER_STOP_TIMEOUT_SECONDS = 90;

/** Seconds between state checks after a restart, and how many checks. */
export const WORKER_POLL_INTERVAL_MS = 2000;
export const WORKER_POLL_ATTEMPTS = 15;
const WORKER_JOURNAL_TAIL_LINES = 30;

/** `turbopanel-worker-<env>-<service>-<name>` — no `@`, no extension. */
export function workerUnitBase(
  environmentId: string,
  composeServiceName: string,
  workerName: string,
): string {
  return `${WORKER_UNIT_PREFIX}${environmentId}-${
    safeConfigToken("worker composeServiceName", composeServiceName)
  }-${workerName}`;
}

/** The template file name: `<base>@.service`. */
export function workerTemplateFile(base: string): string {
  return `${base}@.service`;
}

/** Instance unit names `<base>@1.service` … `@<count>.service`, from `first`. */
export function workerInstanceUnits(
  base: string,
  count: number,
  first = 1,
): string[] {
  const units: string[] = [];
  for (let k = first; k <= count; k++) units.push(`${base}@${k}.service`);
  return units;
}

export type WorkerUnitOpts = SiteLifecycleUnitBase & {
  environmentId: string;
  composeServiceName: string;
  worker: EnvironmentDeploySiteWorker;
};

export function workerUnitContent(opts: WorkerUnitOpts): string {
  const { worker } = opts;
  const base = workerUnitBase(
    opts.environmentId,
    opts.composeServiceName,
    worker.name,
  );
  const service = safeConfigToken(
    "worker composeServiceName",
    opts.composeServiceName,
  );
  return [
    "# Managed by TurboPanel — regenerated on deploy; edits are overwritten.",
    "[Unit]",
    `Description=TurboPanel worker ${worker.name} (${service}) %i`,
    `X-TurboPanel-Environment=${opts.environmentId}`,
    `X-TurboPanel-Service=${service}`,
    `X-TurboPanel-Instances=${worker.processes ?? 1}`,
    "StartLimitBurst=10",
    "StartLimitIntervalSec=120",
    "",
    "[Service]",
    "Type=simple",
    ...siteLifecycleHeadLines(opts),
    `ExecStart=${worker.command.map(quoteExecArg).join(" ")}`,
    "Restart=always",
    "RestartSec=5",
    `TimeoutStopSec=${
      worker.stopTimeoutSeconds ?? DEFAULT_WORKER_STOP_TIMEOUT_SECONDS
    }`,
    ...(worker.memoryMaxBytes === undefined
      ? []
      : [`MemoryMax=${worker.memoryMaxBytes}`]),
    ...siteLifecycleTailLines(opts, base),
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

/** One site's workers, with where and as whom they run. */
export type WorkerApplySpec = SiteLifecycleUnitBase & {
  composeServiceName: string;
  workers: readonly EnvironmentDeploySiteWorker[];
};

export type WorkerIo = {
  run: RunFn;
  onLine: (stream: "stdout" | "stderr", line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  systemdUnitDir?: string;
  /** Leave journal tails out of the output (a path whose lines are not redacted). */
  omitJournal?: boolean;
};

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Refuse two workers that would share one unit name: `web` with `a-b` and
 * `web-a` with `b` both map to `<env>-web-a-b`, and one would overwrite the
 * other's unit.
 */
export function assertDistinctWorkerBases(
  environmentId: string,
  specs: ReadonlyArray<
    {
      composeServiceName: string;
      workers?: readonly EnvironmentDeploySiteWorker[];
    }
  >,
): void {
  const owners = new Map<string, string>();
  for (const spec of specs) {
    for (const worker of spec.workers ?? []) {
      const base = workerUnitBase(
        environmentId,
        spec.composeServiceName,
        worker.name,
      );
      const label = `${spec.composeServiceName}/${worker.name}`;
      const other = owners.get(base);
      if (other !== undefined) {
        throw new Error(
          `Workers ${other} and ${label} would share the unit name ${base}; rename one of them.`,
        );
      }
      owners.set(base, label);
    }
  }
}

/** Bases of this environment's installed worker templates. */
async function installedWorkerBases(
  io: WorkerIo,
  environmentId: string,
): Promise<string[]> {
  return await installedUnitNames(
    io.run,
    io.systemdUnitDir ?? SYSTEMD_UNIT_DIR,
    `${WORKER_UNIT_PREFIX}${environmentId}-`,
    "@.service",
  );
}

function syncLoopback(io: WorkerIo): Promise<unknown> {
  return io.run("sudo", hostSudoArgs(["-n", "php-loopback-sync"]));
}

/**
 * Stop, disable and remove the named worker templates (every instance a
 * template can have), then reload and rebuild the loopback rules. Never throws
 * for a unit that was never there.
 */
async function retireWorkerTemplates(
  io: WorkerIo,
  bases: readonly string[],
): Promise<void> {
  if (bases.length === 0) return;
  const unitDir = io.systemdUnitDir ?? SYSTEMD_UNIT_DIR;
  await forEachSequential(bases, async (base) => {
    await systemctl(io.run, [
      "disable",
      "--now",
      "--no-block",
      ...workerInstanceUnits(base, MAX_WORKER_INSTANCES),
    ]);
    await io.run(
      "sudo",
      hostSudoArgs([
        "-n",
        "rm",
        "-f",
        "--",
        join(unitDir, workerTemplateFile(base)),
      ]),
    );
  });
  await systemctl(io.run, ["daemon-reload"]);
  await syncLoopback(io);
}

/** Remove every worker of an environment (stop). Returns how many templates went. */
export async function removeEnvironmentWorkers(
  io: WorkerIo,
  environmentId: string,
): Promise<number> {
  const bases = await installedWorkerBases(io, environmentId);
  await retireWorkerTemplates(io, bases);
  return bases.length;
}

/** The workers of an environment's sites that are still installed, by site. */
export type InstalledWorker = {
  base: string;
  composeServiceName: string;
  instances: number;
};

/** Parse the `X-TurboPanel-*` lines of a template file. */
export function parseWorkerTemplate(
  base: string,
  text: string,
  environmentId: string,
): InstalledWorker | undefined {
  const field = (name: string): string | undefined =>
    new RegExp(`^X-TurboPanel-${name}=(.+)$`, "m").exec(text)?.[1]
      ?.trim();
  if (field("Environment") !== environmentId) return undefined;
  const service = field("Service");
  const instances = Number(field("Instances"));
  if (
    service === undefined || !Number.isInteger(instances) || instances < 1 ||
    instances > MAX_WORKER_INSTANCES
  ) return undefined;
  return { base, composeServiceName: service, instances };
}

/** An environment's installed workers (from their unit files), optionally one site's. */
export async function listInstalledWorkers(
  io: WorkerIo,
  environmentId: string,
  composeServiceName?: string,
): Promise<InstalledWorker[]> {
  const unitDir = io.systemdUnitDir ?? SYSTEMD_UNIT_DIR;
  const found: InstalledWorker[] = [];
  await forEachSequential(
    await installedWorkerBases(io, environmentId),
    async (base) => {
      try {
        const text = await Deno.readTextFile(
          join(unitDir, workerTemplateFile(base)),
        );
        const worker = parseWorkerTemplate(base, text, environmentId);
        if (
          worker !== undefined &&
          (composeServiceName === undefined ||
            worker.composeServiceName === composeServiceName)
        ) found.push(worker);
      } catch {
        // A template that cannot be read is left alone.
      }
    },
  );
  return found;
}

/** `systemctl is-active` for one unit: its state word, whatever the exit code. */
async function activeState(io: WorkerIo, unit: string): Promise<string> {
  const result = await systemctl(io.run, ["is-active", unit]);
  return result.stdout.trim().split("\n")[0] ?? "unknown";
}

type WatchedInstance = { unit: string; label: string };

/** Check the instances until all are active or the attempts run out; returns the rest and their last states. */
async function pollInstances(
  io: WorkerIo,
  instances: readonly WatchedInstance[],
  states: Map<string, string> = new Map(),
  attempt = 1,
): Promise<{ pending: WatchedInstance[]; states: Map<string, string> }> {
  const next: WatchedInstance[] = [];
  await forEachSequential(instances, async (entry) => {
    const state = await activeState(io, entry.unit);
    states.set(entry.unit, state);
    if (state !== "active") next.push(entry);
  });
  if (next.length === 0 || attempt >= WORKER_POLL_ATTEMPTS) {
    return { pending: next, states };
  }
  await (io.sleep ?? defaultSleep)(WORKER_POLL_INTERVAL_MS);
  return await pollInstances(io, next, states, attempt + 1);
}

/** Print an instance's journal tail to the transcript. */
async function printJournalTail(
  io: WorkerIo,
  entry: WatchedInstance,
): Promise<void> {
  if (io.omitJournal === true) {
    io.onLine(
      "stderr",
      `${entry.label} did not stay running; read its journal on the host`,
    );
    return;
  }
  const journal = await readUnitJournal(
    io.run,
    entry.unit,
    WORKER_JOURNAL_TAIL_LINES,
  );
  io.onLine("stderr", `--- ${entry.label} journal ---`);
  for (const line of journal.split("\n")) {
    if (line.trim().length > 0) {
      io.onLine("stderr", line.replace(JOURNAL_PREFIX_RE, ""));
    }
  }
}

/**
 * Watch restarted instances for a while. Returns a warning for each worker
 * that did not stay running; a worker finishing its job is only a transcript
 * line. The deploy never fails on a worker.
 */
export async function watchWorkerInstances(
  io: WorkerIo,
  instances: ReadonlyArray<WatchedInstance>,
): Promise<string[]> {
  const { pending, states } = await pollInstances(io, instances);
  const warnings: string[] = [];
  await forEachSequential(pending, async (entry) => {
    const state = states.get(entry.unit);
    if (state === "activating" || state === "deactivating") {
      io.onLine(
        "stdout",
        `worker ${entry.label} is finishing its current job; it starts on the new release when done`,
      );
      return;
    }
    await printJournalTail(io, entry);
    warnings.push(entry.label);
  });
  return warnings;
}

/**
 * Bring every worker of one environment in line with this deploy and restart
 * them on the new release. `specs` is the complete set: a worker no longer
 * named is stopped and removed. Returns the warnings for the deploy result.
 */
export async function applySiteWorkers(
  io: WorkerIo,
  environmentId: string,
  specs: readonly WorkerApplySpec[],
): Promise<string[]> {
  const unitDir = io.systemdUnitDir ?? SYSTEMD_UNIT_DIR;
  const desired: Array<
    {
      base: string;
      spec: WorkerApplySpec;
      worker: EnvironmentDeploySiteWorker;
      processes: number;
    }
  > = [];
  for (const spec of specs) {
    for (const worker of spec.workers) {
      desired.push({
        base: workerUnitBase(
          environmentId,
          spec.composeServiceName,
          worker.name,
        ),
        spec,
        worker,
        processes: worker.processes ?? 1,
      });
    }
  }
  assertDistinctWorkerBases(environmentId, specs);
  let changed = false;
  await forEachSequential(desired, async (entry) => {
    const moved = await installUnit(
      io.run,
      join(unitDir, workerTemplateFile(entry.base)),
      workerUnitContent({
        ...entry.spec,
        environmentId,
        worker: entry.worker,
      }),
      "tp-worker-",
    );
    if (moved) changed = true;
  });
  const wanted = new Set(desired.map((entry) => entry.base));
  const stale = (await installedWorkerBases(io, environmentId)).filter((base) =>
    !wanted.has(base)
  );
  await retireWorkerTemplates(io, stale);
  if (desired.length === 0) return [];
  if (changed) {
    const reload = await systemctl(io.run, ["daemon-reload"]);
    if (!reload.success) {
      throw new Error(reload.stderr || "systemctl daemon-reload failed");
    }
    await syncLoopback(io);
  }
  const watched: Array<{ unit: string; label: string }> = [];
  await forEachSequential(desired, async (entry) => {
    const running = workerInstanceUnits(entry.base, entry.processes);
    const enable = await systemctl(io.run, ["enable", ...running]);
    if (!enable.success) {
      throw new Error(
        enable.stderr || `Failed to enable worker ${entry.worker.name}`,
      );
    }
    if (entry.processes < MAX_WORKER_INSTANCES) {
      await systemctl(io.run, [
        "disable",
        "--now",
        "--no-block",
        ...workerInstanceUnits(
          entry.base,
          MAX_WORKER_INSTANCES,
          entry.processes + 1,
        ),
      ]);
    }
    // One call: systemd stops them in parallel with SIGTERM, waits up to
    // `TimeoutStopSec`, and starts them on the new `current`.
    const restart = await systemctl(io.run, [
      "restart",
      "--no-block",
      ...running,
    ]);
    if (!restart.success) {
      throw new Error(
        restart.stderr || `Failed to restart worker ${entry.worker.name}`,
      );
    }
    for (const unit of running) {
      watched.push({
        unit,
        label: `${entry.spec.composeServiceName}/${entry.worker.name}`,
      });
    }
  });
  const failed = await watchWorkerInstances(io, watched);
  return [...new Set(failed)].map((label) => {
    const [service, name] = label.split("/");
    return `Site ${service}: worker ${name} did not stay running.`;
  });
}

/** Restart a site's installed workers (after a PHP patch update), gracefully. */
export async function restartInstalledWorkers(
  io: WorkerIo,
  workers: readonly InstalledWorker[],
): Promise<string[]> {
  const watched: Array<{ unit: string; label: string }> = [];
  await forEachSequential(workers, async (worker) => {
    const units = workerInstanceUnits(worker.base, worker.instances);
    await systemctl(io.run, ["restart", "--no-block", ...units]);
    for (const unit of units) {
      watched.push({
        unit,
        label: `${worker.composeServiceName}/${worker.base}`,
      });
    }
  });
  const failed = await watchWorkerInstances(io, watched);
  return [...new Set(failed)];
}

/**
 * Start, stop or restart every installed worker of an environment (the
 * environment's lifecycle action). One call per template, `--no-block`, so a
 * worker finishing its job does not hold the command. Returns the units asked.
 */
export async function workerLifecycle(
  io: WorkerIo,
  environmentId: string,
  action: "start" | "stop" | "restart",
): Promise<string[]> {
  const asked: string[] = [];
  await forEachSequential(
    await listInstalledWorkers(io, environmentId),
    async (worker) => {
      const units = workerInstanceUnits(worker.base, worker.instances);
      await systemctl(io.run, [action, "--no-block", ...units]);
      asked.push(...units);
    },
  );
  return asked;
}
