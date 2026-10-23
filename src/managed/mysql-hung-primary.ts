/**
 * Timed liveness probe for a local MySQL or MariaDB PRIMARY that is hung:
 * the container still runs (or is frozen) and the port may even accept a
 * connection, but the server never answers.
 *
 * Orchestrator cannot call this one dead. A frozen primary leaves the
 * replicas "connected" until their own network timeout, and Orchestrator then
 * reports the primary as unreachable with replicas that still see it, which
 * {@link isDeadPrimaryProblem} deliberately does not trust. Without this probe
 * a hung primary is never reported and the database stays down until someone
 * notices.
 *
 * What counts, per poll (the observer polls every 15 s):
 *
 * - `docker inspect` says the container is `paused`, or it runs and a bounded
 *   `mysqladmin ping` / `mariadb-admin ping` (3 s connect timeout, 8 s hard
 *   cap) times out or loses the connection: a HUNG sample;
 * - the server answers, even with "access denied" (exit 0 or error 1045): alive;
 * - anything else is INCONCLUSIVE and resets the run: a stopped or missing
 *   container and a refused connection (the engine is dead, not hung, and
 *   Orchestrator reports that on its own), an unreadable Docker, a ping the
 *   tooling could not run.
 *
 * {@link HungPrimaryTracker} fires after {@link HUNG_PRIMARY_MIN_SAMPLES}
 * consecutive HUNG samples spanning at least {@link HUNG_PRIMARY_MIN_SPAN_MS}
 * (so 30-45 s after the primary stopped answering), and forgets a run broken
 * by a gap of more than {@link HUNG_PRIMARY_MAX_GAP_MS} between samples
 * (suspend, stalled event loop). It reports when the run began: the control
 * plane anchors its caught-up proof for the replicas on that moment.
 *
 * Read-only: no SQL, no credentials (a login-less ping).
 */

import type { RunDockerFn } from "../deploy/docker-cli.ts";
import type { ManagedHaMemberRecord } from "./ha-member.ts";
import { MYSQL_FAMILY_NATIVE_PORT } from "./engines/standby-probe.ts";
import { replicaPrimaryPingArgv } from "./engines/replica-io-restart.ts";

export const HUNG_PRIMARY_MIN_SAMPLES = 3;
export const HUNG_PRIMARY_MIN_SPAN_MS = 30_000;
/** A longer pause between two samples is not one run (suspend, stall). */
export const HUNG_PRIMARY_MAX_GAP_MS = 45_000;
const INSPECT_TIMEOUT_MS = 5_000;
const PING_TIMEOUT_MS = 8_000;

export type HungSample =
  | { kind: "alive" }
  | { kind: "inconclusive"; reason: string }
  | { kind: "hung"; reason: string };

type DockerText = { success: boolean; stdout: string; stderr: string };

const TIMED_OUT = Symbol("timed out");

async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** A ping that did not succeed: did the server hang, or is it just not there? */
export function classifyPingFailure(result: DockerText): HungSample {
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
  // Alive: it answered, only the login was refused.
  if (text.includes("1045") || text.includes("access denied")) {
    return { kind: "alive" };
  }
  if (
    text.includes("is not running") || text.includes("no such container") ||
    text.includes("no such file") || text.includes("executable file not found")
  ) {
    return { kind: "inconclusive", reason: "container or ping tool missing" };
  }
  // Nothing is listening: dead, not hung. Orchestrator's side of the house.
  if (
    text.includes("connection refused") || text.includes("(111)") ||
    text.includes("(2002)")
  ) {
    return { kind: "inconclusive", reason: "connection refused" };
  }
  if (
    text.includes("timed out") || text.includes("(110)") ||
    text.includes("lost connection") || text.includes("(2013)") ||
    text.includes("is paused")
  ) {
    return { kind: "hung", reason: "ping lost the connection or timed out" };
  }
  return { kind: "inconclusive", reason: "ping failed in an unknown way" };
}

/** One bounded look at a local primary. Never throws. */
export async function sampleMysqlFamilyPrimary(
  record: ManagedHaMemberRecord,
  run: RunDockerFn,
  timeouts: { inspectMs?: number; pingMs?: number } = {},
): Promise<HungSample> {
  try {
    const status = await withTimeout(
      run(["inspect", "--format", "{{.State.Status}}", record.containerName]),
      timeouts.inspectMs ?? INSPECT_TIMEOUT_MS,
    );
    if (status === TIMED_OUT || !status.success) {
      return { kind: "inconclusive", reason: "docker did not answer" };
    }
    const state = status.stdout.trim();
    if (state === "paused") return { kind: "hung", reason: "container paused" };
    if (state !== "running") {
      return { kind: "inconclusive", reason: `container is ${state}` };
    }
    const bin = record.engine === "mariadb" ? "mariadb-admin" : "mysqladmin";
    const ping = await withTimeout(
      run([
        "exec",
        record.containerName,
        ...replicaPrimaryPingArgv(
          bin,
          "127.0.0.1",
          MYSQL_FAMILY_NATIVE_PORT,
          "root",
        ),
      ]),
      timeouts.pingMs ?? PING_TIMEOUT_MS,
    );
    if (ping === TIMED_OUT) {
      return { kind: "hung", reason: "ping did not return in time" };
    }
    return ping.success ? { kind: "alive" } : classifyPingFailure(ping);
  } catch {
    return { kind: "inconclusive", reason: "probe could not run" };
  }
}

export type HungVerdict =
  | { hung: false }
  | { hung: true; sinceMs: number; samples: number; reason: string };

type Run = { sinceMs: number; lastMs: number; samples: number };

/** Turns a stream of samples into "this primary has been hung long enough". */
export class HungPrimaryTracker {
  readonly #runs = new Map<string, Run>();

  step(managedId: string, sample: HungSample, nowMs: number): HungVerdict {
    if (sample.kind !== "hung") {
      this.#runs.delete(managedId);
      return { hung: false };
    }
    const previous = this.#runs.get(managedId);
    const run: Run =
      previous && nowMs - previous.lastMs <= HUNG_PRIMARY_MAX_GAP_MS
        ? { ...previous, lastMs: nowMs, samples: previous.samples + 1 }
        : { sinceMs: nowMs, lastMs: nowMs, samples: 1 };
    this.#runs.set(managedId, run);
    if (
      run.samples < HUNG_PRIMARY_MIN_SAMPLES ||
      nowMs - run.sinceMs < HUNG_PRIMARY_MIN_SPAN_MS
    ) {
      return { hung: false };
    }
    return {
      hung: true,
      sinceMs: run.sinceMs,
      samples: run.samples,
      reason: sample.reason,
    };
  }

  /** Forget a cluster (suppressed, no longer a watched primary). */
  forget(managedId: string): void {
    this.#runs.delete(managedId);
  }

  /** Forget every cluster not in `keep`. */
  retainOnly(keep: ReadonlySet<string>): void {
    for (const id of this.#runs.keys()) {
      if (!keep.has(id)) this.#runs.delete(id);
    }
  }
}
