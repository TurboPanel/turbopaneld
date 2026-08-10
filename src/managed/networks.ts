/**
 * Managed-engine Docker network names shared by engine compose and ProxySQL.
 */

import {
  type DockerCliResult,
  runDocker as defaultRunDocker,
  type RunDockerOptions,
} from "../deploy/docker-cli.ts";

/** Single source of truth for the managed-engine Docker network name. */
export const MANAGED_INGRESS_NETWORK = "turbopanel-managed";

type RunDockerFn = (
  args: string[],
  options?: RunDockerOptions,
) => Promise<DockerCliResult>;

/** Idempotently create the shared managed-engine Docker network. */
export async function ensureManagedIngressNetwork(
  run: RunDockerFn = defaultRunDocker,
): Promise<void> {
  const inspect = await run(["network", "inspect", MANAGED_INGRESS_NETWORK]);
  if (inspect.success) return;

  const create = await run(["network", "create", MANAGED_INGRESS_NETWORK]);
  if (!create.success) {
    throw new Error(
      create.stderr ||
        `Creating managed ingress Docker network ${MANAGED_INGRESS_NETWORK} failed`,
    );
  }
}
