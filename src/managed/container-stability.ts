/**
 * Post-`compose up` crash-loop detection for daemon-owned managed stacks.
 *
 * `docker compose up -d` succeeds as soon as the container is created, even
 * when its process dies on start (`restart: unless-stopped` then loops it
 * forever). Without this check a stack whose config is unreadable reports
 * success and the cluster status stays a generic "failed" with no reason.
 * Here the container is inspected shortly after start; a restarting or
 * non-zero-exited container fails the reconcile with its own last log lines,
 * which is what the operator needs to see.
 */
import type {
  DockerCliResult,
  RunDockerOptions,
} from "../deploy/docker-cli.ts";
import { sanitizeForLog } from "../util/logger.ts";

type RunDockerFn = (
  args: string[],
  options?: RunDockerOptions,
) => Promise<DockerCliResult>;

export type ContainerStabilityOptions = {
  /** Checks after start; the container must not be crash-looping at any. */
  attempts?: number;
  /** Delay between checks, ms. */
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_INTERVAL_MS = 2_000;
const LOG_TAIL_LINES = 5;
const MAX_REASON_CHARS = 400;

type ContainerState = {
  status: string;
  exitCode: number;
  restartCount: number;
};

/** Parse `docker inspect -f '{{json .State}} {{.RestartCount}}'` output. */
export function parseContainerState(stdout: string): ContainerState | null {
  const trimmed = stdout.trim();
  const split = trimmed.lastIndexOf(" ");
  if (split <= 0) return null;
  try {
    const state = JSON.parse(trimmed.slice(0, split)) as Record<
      string,
      unknown
    >;
    const restartCount = Number(trimmed.slice(split + 1));
    if (typeof state.Status !== "string") return null;
    return {
      status: state.Status,
      exitCode: typeof state.ExitCode === "number" ? state.ExitCode : 0,
      restartCount: Number.isFinite(restartCount) ? restartCount : 0,
    };
  } catch {
    return null;
  }
}

/** A container is crash-looping when Docker is restarting it or it exited non-zero. */
export function isCrashLooping(state: ContainerState): boolean {
  if (state.status === "restarting") return true;
  if (state.status === "exited" || state.status === "dead") {
    return state.exitCode !== 0;
  }
  return false;
}

/** Last non-empty log line(s) of a container, trimmed for an error message. */
export function lastLogReason(logs: string): string {
  const lines = logs.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const last = lines.at(-1) ?? "";
  return sanitizeForLog(last).slice(0, MAX_REASON_CHARS);
}

/**
 * Throws when `containerName` is crash-looping after start, naming the
 * container's last log line. Returns quietly when the container runs, or when
 * its state cannot be read (a missing engine is reported by other paths).
 */
export async function assertContainerStable(
  run: RunDockerFn,
  containerName: string,
  label: string,
  options: ContainerStabilityOptions = {},
): Promise<void> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const sleep = options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (let i = 0; i < attempts; i += 1) {
    // The first check is immediate (it also settles an engine that cannot be
    // inspected at all); later ones wait for a fresh container to crash.
    if (i > 0) await sleep(intervalMs);
    const inspect = await run([
      "inspect",
      "-f",
      "{{json .State}} {{.RestartCount}}",
      containerName,
    ]);
    if (!inspect.success) return;
    const state = parseContainerState(inspect.stdout);
    if (state === null) return;
    if (!isCrashLooping(state)) continue;

    const logs = await run([
      "logs",
      "--tail",
      String(LOG_TAIL_LINES),
      containerName,
    ]);
    const reason = lastLogReason(`${logs.stdout}\n${logs.stderr}`);
    throw new Error(
      `${label} container ${containerName} is crash-looping (${state.status}, ` +
        `exit ${state.exitCode}, ${state.restartCount} restarts)` +
        (reason ? `: ${reason}` : ""),
    );
  }
}
