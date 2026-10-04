/**
 * Generations recorded in `deployment.json` (version 3).
 *
 * A deployment is one Compose project today, so every manifest has exactly one
 * generation: the `blue` project, named by the control plane, in state `live`.
 * The shape already carries what blue-green needs later (a second color, a
 * candidate / draining / retired state) so lifecycle code can resolve "which
 * projects are running" through {@link liveProjects} now and stay untouched when
 * a second project appears.
 *
 * The existing project name is always the **blue** name, which is why a
 * version-2 manifest reads as a single live blue generation with no migration.
 */

export const DEPLOYMENT_COLORS = ["blue", "green"] as const;
export type DeploymentColor = (typeof DEPLOYMENT_COLORS)[number];

export const GENERATION_STATES = [
  "live",
  "candidate",
  "draining",
  "retired",
] as const;
export type GenerationState = (typeof GENERATION_STATES)[number];

export type DeploymentGeneration = {
  color: DeploymentColor;
  /** Environment generation counter the deploy carried. */
  generation: number;
  /** Compose project name this generation runs under. */
  projectName: string;
  state: GenerationState;
};

/**
 * What the last published deploy replaced, kept so a failed or rejected deploy
 * can restore the earlier compose file. The files themselves live under
 * `<deploymentDir>/previous/`; this is their index.
 */
export type DeploymentPrevious = {
  generation: number;
  projectName: string;
  composeSha256: string;
};

/** The manifest fields this module reads. */
export type GenerationsCarrier = {
  projectName: string;
  generation: number;
  generations?: readonly DeploymentGeneration[];
};

const STATE_SET: ReadonlySet<string> = new Set(GENERATION_STATES);
const COLOR_SET: ReadonlySet<string> = new Set(DEPLOYMENT_COLORS);

/** The single generation every non-blue-green deployment has. */
export function singleGeneration(
  projectName: string,
  generation: number,
): DeploymentGeneration {
  return { color: "blue", generation, projectName, state: "live" };
}

/**
 * Accept only fully-formed rows; a malformed row is dropped rather than
 * repaired, matching how the other optional manifest fields are read.
 */
export function parseGenerations(value: unknown): DeploymentGeneration[] {
  if (!Array.isArray(value)) return [];
  const out: DeploymentGeneration[] = [];
  for (const item of value) {
    const row = parseGeneration(item);
    if (row) out.push(row);
  }
  return out;
}

function parseGeneration(value: unknown): DeploymentGeneration | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const { color, generation, projectName, state } = record;
  if (typeof color !== "string" || !COLOR_SET.has(color)) return null;
  if (typeof state !== "string" || !STATE_SET.has(state)) return null;
  if (typeof projectName !== "string" || projectName.length === 0) return null;
  if (typeof generation !== "number" || !Number.isInteger(generation)) {
    return null;
  }
  if (generation < 0) return null;
  return {
    color: color as DeploymentColor,
    generation,
    projectName,
    state: state as GenerationState,
  };
}

export function parsePrevious(value: unknown): DeploymentPrevious | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const { generation, projectName, composeSha256 } = record;
  if (typeof generation !== "number" || generation < 0) return null;
  if (typeof projectName !== "string" || projectName.length === 0) return null;
  if (
    typeof composeSha256 !== "string" || !/^[0-9a-f]{64}$/.test(composeSha256)
  ) {
    return null;
  }
  return { generation, projectName, composeSha256 };
}

/** Recorded generations, or the implied single blue one for older manifests. */
export function manifestGenerations(
  manifest: GenerationsCarrier,
): readonly DeploymentGeneration[] {
  if (manifest.generations && manifest.generations.length > 0) {
    return manifest.generations;
  }
  return [singleGeneration(manifest.projectName, manifest.generation)];
}

/**
 * Compose projects that are serving traffic right now. Start, restart, reboot
 * rehydrate and log tail resolve through this; with one project it is that
 * project, with two it is the live color only.
 */
export function liveProjects(manifest: GenerationsCarrier): string[] {
  return manifestGenerations(manifest)
    .filter((g) => g.state === "live")
    .map((g) => g.projectName);
}

/**
 * Every project this deployment owns, whatever its state. Stop, ownership
 * checks and cleanup resolve through this so a draining or retired generation
 * is never missed.
 */
export function allProjects(manifest: GenerationsCarrier): string[] {
  const names = manifestGenerations(manifest).map((g) => g.projectName);
  return [...new Set(names)];
}

/**
 * Which compose projects a lifecycle command acts on.
 *
 * The control plane names one project per command; the manifest is trusted for
 * the rest. A manifest that does not know the name is an earlier-named stack
 * of this same environment (the directory is per environment), so its recorded
 * projects are used. With no manifest the command acts on the project it named.
 * `live` = start / restart; `all` = stop / teardown.
 */
export function projectsForCommand(
  manifest: GenerationsCarrier | null,
  payloadProjectName: string,
  scope: "live" | "all",
): string[] {
  if (manifest === null) return [payloadProjectName];
  if (!allProjects(manifest).includes(payloadProjectName)) {
    // The control plane renamed the project (one per environment now): this
    // environment's directory still records the stack under its earlier name.
    // Stop takes both down; start/restart act on the recorded live ones.
    const recorded = scope === "live"
      ? liveProjects(manifest)
      : allProjects(manifest);
    if (recorded.length === 0) return [payloadProjectName];
    return scope === "live"
      ? recorded
      : [...new Set([payloadProjectName, ...recorded])];
  }
  const names = scope === "live"
    ? liveProjects(manifest)
    : allProjects(manifest);
  return names.length > 0 ? names : [payloadProjectName];
}
