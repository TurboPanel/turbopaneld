/**
 * The data step of a Destroy that also deletes data: remove the registered
 * Docker volumes the control plane named, after the stack is down.
 *
 * Each volume is named by its storage id, which is the exact Docker volume
 * name the control plane registered; the payload parser accepts nothing else,
 * so a managed database volume or a system volume can never be named here. A
 * volume that any container (running or stopped) still uses is kept: after
 * `compose down` that container belongs to something else, such as another
 * environment. Removal is `docker volume rm` without `-f`, so Docker refuses a
 * volume in use as well.
 *
 * Never throws: the stack is already down, and the stop must still report its
 * empty container list. Every volume is reported back (`removed`, `absent`,
 * `kept`, `failed`) and written to the command transcript.
 */

import type {
  EnvironmentStopVolumeState,
  StopVolumeRemoval,
} from "../contracts/commands-contracts.ts";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import type { CommandOutputSink } from "../logs/contracts.ts";
import { logInfo, logWarn } from "../util/logger.ts";
import { forEachSequential } from "../util/sequential.ts";

type RunDockerFn = (args: string[]) => Promise<DockerCliResult>;

const MAX_REASON_LENGTH = 300;

function clip(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.slice(0, MAX_REASON_LENGTH);
}

function isNoSuchVolume(stderr: string): boolean {
  return stderr.toLowerCase().includes("no such volume");
}

/** The containers (any state) that mount `volumeName`, by name; null when Docker could not say. */
async function containersUsing(
  run: RunDockerFn,
  volumeName: string,
): Promise<string[] | null> {
  const listed = await run([
    "ps",
    "-a",
    "--filter",
    `volume=${volumeName}`,
    "--format",
    "{{.Names}}",
  ]);
  if (!listed.success) return null;
  return listed.stdout.split("\n").map((line) => line.trim()).filter((line) =>
    line.length > 0
  );
}

async function removeOneVolume(
  run: RunDockerFn,
  storageId: string,
  redact: (text: string) => string,
): Promise<EnvironmentStopVolumeState> {
  const inspect = await run([
    "volume",
    "inspect",
    "--format",
    "{{.Name}}",
    storageId,
  ]);
  if (!inspect.success) {
    if (isNoSuchVolume(inspect.stderr)) return { storageId, state: "absent" };
    return {
      storageId,
      state: "failed",
      reason: clip(redact(inspect.stderr)) ||
        "Docker could not read the volume",
    };
  }
  const users = await containersUsing(run, storageId);
  if (users === null) {
    return {
      storageId,
      state: "kept",
      reason: "Docker could not list the containers that use it",
    };
  }
  if (users.length > 0) {
    return {
      storageId,
      state: "kept",
      reason: `still used by ${users.slice(0, 5).join(", ")}`,
    };
  }
  const removed = await run(["volume", "rm", storageId]);
  if (removed.success) return { storageId, state: "removed" };
  if (isNoSuchVolume(removed.stderr)) return { storageId, state: "absent" };
  return {
    storageId,
    state: "failed",
    reason: clip(redact(removed.stderr)) || "Docker refused to remove it",
  };
}

function describe(state: EnvironmentStopVolumeState): string {
  switch (state.state) {
    case "removed":
      return `removed volume ${state.storageId}`;
    case "absent":
      return `volume ${state.storageId} was not on this server`;
    case "kept":
      return `kept volume ${state.storageId}: ${state.reason ?? ""}`;
    default:
      return `could not remove volume ${state.storageId}: ${
        state.reason ?? ""
      }`;
  }
}

/**
 * Remove each named volume and report what happened to it. `dockerPresent`
 * false keeps every volume (a host without Docker has none to remove).
 */
export async function removeStopVolumes(
  entries: readonly StopVolumeRemoval[],
  options: {
    environmentId: string;
    dockerPresent: boolean;
    run: RunDockerFn;
    logSink: CommandOutputSink;
  },
): Promise<EnvironmentStopVolumeState[]> {
  const states: EnvironmentStopVolumeState[] = [];
  const redact = (text: string) => options.logSink.redactSummary(text);
  await forEachSequential(entries, async ({ storageId }) => {
    let state: EnvironmentStopVolumeState;
    if (options.dockerPresent) {
      try {
        state = await removeOneVolume(options.run, storageId, redact);
      } catch (err) {
        state = {
          storageId,
          state: "failed",
          reason:
            clip(redact(err instanceof Error ? err.message : String(err))) ||
            "Docker could not be run",
        };
      }
    } else {
      state = {
        storageId,
        state: "kept",
        reason: "Docker is not installed on this server",
      };
    }
    states.push(state);
    const line = describe(state);
    const failed = state.state === "failed" || state.state === "kept";
    options.logSink.onLine(failed ? "stderr" : "stdout", line);
    (failed ? logWarn : logInfo)(
      "commands",
      `environment.stop ${line} env=${options.environmentId}`,
    );
  });
  return states;
}

/** A short clause for the stop summary, or null when no volume was named. */
export function volumeSummary(
  states: readonly EnvironmentStopVolumeState[],
): string | null {
  if (states.length === 0) return null;
  const count = (state: EnvironmentStopVolumeState["state"]) =>
    states.filter((entry) => entry.state === state).length;
  const parts = [`data volumes removed: ${count("removed")}`];
  const absent = count("absent");
  if (absent > 0) parts.push(`not on this server: ${absent}`);
  const kept = count("kept");
  const failed = count("failed");
  if (kept > 0) parts.push(`kept: ${kept}`);
  if (failed > 0) parts.push(`failed: ${failed}`);
  return parts.join(", ");
}
