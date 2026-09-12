/**
 * Once-per-session sync of the org's Docker host addressing onto this host.
 *
 * Fetch → compare with the persisted descriptor → apply only on change →
 * persist. Everything here is best-effort: a fetch or apply failure is
 * logged by the caller and retried on the next daemon session, and a host
 * without Docker installed only persists the descriptor — the on-demand
 * install (`ensureDocker` → `runDockerSetup()`) picks it up from there.
 */

import { logInfo } from "../logger.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import {
  type DockerNetworkingDescriptor,
  dockerNetworkingDescriptorsEqual,
  isEmptyDockerNetworkingDescriptor,
  readDockerNetworkingState,
  writeDockerNetworkingState,
} from "./docker-networking-state.ts";

export type DockerNetworkingSyncOutcome =
  | "unchanged"
  | "persisted"
  | "applied";

export type DockerNetworkingApplyOptions = {
  /**
   * True when an empty descriptor replaces a non-empty persisted one: the
   * apply must still run so the previously written `default-address-pools`
   * / `bip` are stripped from `daemon.json` instead of lingering on the host.
   */
  clearAddressing: boolean;
};

export type DockerNetworkingSyncDeps = {
  layout: Pick<LayoutPaths, "configDir">;
  fetch: () => Promise<DockerNetworkingDescriptor>;
  apply: (
    descriptor: DockerNetworkingDescriptor,
    options: DockerNetworkingApplyOptions,
  ) => Promise<void>;
  /** Defaults to a stat of the Docker binary. */
  dockerBinaryPresent?: () => Promise<boolean>;
};

/** Same probe path as `ensure-docker.ts`. */
const DOCKER_BIN = "/usr/bin/docker";

function dockerAddressingApplyLogMessage(
  fetched: DockerNetworkingDescriptor,
  clearAddressing: boolean,
): string {
  if (clearAddressing) {
    return "docker host addressing cleared; removing default-address-pools/bip from daemon.json — dockerd restarts, existing containers keep their addresses";
  }
  const bip = fetched.defaultBridgeCidr
    ? `, bip ${fetched.defaultBridgeCidr}`
    : "";
  return `docker host addressing changed (${fetched.addressPools.length} pool(s)${bip}); applying to daemon.json — dockerd restarts, existing containers keep their addresses`;
}

async function dockerBinaryPresentDefault(): Promise<boolean> {
  try {
    return (await Deno.stat(DOCKER_BIN)).isFile;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

export async function syncHostDockerNetworking(
  deps: DockerNetworkingSyncDeps,
): Promise<DockerNetworkingSyncOutcome> {
  const fetched = await deps.fetch();
  const persisted = await readDockerNetworkingState(deps.layout);
  if (dockerNetworkingDescriptorsEqual(persisted, fetched)) return "unchanged";

  // Nothing configured and nothing ever applied: record that and stop —
  // running the docker role with empty vars is a strict no-op anyway.
  if (persisted === null && isEmptyDockerNetworkingDescriptor(fetched)) {
    await writeDockerNetworkingState(deps.layout, fetched);
    return "persisted";
  }

  const present =
    await (deps.dockerBinaryPresent ?? dockerBinaryPresentDefault)();
  if (!present) {
    // The on-demand install reads the descriptor, so persisting is enough.
    await writeDockerNetworkingState(deps.layout, fetched);
    logInfo(
      "deploy",
      "docker host addressing persisted; Docker is not installed yet, the on-demand install applies it",
    );
    return "persisted";
  }

  // Reaching here with an empty descriptor means a non-empty one was applied
  // before (equal descriptors returned `unchanged` above, and a null persisted
  // copy took the early return). The role skips `daemon.json` entirely on
  // empty vars, so the apply has to be told explicitly to strip the old keys.
  const clearAddressing = isEmptyDockerNetworkingDescriptor(fetched);
  logInfo("deploy", dockerAddressingApplyLogMessage(fetched, clearAddressing));
  await deps.apply(fetched, { clearAddressing });
  // Persist only after a successful apply (or removal) so a failed run
  // retries next session instead of recording state the host never reached.
  await writeDockerNetworkingState(deps.layout, fetched);
  return "applied";
}
