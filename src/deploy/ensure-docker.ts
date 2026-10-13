import { logInfo } from "../util/logger.ts";
import { runDockerSetup as defaultRunDockerSetup } from "../orchestration/ansible.ts";
import type { AnsibleEventHandler } from "../orchestration/ansible-events.ts";
import { dockerEngineProbe } from "./docker-cli.ts";
import { diagnoseDockerUnreachable } from "./docker-diagnosis.ts";

const DOCKER_BIN = "/usr/bin/docker";

/** Optional test seams for {@link ensureDocker}. */
export type EnsureDockerDeps = {
  dockerBinaryPresent?: () => Promise<boolean>;
  dockerEngineReachable?: () => Promise<boolean>;
  runDockerSetup?: () => Promise<void>;
  /** Explains why the Engine API is unreachable after setup. */
  diagnose?: () => Promise<string>;
  /** Host-free seam for the default binary probe (`Deno.stat`). */
  stat?: (path: string) => Promise<Deno.FileInfo>;
  /**
   * Structured playbook events from the default docker-setup (task starts,
   * failures) for the deploy transcript. Ignored by a custom `runDockerSetup`.
   */
  onEvent?: AnsibleEventHandler;
};

async function dockerBinaryPresentDefault(
  statFn: (path: string) => Promise<Deno.FileInfo>,
): Promise<boolean> {
  try {
    const stat = await statFn(DOCKER_BIN);
    return stat.isFile;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

type DockerProbes = {
  present: () => Promise<boolean>;
  reachable: () => Promise<boolean>;
  /** Stderr of the last engine probe, for the diagnosis. */
  lastProbeStderr: () => string;
};

function resolveDockerProbes(deps?: EnsureDockerDeps): DockerProbes {
  let lastProbeStderr = "";
  return {
    present: deps?.dockerBinaryPresent ??
      (() => dockerBinaryPresentDefault(deps?.stat ?? Deno.stat)),
    reachable: deps?.dockerEngineReachable ?? (async () => {
      const probe = await dockerEngineProbe();
      lastProbeStderr = probe.stderr;
      return probe.success;
    }),
    lastProbeStderr: () => lastProbeStderr,
  };
}

/**
 * True when the Docker binary is installed and the Engine API answers. The
 * presence half of {@link ensureDocker}: it never runs docker-setup, so the
 * deploy preflight can plan the install step without starting it.
 */
export async function dockerReady(deps?: EnsureDockerDeps): Promise<boolean> {
  const probes = resolveDockerProbes(deps);
  return await probes.present() && await probes.reachable();
}

async function ensureDockerOnce(deps?: EnsureDockerDeps): Promise<void> {
  const probes = resolveDockerProbes(deps);
  const setupFn = deps?.runDockerSetup ??
    (() => defaultRunDockerSetup(undefined, deps?.onEvent));
  const diagnoseFn = deps?.diagnose ??
    (() => diagnoseDockerUnreachable(probes.lastProbeStderr()));

  const present = await probes.present();
  const reachable = present ? await probes.reachable() : false;

  if (present && reachable) return;

  logInfo(
    "deploy",
    present
      ? "Docker binary present but Engine API unreachable — running docker-setup"
      : "Docker binary missing — running docker-setup",
  );
  await setupFn();

  if (!(await probes.reachable())) {
    throw new Error(await diagnoseFn());
  }
}

let inflight: Promise<void> | undefined;

/**
 * Ensure Docker Engine is installed and the daemon can reach the API.
 *
 * Runs docker-setup when the binary is missing OR the socket is unreachable.
 * Group membership changes use `sudo -n -u <self>` for the rest of this
 * process — see docker-cli.ts (`sg` fails for `/usr/sbin/nologin` service
 * accounts).
 *
 * **One run at a time.** A managed database replica sends `managed.apply` and
 * `managed.ha.reconcile` together, and both call this; two concurrent
 * docker-setup playbooks each install/start/restart dockerd and can trip
 * systemd's start limit (`start-limit-hit`), leaving Docker down. Concurrent
 * callers therefore share the in-flight run and its outcome.
 *
 * When the API is still unreachable afterwards the error names the actual
 * cause (service down, not in the group, stale process groups) — see
 * docker-diagnosis.ts.
 */
export function ensureDocker(deps?: EnsureDockerDeps): Promise<void> {
  if (inflight !== undefined) return inflight;
  const run = ensureDockerOnce(deps).finally(() => {
    inflight = undefined;
  });
  inflight = run;
  return run;
}
