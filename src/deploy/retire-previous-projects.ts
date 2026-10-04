/**
 * Compose project hand-over for an environment deploy.
 *
 * The control plane names one Docker Compose project per environment. A stack
 * deployed under an earlier name (the old project-wide name) is still running
 * and still recorded in the environment's `deployment.json`. Before the new
 * name comes up, those containers are taken down (volumes are kept) so they do
 * not keep serving next to the new ones or hold the same ports. Zero services
 * means nothing new will come up, so the current project is taken down too:
 * containers of services that were removed from the compose must not linger.
 */
import type { DockerCliResult, RunDockerStreamedFn } from "./docker-cli.ts";
import { forEachSequential } from "../util/sequential.ts";
import { allProjects } from "./deployment-generations.ts";
import {
  composeFileArgs,
  readDeploymentManifest,
  resolveDeployedComposePaths,
} from "./compose-files.ts";

export interface PreviousProjects {
  /** Project names the live deployment recorded, in manifest order. */
  readonly names: readonly string[];
  /** Live compose chain those projects were started from. */
  readonly composePaths: readonly string[];
}

/** Read before the new files are published, while the live ones are intact. */
export async function readPreviousProjects(
  deploymentDir: string,
): Promise<PreviousProjects | null> {
  const manifest = await readDeploymentManifest(deploymentDir);
  const composePaths = await resolveDeployedComposePaths(deploymentDir);
  if (manifest === null || composePaths === null) return null;
  return { names: allProjects(manifest), composePaths };
}

async function composeDownKeepVolumes(
  projectName: string,
  composePaths: readonly string[],
  runStreamed: RunDockerStreamedFn,
): Promise<DockerCliResult> {
  return await runStreamed([
    ...composeFileArgs(projectName, composePaths),
    "down",
    "--remove-orphans",
  ]);
}

/**
 * Take down every previously recorded project whose name is not
 * `currentProject`. With `includeCurrent` the current one goes too.
 */
export async function retirePreviousProjects(
  previous: PreviousProjects | null,
  currentProject: string,
  runStreamed: RunDockerStreamedFn,
  options: { includeCurrent?: boolean } = {},
): Promise<string[]> {
  if (previous === null) return [];
  const names = new Set(previous.names.filter((n) => n !== currentProject));
  if (options.includeCurrent === true) names.add(currentProject);
  const retired: string[] = [];
  await forEachSequential(names, async (name) => {
    const result = await composeDownKeepVolumes(
      name,
      previous.composePaths,
      runStreamed,
    );
    if (!result.success) {
      throw new Error(
        `could not take down previous compose project ${name}: ${
          result.stderr.trim().split("\n").pop() ?? "docker compose failed"
        }`,
      );
    }
    retired.push(name);
  });
  return retired;
}
