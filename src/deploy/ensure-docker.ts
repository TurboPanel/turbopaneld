import { logInfo } from "../logger.ts";
import { runDockerSetup as defaultRunDockerSetup } from "../orchestration/ansible.ts";
import { dockerEngineReachable as defaultDockerEngineReachable } from "./docker-cli.ts";

const DOCKER_BIN = "/usr/bin/docker";

/** Optional test seams for {@link ensureDocker}. */
export type EnsureDockerDeps = {
  dockerBinaryPresent?: () => Promise<boolean>;
  dockerEngineReachable?: () => Promise<boolean>;
  runDockerSetup?: () => Promise<void>;
  /** Host-free seam for the default binary probe (`Deno.stat`). */
  stat?: (path: string) => Promise<Deno.FileInfo>;
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

/**
 * Ensure Docker Engine is installed and the daemon can reach the API.
 *
 * Always runs docker-setup when the binary is missing OR the socket is
 * unreachable (e.g. user not yet in the `docker` group). Group membership
 * changes use `sudo -n -u <self>` for the rest of this process — see
 * docker-cli.ts (`sg` fails for `/usr/sbin/nologin` service accounts).
 */
export async function ensureDocker(deps?: EnsureDockerDeps): Promise<void> {
  const presentFn = deps?.dockerBinaryPresent ??
    (() => dockerBinaryPresentDefault(deps?.stat ?? Deno.stat));
  const reachableFn = deps?.dockerEngineReachable ??
    defaultDockerEngineReachable;
  const setupFn = deps?.runDockerSetup ?? defaultRunDockerSetup;

  const present = await presentFn();
  const reachable = present ? await reachableFn() : false;

  if (present && reachable) return;

  logInfo(
    "deploy",
    present
      ? "Docker binary present but Engine API unreachable — running docker-setup"
      : "Docker binary missing — running docker-setup",
  );
  await setupFn();

  if (!(await reachableFn())) {
    throw new Error(
      "Docker Engine API still unreachable after docker-setup (is the daemon user in the docker group?)",
    );
  }
}
