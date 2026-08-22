/**
 * Compose file path, argv, and deployment-dir helpers.
 *
 * Compiled deploys write `compose.yaml` + `deployment.json` under
 * `<stateDir>/deployments/<projectId>/<environmentId>/`.
 */

import { basename, join } from "@std/path";

export const DAEMON_COMPOSE_FILENAME = "docker-compose.turbopanel.daemon.yml";
export const RUNTIME_COMPOSE_FILENAME = "compose.yaml";
export const COMPOSE_ENV_FILENAME = ".env";
export const DEPLOYMENT_MANIFEST_FILENAME = "deployment.json";
/** Staging subdir under a deployment for transactional publish. */
export const COMPOSE_STAGE_DIRNAME = ".staging";

/** Required mode for compose layers, daemon overlay, and the manifest. */
export const COMPOSE_FILE_MODE = 0o640;

/** Mirrors instance/daemon contract basename rules. */
export const COMPOSE_FILE_NAME_RE = /^[A-Za-z0-9._-]+\.ya?ml$/;

/**
 * Defense in depth against a hand-crafted command row that bypassed
 * `parseEnvironmentDeployPayload`.
 */
export function assertSafeComposeFilename(filename: string): void {
  if (
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("..") ||
    !COMPOSE_FILE_NAME_RE.test(filename)
  ) {
    throw new Error(`unsafe compose filename: ${filename}`);
  }
}

/**
 * Write a file and force mode `0640`. Creation-mode alone leaves an existing
 * more-permissive file mode unchanged after truncate/overwrite.
 */
export async function writeComposeFileSecure(
  path: string,
  content: string,
): Promise<void> {
  await Deno.writeTextFile(path, content, { mode: COMPOSE_FILE_MODE });
  await Deno.chmod(path, COMPOSE_FILE_MODE);
}

/**
 * Build `docker compose -p <project> -f <p1> -f <p2> …` argv prefix.
 * Throws when `paths` is empty.
 */
export function composeFileArgs(
  projectName: string,
  paths: readonly string[],
): string[] {
  if (paths.length === 0) {
    throw new Error("compose file chain must not be empty");
  }
  const args = ["compose", "-p", projectName];
  for (const path of paths) {
    args.push("-f", path);
  }
  return args;
}

/** `<stateDir>/deployments/<projectId>/<environmentId>`. */
export function environmentDeploymentDir(
  layout: { stateDir: string },
  projectId: string,
  environmentId: string,
): string {
  return join(layout.stateDir, "deployments", projectId, environmentId);
}

export function resolveEnvironmentDeploymentDir(
  layout: { stateDir: string },
  projectId: string,
  environmentId: string,
): string {
  return environmentDeploymentDir(layout, projectId, environmentId);
}

export type DeploymentManifestSecret = {
  source: string;
  target: string;
  relativePath: string;
  composeServiceName: string;
  forBuild: boolean;
  key?: string;
  forRuntime?: boolean;
};

export type DeploymentManifestV2 = {
  version: 2;
  projectId: string;
  environmentId: string;
  serverId: string;
  generation: number;
  projectName: string;
  composeSha256: string;
  services: Record<string, { replicas: number }>;
  /** Host secret files (no plaintext). Absent on pre-secrets manifests. */
  secrets?: DeploymentManifestSecret[];
  /**
   * Compose service name → TurboPanel service UUID, for every compose service
   * the deploy payload named a service for.
   *
   * This is the daemon's authoritative copy of container identity: the
   * container-log collector resolves `serviceId` from here rather than from a
   * live `com.turbopanel.service` label, which can drift, be stripped, or be
   * re-stamped by anything that touches the container outside the deployment
   * pipeline. Absent on pre-`serviceIds` manifests.
   */
  serviceIds?: Record<string, string>;
};

function isDeploymentManifestV2(
  value: unknown,
): value is DeploymentManifestV2 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 2) return false;
  if (typeof record.projectId !== "string" || record.projectId.length === 0) {
    return false;
  }
  if (
    typeof record.environmentId !== "string" ||
    record.environmentId.length === 0
  ) {
    return false;
  }
  if (typeof record.serverId !== "string") return false;
  if (typeof record.generation !== "number" || record.generation < 0) {
    return false;
  }
  if (
    typeof record.projectName !== "string" || record.projectName.length === 0
  ) {
    return false;
  }
  if (
    typeof record.composeSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.composeSha256)
  ) {
    return false;
  }
  if (
    typeof record.services !== "object" ||
    record.services === null ||
    Array.isArray(record.services)
  ) {
    return false;
  }
  return true;
}

const SECRET_PLAN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function parseManifestSecret(
  value: unknown,
): DeploymentManifestSecret | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.source !== "string" ||
    typeof record.target !== "string" ||
    typeof record.relativePath !== "string" ||
    typeof record.composeServiceName !== "string"
  ) {
    return null;
  }
  if (
    record.relativePath.includes("/") ||
    record.relativePath.includes("\\") ||
    record.relativePath.includes("..") ||
    !SECRET_PLAN_NAME_RE.test(record.relativePath)
  ) {
    return null;
  }
  const entry: DeploymentManifestSecret = {
    source: record.source,
    target: record.target,
    relativePath: record.relativePath,
    composeServiceName: record.composeServiceName,
    forBuild: record.forBuild === true,
  };
  if (typeof record.key === "string" && record.key.length > 0) {
    entry.key = record.key;
  }
  if (typeof record.forRuntime === "boolean") {
    entry.forRuntime = record.forRuntime;
  }
  return entry;
}

/** Accept only `composeServiceName → non-empty string` pairs. */
function parseManifestServiceIds(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [name, serviceId] of Object.entries(value)) {
    if (name.length === 0) continue;
    if (typeof serviceId !== "string" || serviceId.length === 0) continue;
    out[name] = serviceId;
  }
  return out;
}

function parseManifestSecrets(value: unknown): DeploymentManifestSecret[] {
  if (!Array.isArray(value)) return [];
  const out: DeploymentManifestSecret[] = [];
  for (const item of value) {
    const parsed = parseManifestSecret(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

export async function writeDeploymentManifest(
  dir: string,
  manifest: DeploymentManifestV2,
): Promise<void> {
  const body = JSON.stringify(manifest, null, 2) + "\n";
  await writeComposeFileSecure(join(dir, DEPLOYMENT_MANIFEST_FILENAME), body);
}

export async function readDeploymentManifest(
  dir: string,
): Promise<DeploymentManifestV2 | null> {
  const path = join(dir, DEPLOYMENT_MANIFEST_FILENAME);
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isDeploymentManifestV2(parsed)) return null;
  const record = parsed as unknown as Record<string, unknown>;
  const secrets = parseManifestSecrets(record.secrets);
  const serviceIds = parseManifestServiceIds(record.serviceIds);
  return {
    ...parsed,
    ...(secrets.length > 0 ? { secrets } : {}),
    ...(Object.keys(serviceIds).length > 0 ? { serviceIds } : {}),
  };
}

export type LocalDeploymentManifest = {
  dir: string;
  manifest: DeploymentManifestV2;
};

/** `null` when `path` does not exist; rethrows any other `readDir` error. */
async function readDirEntries(
  path: string,
): Promise<Deno.DirEntry[] | null> {
  try {
    const entries: Deno.DirEntry[] = [];
    for await (const entry of Deno.readDir(path)) {
      entries.push(entry);
    }
    return entries;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

function isDeploymentTreeDir(entry: Deno.DirEntry): boolean {
  return entry.isDirectory && entry.name !== COMPOSE_STAGE_DIRNAME;
}

async function pushLocalManifest(
  out: LocalDeploymentManifest[],
  dir: string,
): Promise<void> {
  const manifest = await readDeploymentManifest(dir);
  if (manifest) out.push({ dir, manifest });
}

/**
 * Scan `<stateDir>/deployments/<projectId>/<environmentId>/` for version-2
 * `deployment.json` files.
 */
export async function listLocalDeploymentManifests(
  layout: { stateDir: string },
): Promise<LocalDeploymentManifest[]> {
  const root = join(layout.stateDir, "deployments");
  const out: LocalDeploymentManifest[] = [];
  const projectEntries = await readDirEntries(root);
  if (!projectEntries) return [];

  for (const projectEntry of projectEntries) {
    if (!isDeploymentTreeDir(projectEntry)) continue;
    const projectDir = join(root, projectEntry.name);
    const envEntries = await readDirEntries(projectDir);
    if (!envEntries) continue;
    for (const envEntry of envEntries) {
      if (!isDeploymentTreeDir(envEntry)) continue;
      await pushLocalManifest(out, join(projectDir, envEntry.name));
    }
  }
  return out;
}

export async function writeComposeEnvFile(
  dir: string,
  content: string,
): Promise<void> {
  await writeComposeFileSecure(join(dir, COMPOSE_ENV_FILENAME), content);
}

export async function removeComposeEnvFile(dir: string): Promise<void> {
  try {
    await Deno.remove(join(dir, COMPOSE_ENV_FILENAME));
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    return stat.isFile;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

/**
 * Delete every `*.yml` / `*.yaml` in `dir` whose basename is not in
 * `keepFilenames`.
 */
export async function pruneStaleComposeLayerFiles(
  dir: string,
  keepFilenames: ReadonlySet<string>,
): Promise<void> {
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile) continue;
    const name = entry.name;
    if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
    if (keepFilenames.has(name)) continue;
    await Deno.remove(join(dir, name));
  }
}

/**
 * Publish a single compiled `compose.yaml` plus `deployment.json`, then prune
 * leftover compose files.
 */
export async function publishStagedRuntimeCompose(
  deploymentDir: string,
  stageDir: string,
  manifest: DeploymentManifestV2,
): Promise<string[]> {
  const staged = join(stageDir, RUNTIME_COMPOSE_FILENAME);
  const live = join(deploymentDir, RUNTIME_COMPOSE_FILENAME);
  const content = await Deno.readTextFile(staged);
  await writeComposeFileSecure(live, content);
  await writeDeploymentManifest(deploymentDir, manifest);
  await pruneStaleComposeLayerFiles(
    deploymentDir,
    new Set([RUNTIME_COMPOSE_FILENAME]),
  );
  return [live];
}

/** Recreate an empty compose stage directory under `deploymentDir`. */
export async function resetComposeStageDir(
  deploymentDir: string,
): Promise<string> {
  const stageDir = join(deploymentDir, COMPOSE_STAGE_DIRNAME);
  try {
    await Deno.remove(stageDir, { recursive: true });
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  await Deno.mkdir(stageDir, { recursive: true, mode: 0o750 });
  return stageDir;
}

/** Best-effort removal of the compose stage directory. */
export async function removeComposeStageDir(
  deploymentDir: string,
): Promise<void> {
  const stageDir = join(deploymentDir, COMPOSE_STAGE_DIRNAME);
  try {
    await Deno.remove(stageDir, { recursive: true });
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}

/**
 * Absolute path to compiled `compose.yaml`, or `null` when not deployed.
 */
export async function resolveDeployedComposePaths(
  dir: string,
): Promise<string[] | null> {
  const runtime = join(dir, RUNTIME_COMPOSE_FILENAME);
  if (await fileExists(runtime)) return [runtime];
  return null;
}

/** Basename helper for callers building a manifest from absolute paths. */
export function composeBasename(path: string): string {
  return basename(path);
}
