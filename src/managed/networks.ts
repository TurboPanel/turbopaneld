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
