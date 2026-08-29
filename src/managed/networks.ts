/**
 * Managed-engine Docker network helper shared by engine compose and ProxySQL.
 *
 * The network name is per-organization (`network(kind='managed')` in the
 * control plane) and always arrives on the command payload — there is no
 * daemon-side default.
 */

import {
  type DockerCliResult,
  runDocker as defaultRunDocker,
  type RunDockerOptions,
} from "../deploy/docker-cli.ts";
import { logInfo } from "../logger.ts";

/**
 * Hyphen-permitting Docker resource name. Must stay in sync with the
 * instance's `DOCKER_RESOURCE_NAME_RE` (contracts.ts) and
 * `SAFE_CONTAINER_NAME_RE` (managed/paths.ts) — duplicated rather than shared
 * to keep this module free of a contracts import cycle.
 */
const DOCKER_RESOURCE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;

type RunDockerFn = (
  args: string[],
  options?: RunDockerOptions,
) => Promise<DockerCliResult>;

/**
 * Pre-UUID managed-engine bridge. Provisioning before the rename left this
 * name on the host; the control plane now stamps the `network` row UUID.
 * Never create it — only prune it after ProxySQL/engines join the current name.
 */
export const RETIRED_MANAGED_NETWORK_NAME = "turbopanel-managed";

/** Docker network names to remove once `currentName` is the live managed bridge. */
export function staleManagedDockerNetworkNames(
  currentName: string,
  previousName: string | null,
): string[] {
  const names = new Set<string>();
  if (previousName && previousName !== currentName) names.add(previousName);
  if (RETIRED_MANAGED_NETWORK_NAME !== currentName) {
    names.add(RETIRED_MANAGED_NETWORK_NAME);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * True when inspect listed networks and the current managed name is absent.
 * Empty `attached` is unknown (tests, inspect miss) — not a mismatch.
 */
export function containerMissesManagedNetwork(
  attached: readonly string[],
  currentName: string,
): boolean {
  if (attached.length === 0) return false;
  return !attached.includes(currentName);
}

/** Names from `docker inspect -f '{{range … Networks}}…'` stdout. */
export function parseInspectNetworkKeys(stdout: string): string[] {
  return stdout.split("\n").map((line) => line.trim()).filter((line) =>
    line.length > 0
  );
}

function containerNamesFromContainersMap(containers: unknown): string[] {
  if (typeof containers !== "object" || containers === null) return [];
  const names: string[] = [];
  for (const entry of Object.values(containers)) {
    if (typeof entry !== "object" || entry === null) continue;
    const name = (entry as { Name?: unknown }).Name;
    if (typeof name === "string" && name.length > 0) names.push(name);
  }
  return names;
}

/** Container names from `docker network inspect` JSON. */
export function containerNamesFromNetworkInspect(stdout: string): string[] {
  try {
    const parsed: unknown = JSON.parse(stdout);
    const objects = Array.isArray(parsed) ? parsed : [parsed];
    const names: string[] = [];
    for (const obj of objects) {
      if (typeof obj !== "object" || obj === null) continue;
      names.push(
        ...containerNamesFromContainersMap(
          (obj as { Containers?: unknown }).Containers,
        ),
      );
    }
    return names.sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export async function dockerContainerNetworkNames(
  containerName: string,
  run: RunDockerFn,
): Promise<string[]> {
  if (!DOCKER_RESOURCE_NAME_RE.test(containerName)) return [];
  const inspect = await run([
    "inspect",
    "-f",
    "{{range $k, $_ := .NetworkSettings.Networks}}{{println $k}}{{end}}",
    containerName,
  ]);
  if (!inspect.success) return [];
  return parseInspectNetworkKeys(inspect.stdout);
}

function networkConnectAlreadyJoined(stderr: string): boolean {
  const text = stderr.toLowerCase();
  return text.includes("already exists in network") ||
    text.includes("already connected");
}

/**
 * Attach a running container to the current managed-engine bridge.
 * Compose `--force-recreate` can throw or no-op while the frontend stays on
 * a leftover `turbopanel-managed` endpoint.
 */
export async function ensureContainerJoinedManagedNetwork(
  containerName: string,
  networkName: string,
  run: RunDockerFn,
): Promise<boolean> {
  if (
    !DOCKER_RESOURCE_NAME_RE.test(containerName) ||
    !DOCKER_RESOURCE_NAME_RE.test(networkName)
  ) {
    return false;
  }
  const attached = await dockerContainerNetworkNames(containerName, run);
  if (attached.includes(networkName)) return true;
  const connect = await run([
    "network",
    "connect",
    networkName,
    containerName,
  ]);
  if (connect.success || networkConnectAlreadyJoined(connect.stderr)) {
    return true;
  }
  logInfo(
    "managed",
    `docker network connect ${networkName} ${containerName}: ${
      connect.stderr || "connect failed"
    }`,
  );
  return false;
}

/**
 * Drop leftover managed-engine bridges (retired `turbopanel-managed` and a
 * previous compose name). After a migrate, disconnect stragglers then `rm`.
 * When `disconnect` is false, only remove unused (zero-container) networks.
 */
export async function pruneStaleManagedDockerNetworks(
  currentName: string,
  previousName: string | null,
  run: RunDockerFn,
  options?: { disconnect: boolean },
): Promise<void> {
  const stale = staleManagedDockerNetworkNames(currentName, previousName);
  for (const name of stale) {
    await pruneDockerNetworkBestEffort(name, run, options?.disconnect ?? false);
  }
}

async function pruneDockerNetworkBestEffort(
  name: string,
  run: RunDockerFn,
  disconnect: boolean,
): Promise<void> {
  if (!DOCKER_RESOURCE_NAME_RE.test(name)) return;
  const inspect = await run(["network", "inspect", name]);
  if (!inspect.success) return;
  const stdout = inspect.stdout.trim();
  if (stdout.length === 0) return;

  const containers = containerNamesFromNetworkInspect(stdout);
  if (containers.length > 0 && !disconnect) return;

  if (disconnect) {
    for (const container of containers) {
      await run(["network", "disconnect", "-f", name, container]);
    }
  }

  const rm = await run(["network", "rm", name]);
  if (!rm.success) {
    logInfo(
      "managed",
      `leaving docker network ${name}: ${rm.stderr || "rm failed"}`,
    );
  }
}

/** Idempotently create the organization's managed-engine Docker network. */
export async function ensureManagedIngressNetwork(
  name: string,
  run: RunDockerFn = defaultRunDocker,
): Promise<void> {
  if (!DOCKER_RESOURCE_NAME_RE.test(name)) {
    throw new Error("managed network name contains unsupported characters");
  }

  const inspect = await run(["network", "inspect", name]);
  if (inspect.success) return;

  const create = await run(["network", "create", name]);
  if (!create.success) {
    throw new Error(
      create.stderr ||
        `Creating managed ingress Docker network ${name} failed`,
    );
  }
}
