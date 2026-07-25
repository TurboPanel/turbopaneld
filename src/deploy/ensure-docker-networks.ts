/** Ensure compose `external: true` Docker networks exist before `docker compose up`. */

import { logInfo } from "../logger.ts";
import { runDocker } from "./docker-cli.ts";

const DOCKER_NETWORK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function assertValidDockerNetworkName(name: string): void {
  if (!DOCKER_NETWORK_NAME_RE.test(name)) {
    throw new Error(`Invalid docker network name: ${name}`);
  }
}

export async function ensureExternalDockerNetworks(
  names: readonly string[],
): Promise<void> {
  if (names.length === 0) return;

  for (const name of names) {
    assertValidDockerNetworkName(name);
    const inspect = await runDocker(["network", "inspect", name]);
    if (inspect.success) continue;

    logInfo("deploy", `creating external docker network ${name}`);
    const create = await runDocker(["network", "create", name]);
    if (!create.success) {
      throw new Error(
        create.stderr || `Failed to create docker network ${name}`,
      );
    }
  }
}
