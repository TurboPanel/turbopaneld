/**
 * Compose file path, argv, and deployment-dir helpers.
 *
 * Compiled deploys write `compose.yaml` + `deployment.json` under
 * `<stateDir>/deployments/<projectId>/<environmentId>/`. Lifecycle/stop prefer
 * that tree and fall back to the pre-cutover `deployments/<environmentId>/`
 * layout until the next deploy republishes.
 */

import { basename, join } from "@std/path";
import { logInfo } from "../logger.ts";

export const DAEMON_COMPOSE_FILENAME = "docker-compose.turbopanel.daemon.yml";
export const LEGACY_COMPOSE_FILENAME = "docker-compose.yml";
export const RUNTIME_COMPOSE_FILENAME = "compose.yaml";
export const COMPOSE_ENV_FILENAME = ".env";
export const COMPOSE_MANIFEST_FILENAME = "compose-files.json";
export const DEPLOYMENT_MANIFEST_FILENAME = "deployment.json";
/** Staging subdir under a deployment for transactional chain replacement. */
export const COMPOSE_STAGE_DIRNAME = ".staging";

/** Required mode for compose layers, daemon overlay, and the manifest. */
export const COMPOSE_FILE_MODE = 0o640;

/** Mirrors instance/daemon contract basename rules. */
export const COMPOSE_FILE_NAME_RE = /^[A-Za-z0-9._-]+\.ya?ml$/;

const MANIFEST_VERSION = 1;

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

/** `<stateDir>/deployments/<environmentId>` (pre-compiler layout). */
export function legacyDeploymentDir(
  layout: { stateDir: string },
  environmentId: string,
): string {
  return join(layout.stateDir, "deployments", environmentId);
}

/** `<stateDir>/deployments/<projectId>/<environmentId>`. */
export function environmentDeploymentDir(
  layout: { stateDir: string },
  projectId: string,
  environmentId: string,
): string {
  return join(layout.stateDir, "deployments", projectId, environmentId);
}

/** @deprecated Prefer {@link environmentDeploymentDir} / {@link resolveEnvironmentDeploymentDir}. */
export function deploymentDir(
  layout: { stateDir: string },
  environmentId: string,
): string {
  return legacyDeploymentDir(layout, environmentId);
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

async function dirLooksDeployed(dir: string): Promise<boolean> {
  for (
    const name of [
      DEPLOYMENT_MANIFEST_FILENAME,
      RUNTIME_COMPOSE_FILENAME,
      COMPOSE_MANIFEST_FILENAME,
      LEGACY_COMPOSE_FILENAME,
    ]
  ) {
    if (await fileExists(join(dir, name))) return true;
  }
  return false;
}

/**
 * Prefer the compiled layout; fall back to the pre-cutover
 * `deployments/<environmentId>/` tree until the next deploy republishes.
 */
export async function resolveEnvironmentDeploymentDir(
  layout: { stateDir: string },
  projectId: string,
  environmentId: string,
): Promise<string> {
  const next = environmentDeploymentDir(layout, projectId, environmentId);
  const legacy = legacyDeploymentDir(layout, environmentId);
  if (await dirLooksDeployed(next)) return next;
  if (await dirLooksDeployed(legacy)) return legacy;
  return next;
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
  if (typeof record.projectName !== "string" || record.projectName.length === 0) {
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
  const secrets = parseManifestSecrets(
    (parsed as unknown as Record<string, unknown>).secrets,
  );
  return secrets.length > 0 ? { ...parsed, secrets } : parsed;
}

export type LocalDeploymentManifest = {
  dir: string;
  manifest: DeploymentManifestV2;
};

/**
 * Scan `<stateDir>/deployments/` for version-2 `deployment.json` files
 * (compiled `<projectId>/<environmentId>/` trees and leftover single-level
 * dirs).
 */
export async function listLocalDeploymentManifests(
  layout: { stateDir: string },
): Promise<LocalDeploymentManifest[]> {
  const root = join(layout.stateDir, "deployments");
  const out: LocalDeploymentManifest[] = [];
  let projectEntries: Deno.DirEntry[];
  try {
    projectEntries = [];
    for await (const entry of Deno.readDir(root)) {
      projectEntries.push(entry);
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err;
  }

  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory) continue;
    if (projectEntry.name === COMPOSE_STAGE_DIRNAME) continue;
    const projectDir = join(root, projectEntry.name);
    const direct = await readDeploymentManifest(projectDir);
    if (direct) out.push({ dir: projectDir, manifest: direct });
    try {
      for await (const envEntry of Deno.readDir(projectDir)) {
        if (!envEntry.isDirectory) continue;
        if (envEntry.name === COMPOSE_STAGE_DIRNAME) continue;
        const envDir = join(projectDir, envEntry.name);
        const manifest = await readDeploymentManifest(envDir);
        if (manifest) out.push({ dir: envDir, manifest });
      }
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
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

export type ComposeLayerWrite = {
  filename: string;
  content: string;
};

/**
 * Write payload compose layers at mode `0640` in order. Does **not** prune
 * other files — call {@link pruneStaleComposeLayerFiles} only after the new
 * chain is validated and the manifest is authoritative.
 */
export async function writeComposeLayerFiles(
  dir: string,
  files: readonly ComposeLayerWrite[],
): Promise<string[]> {
  const absolutePaths: string[] = [];

  for (const file of files) {
    assertSafeComposeFilename(file.filename);
    const abs = join(dir, file.filename);
    await writeComposeFileSecure(abs, file.content);
    absolutePaths.push(abs);
  }

  return absolutePaths;
}

/**
 * Delete every `*.yml` / `*.yaml` in `dir` whose basename is not in
 * `keepFilenames`. Does not touch `compose-files.json` or non-compose files.
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
 * Copy staged layer basenames into the live deployment dir, write the
 * authoritative manifest, then prune stale live compose files. Returns
 * ordered absolute paths under `deploymentDir`.
 *
 * Call only after Docker config/overlay validation has succeeded so a failed
 * redeploy leaves the previous live chain intact.
 */
export async function publishStagedComposeChain(
  deploymentDir: string,
  stageDir: string,
  basenames: readonly string[],
): Promise<string[]> {
  if (basenames.length === 0) {
    throw new Error("compose file chain must not be empty");
  }

  const livePaths: string[] = [];
  for (const name of basenames) {
    assertSafeComposeFilename(name);
    const content = await Deno.readTextFile(join(stageDir, name));
    const abs = join(deploymentDir, name);
    await writeComposeFileSecure(abs, content);
    livePaths.push(abs);
  }

  await writeComposeFileManifest(deploymentDir, basenames);
  await pruneStaleComposeLayerFiles(deploymentDir, new Set(basenames));
  return livePaths;
}

/**
 * Publish a single compiled `compose.yaml` plus `deployment.json`, then prune
 * leftover layered compose files and the v1 `compose-files.json` manifest.
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
  try {
    await Deno.remove(join(deploymentDir, COMPOSE_MANIFEST_FILENAME));
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
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

/** Persist ordered basenames only (never absolute paths). Mode `0640`. */
export async function writeComposeFileManifest(
  dir: string,
  filenames: readonly string[],
): Promise<void> {
  for (const name of filenames) {
    assertSafeComposeFilename(name);
  }
  const body = JSON.stringify(
    { version: MANIFEST_VERSION, files: [...filenames] },
    null,
    2,
  ) + "\n";
  await writeComposeFileSecure(join(dir, COMPOSE_MANIFEST_FILENAME), body);
}

function isManifestShape(
  value: unknown,
): value is { version: number; files: string[] } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== MANIFEST_VERSION) return false;
  if (!Array.isArray(record.files) || record.files.length === 0) return false;
  return record.files.every((f) => typeof f === "string");
}

/**
 * Clear deploy-state error for a present-but-invalid `compose-files.json`.
 * Callers must not fall back to the legacy single-file path in this case.
 */
export class ComposeManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComposeManifestError";
  }
}

function throwComposeManifestError(dir: string, detail: string): never {
  const message =
    `invalid compose-files.json in ${dir}: ${detail} — redeploy the environment`;
  logInfo("deploy", message);
  throw new ComposeManifestError(message);
}

/**
 * Manifest file text, or `null` when `compose-files.json` is absent. Any
 * other read failure throws {@link ComposeManifestError}.
 */
async function readManifestFileText(
  dir: string,
  manifestPath: string,
): Promise<string | null> {
  try {
    return await Deno.readTextFile(manifestPath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throwComposeManifestError(
      dir,
      `unreadable (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

/** Parsed + shape-validated `files` list from manifest JSON text. */
function parseManifestFiles(dir: string, text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throwComposeManifestError(dir, "corrupt JSON");
  }
  if (!isManifestShape(parsed)) {
    throwComposeManifestError(dir, "invalid shape or empty files list");
  }
  return parsed.files;
}

/**
 * Absolute path for one manifest-listed layer, after validating the basename
 * and confirming the file exists on disk.
 */
async function resolveManifestLayerPath(
  dir: string,
  name: string,
): Promise<string> {
  try {
    assertSafeComposeFilename(name);
  } catch {
    throwComposeManifestError(dir, `unsafe basename ${name}`);
  }
  const abs = join(dir, name);
  try {
    const stat = await Deno.stat(abs);
    if (!stat.isFile) {
      throwComposeManifestError(dir, `listed path is not a file: ${name}`);
    }
  } catch (err) {
    if (err instanceof ComposeManifestError) throw err;
    if (err instanceof Deno.errors.NotFound) {
      throwComposeManifestError(dir, `missing layer file ${name}`);
    }
    throw err;
  }
  return abs;
}

/**
 * Ordered absolute paths from the manifest.
 *
 * Returns `null` only when `compose-files.json` is **absent** (pre-layered /
 * never-deployed dirs). When the manifest exists but is corrupt, unreadable,
 * unsafe, or references a missing layer, throws {@link ComposeManifestError}
 * so lifecycle/stop never silently fall back to a partial legacy chain.
 */
export async function readComposeFileManifest(
  dir: string,
): Promise<string[] | null> {
  const manifestPath = join(dir, COMPOSE_MANIFEST_FILENAME);
  const text = await readManifestFileText(dir, manifestPath);
  if (text === null) return null;

  const files = parseManifestFiles(dir, text);

  const absolutePaths: string[] = [];
  for (const name of files) {
    absolutePaths.push(await resolveManifestLayerPath(dir, name));
  }
  return absolutePaths;
}

/**
 * Manifest chain when present and valid; else legacy single
 * `docker-compose.yml` **only when the manifest file is absent**; else `null`
 * (not deployed / empty).
 *
 * A present but invalid manifest throws — never returns only the legacy file
 * while a layered chain may still exist on disk partially.
 */
export async function resolveDeployedComposePaths(
  dir: string,
): Promise<string[] | null> {
  const runtime = join(dir, RUNTIME_COMPOSE_FILENAME);
  if (await fileExists(runtime)) return [runtime];

  const fromManifest = await readComposeFileManifest(dir);
  if (fromManifest !== null) return fromManifest;

  const legacy = join(dir, LEGACY_COMPOSE_FILENAME);
  if (await fileExists(legacy)) return [legacy];
  return null;
}

/** Basename helper for callers building a manifest from absolute paths. */
export function composeBasename(path: string): string {
  return basename(path);
}
