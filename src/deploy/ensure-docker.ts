import { logInfo } from "../logger.ts";
import { runDockerSetup } from "../orchestration/ansible.ts";
import { dockerEngineReachable } from "./docker-cli.ts";

const DOCKER_BIN = "/usr/bin/docker";

async function dockerBinaryPresent(): Promise<boolean> {
  try {
    const stat = await Deno.stat(DOCKER_BIN);
    return stat.isFile;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

/**
 * Ensure Docker Engine is installed and the daemon can reach the API.
 *
 * Always runs docker-setup when the binary is missing OR the socket is
 * unreachable (e.g. user not yet in the `docker` group). Group membership
 * changes require `sg docker` for the rest of this process — see docker-cli.ts.
 */
export async function ensureDocker(): Promise<void> {
  const present = await dockerBinaryPresent();
  const reachable = present ? await dockerEngineReachable() : false;

  if (present && reachable) return;

  logInfo(
    "deploy",
    present
      ? "Docker binary present but Engine API unreachable — running docker-setup"
      : "Docker binary missing — running docker-setup",
  );
  await runDockerSetup();

  if (!(await dockerEngineReachable())) {
    throw new Error(
      "Docker Engine API still unreachable after docker-setup (is the daemon user in the docker group?)",
    );
  }
}
