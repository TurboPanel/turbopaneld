/**
 * Decide whether the daemon should attach {@link DockerMonitor} at startup.
 *
 * Opted-in co-located dev can enable docker integration before Docker Engine
 * exists (converge installs it). Attaching the monitor then floods the log with
 * "waiting for Docker" while nothing is installing — the failure mode that left
 * the TUI looking stuck after a partial converge. Skip the monitor until the
 * docker binary is on disk; once converge installs Docker and restarts the
 * daemon, the monitor attaches normally.
 */
export type DockerMonitorAttachDecision =
  | { attach: true; warnSocketDown: boolean }
  | { attach: false; reason: "docker-not-installed" };

export function decideDockerMonitorAttach(opts: {
  socketReachable: boolean;
  dockerBinaryPresent: boolean;
}): DockerMonitorAttachDecision {
  if (opts.socketReachable) {
    return { attach: true, warnSocketDown: false };
  }
  if (opts.dockerBinaryPresent) {
    // Binary exists (Engine starting / group membership lag) — keep retrying.
    return { attach: true, warnSocketDown: true };
  }
  return { attach: false, reason: "docker-not-installed" };
}

/** True when the Docker Engine client binary is present on the host. */
export async function dockerBinaryPresent(
  path = "/usr/bin/docker",
): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return false;
    }
    throw err;
  }
}
