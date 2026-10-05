/**
 * Compose project hand-over for an environment deploy.
 *
 * The control plane names one Docker Compose project per environment. A stack
 * deployed under an earlier name (the old project-wide name) is still running
 * and still recorded in the environment's `deployment.json`. Before the new
 * name comes up, this environment's containers under those names are removed
 * (volumes are kept) so they do not keep serving next to the new ones or hold
 * the same names and ports.
 *
 * The old name was shared by every environment of the project on this server,
 * so a whole-project `compose down` would also remove a sibling environment's
 * containers. Removal is therefore scoped to this environment: a container
 * counts when it carries this environment's id label, or (older containers
 * without the label) when Compose started it from this environment's
 * deployment directory.
 *
 * Zero services means nothing new will come up, so the current project's
 * containers go too: services removed from the compose must not linger.
 */
import type { RunDockerFn } from "./docker-cli.ts";
import { forEachSequential } from "../util/sequential.ts";
import { allProjects } from "./deployment-generations.ts";
import { readDeploymentManifest } from "./compose-files.ts";
import { LABEL_ENVIRONMENT } from "./labels.ts";

const LABEL_COMPOSE_WORKING_DIR = "com.docker.compose.project.working_dir";

export interface PreviousProjects {
  /** Project names the live deployment recorded, in manifest order. */
  readonly names: readonly string[];
}

export interface RetireScope {
  readonly environmentId: string;
  /** `<stateDir>/deployments/<projectId>/<environmentId>`. */
  readonly deploymentDir: string;
  readonly includeCurrent?: boolean;
}

/** Read before the new files are published. */
export async function readPreviousProjects(
  deploymentDir: string,
): Promise<PreviousProjects | null> {
  const manifest = await readDeploymentManifest(deploymentDir);
  if (manifest === null) return null;
  return { names: allProjects(manifest) };
}

/** Container ids of `project` that belong to this environment. */
async function ownContainerIds(
  project: string,
  scope: RetireScope,
  run: RunDockerFn,
): Promise<string[]> {
  const listed = await run([
    "ps",
    "-a",
    "--filter",
    `label=com.docker.compose.project=${project}`,
    "--format",
    `{{.ID}}\t{{.Label "${LABEL_ENVIRONMENT}"}}\t{{.Label "${LABEL_COMPOSE_WORKING_DIR}"}}`,
  ]);
  if (!listed.success) {
    throw new Error(
      `could not list the containers of the earlier compose project ${project}; ` +
        "the earlier containers were left running",
    );
  }
  return listed.stdout.split("\n").flatMap((line) => {
    const [id, environment, workingDir] = line.split("\t");
    if (!id) return [];
    const mine = environment === scope.environmentId ||
      workingDir === scope.deploymentDir;
    return mine ? [id] : [];
  });
}

export type EarlierContainerAction = "remove" | "stop" | "start" | "restart";

/**
 * Apply `action` to this environment's containers under each of `names`
 * (never another environment's). Returns the project names that had any.
 */
export async function actOnEarlierContainers(
  names: Iterable<string>,
  run: RunDockerFn,
  scope: RetireScope,
  action: EarlierContainerAction,
): Promise<string[]> {
  const acted: string[] = [];
  await forEachSequential(new Set(names), async (name) => {
    const ids = await ownContainerIds(name, scope, run);
    if (ids.length === 0) return;
    const args = action === "remove" ? ["rm", "-f", ...ids] : [action, ...ids];
    const result = await run(args);
    if (!result.success) {
      throw new Error(
        `could not ${action} the containers of the earlier compose project ${name}; ` +
          "stop them by hand, then try again",
      );
    }
    acted.push(name);
  });
  return acted;
}

/**
 * Project names the environment's `deployment.json` records when the command's
 * own name is not one of them (a stack started under an earlier, project-wide
 * name). Empty when the recorded names already include the command's name.
 */
export async function earlierRecordedProjects(
  deploymentDir: string,
  commandProject: string,
): Promise<string[]> {
  const previous = await readPreviousProjects(deploymentDir);
  if (previous === null || previous.names.includes(commandProject)) return [];
  return [...previous.names];
}

/**
 * Remove this environment's containers under every previously recorded project
 * whose name is not `currentProject` (and the current one with
 * `includeCurrent`). Containers of other environments are never touched.
 */
export function retirePreviousProjects(
  previous: PreviousProjects | null,
  currentProject: string,
  run: RunDockerFn,
  scope: RetireScope,
): Promise<string[]> {
  if (previous === null) return Promise.resolve([]);
  const names = new Set(previous.names.filter((n) => n !== currentProject));
  if (scope.includeCurrent === true) names.add(currentProject);
  return actOnEarlierContainers(names, run, scope, "remove");
}
