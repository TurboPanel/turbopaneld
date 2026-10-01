/**
 * Compose file path, argv, and deployment-dir helpers.
 *
 * Compiled deploys write `compose.yaml` + `deployment.json` under
 * `<stateDir>/deployments/<projectId>/<environmentId>/`.
 */

import { basename, join } from "@std/path";
import {
  type DeploymentGeneration,
  type DeploymentPrevious,
  parseGenerations,
  parsePrevious,
} from "./deployment-generations.ts";

export const DAEMON_COMPOSE_FILENAME = "docker-compose.turbopanel.daemon.yml";
export const RUNTIME_COMPOSE_FILENAME = "compose.yaml";
export const COMPOSE_ENV_FILENAME = ".env";
export const DEPLOYMENT_MANIFEST_FILENAME = "deployment.json";
/** Where the previous deploy's files are kept under a deployment. */
export const COMPOSE_PREVIOUS_DIRNAME = "previous";
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

/**
 * One source-backed release this deployment applied.
 *
 * Recorded at the **environment** level (not only inside the release tree)
 * because that is the layer reboot and reconnect actually read:
 * `readDeploymentManifest()` is what `environment.lifecycle` and
 * `rehydrate-deployments.ts` consult when the control plane is unreachable, and
 * without this they know which containers to start but not which release or
 * commit is behind them. `.turbopanel/release.json` answers the same question
 * per release directory; this answers it per environment, which is what
 * lifecycle and (later) rollback need.
 */
export type DeploymentManifestRelease = {
  /** Compose service key the release was built for. */
  composeServiceName: string;
  /** TurboPanel service UUID, or the compose key when the payload named none. */
  serviceId: string;
  /** Release directory name under `sites/<serviceId>/releases/`. */
  releaseId: string;
  /** `source` row the release was resolved from. */
  sourceId: string;
  /**
   * The commit this release is actually serving.
   *
   * For a fresh release that is what the checkout resolved to; for a rollback it
   * is the commit read back out of the promoted release's own manifest, not the
   * placeholder the payload carried. The host's durable record therefore names
   * the code that is running, which is the whole point of keeping it here.
   */
  commitSha: string;
  /** Commit subject / author, when the source provider resolved them. */
  commitMessage?: string;
  commitAuthor?: string;
  /** Ref the commit was resolved from, when the payload carried one. */
  ref?: string;
  /**
   * Principal the release tree lives under
   * (`<principalHomeRoot>/<username>/sites/<serviceId>`).
   *
   * Recorded so a **later** deploy can still address the tree of a service that
   * has since been removed from the compose: once the payload no longer carries
   * a `sourceMaterial[]` entry for it there is nothing left to derive the owning
   * home from, and the whole tree would be orphaned on disk. Absent on
   * pre-`username` manifests and on entries the payload named no principal for
   * (those never had a tree published), so readers must treat it as optional.
   */
  username?: string;
};

/**
 * `deployment.json`. Version 2 is the original single-project shape; version 3
 * adds `generations` and `previous` and is what new deploys write. Both are read.
 */
export type DeploymentManifest = {
  version: 2 | 3;
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
   * This is the daemon's authoritative copy of container identity. The
   * on-demand log tail (`src/logs/container-tail.ts`) validates that a
   * requested container belongs to the caller's service against this map
   * rather than a live `com.turbopanel.service` label, which can drift, be
   * stripped, or be re-stamped by anything that touches the container outside
   * the deployment pipeline. Absent on pre-`serviceIds` manifests.
   */
  serviceIds?: Record<string, string>;
  /**
   * Source-backed releases applied by this deploy, one entry per
   * `sourceMaterial[]` entry. Absent on pre-`releases` manifests **and** on
   * every deploy that has no Git-backed service, so readers must treat it as
   * optional rather than as evidence the deploy predates the field.
   */
  releases?: DeploymentManifestRelease[];
  /**
   * Compose projects this deployment runs (version 3). Absent on version 2,
   * which implies one live blue generation named by `projectName`; read through
   * `liveProjects()` / `allProjects()` rather than directly.
   */
  generations?: DeploymentGeneration[];
  /** Index of the files kept under `previous/` (version 3). */
  previous?: DeploymentPrevious;
};

function isDeploymentManifest(
  value: unknown,
): value is DeploymentManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 2 && record.version !== 3) return false;
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

/**
 * Accept only fully-identified release rows.
 *
 * A partial row is dropped rather than repaired: half a release identity is
 * worse than none for the lifecycle paths that will read this — they must be
 * able to trust that an entry names a real release directory and commit.
 */
function parseManifestRelease(
  value: unknown,
): DeploymentManifestRelease | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  for (
    const key of [
      "composeServiceName",
      "serviceId",
      "releaseId",
      "sourceId",
      "commitSha",
    ]
  ) {
    const field = record[key];
    if (typeof field !== "string" || field.length === 0) return null;
  }
  const entry: DeploymentManifestRelease = {
    composeServiceName: record.composeServiceName as string,
    serviceId: record.serviceId as string,
    releaseId: record.releaseId as string,
    sourceId: record.sourceId as string,
    commitSha: record.commitSha as string,
  };
  if (typeof record.ref === "string" && record.ref.length > 0) {
    entry.ref = record.ref;
  }
  // Display-only, and absent on every manifest written before it was recorded —
  // a missing one is not a reason to drop an otherwise-valid release row.
  if (
    typeof record.commitMessage === "string" && record.commitMessage.length > 0
  ) {
    entry.commitMessage = record.commitMessage;
  }
  if (
    typeof record.commitAuthor === "string" && record.commitAuthor.length > 0
  ) {
    entry.commitAuthor = record.commitAuthor;
  }
  if (typeof record.username === "string" && record.username.length > 0) {
    entry.username = record.username;
  }
  return entry;
}

function parseManifestReleases(value: unknown): DeploymentManifestRelease[] {
  if (!Array.isArray(value)) return [];
  const out: DeploymentManifestRelease[] = [];
  for (const item of value) {
    const parsed = parseManifestRelease(item);
    if (parsed) out.push(parsed);
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
  manifest: DeploymentManifest,
): Promise<void> {
  const body = JSON.stringify(manifest, null, 2) + "\n";
  await writeComposeFileSecure(join(dir, DEPLOYMENT_MANIFEST_FILENAME), body);
}

export async function readDeploymentManifest(
  dir: string,
): Promise<DeploymentManifest | null> {
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
  if (!isDeploymentManifest(parsed)) return null;
  const record = parsed as unknown as Record<string, unknown>;
  const secrets = parseManifestSecrets(record.secrets);
  const serviceIds = parseManifestServiceIds(record.serviceIds);
  // Older manifests carry no `releases` at all; that is a normal read, not a
  // rejected one — the field stays absent and every existing reader is
  // unaffected.
  const releases = parseManifestReleases(record.releases);
  const generations = parseGenerations(record.generations);
  const previous = parsePrevious(record.previous);
  // Rebuilt field by field rather than spread from `parsed`: the optional
  // arrays/maps must be the *parsed* ones, and spreading the raw document would
  // let an unvalidated `secrets` / `serviceIds` / `releases` survive whenever
  // parsing dropped every entry.
  return {
    version: parsed.version,
    projectId: parsed.projectId,
    environmentId: parsed.environmentId,
    serverId: parsed.serverId,
    generation: parsed.generation,
    projectName: parsed.projectName,
    composeSha256: parsed.composeSha256,
    services: parsed.services,
    ...(secrets.length > 0 ? { secrets } : {}),
    ...(Object.keys(serviceIds).length > 0 ? { serviceIds } : {}),
    ...(releases.length > 0 ? { releases } : {}),
    ...(generations.length > 0 ? { generations } : {}),
    ...(previous ? { previous } : {}),
  };
}

export type LocalDeploymentManifest = {
  dir: string;
  manifest: DeploymentManifest;
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

async function readLocalManifest(
  dir: string,
): Promise<LocalDeploymentManifest | undefined> {
  const manifest = await readDeploymentManifest(dir);
  return manifest ? { dir, manifest } : undefined;
}

/**
 * Scan `<stateDir>/deployments/<projectId>/<environmentId>/` for version-2 and
 * version-3 `deployment.json` files.
 */
export async function listLocalDeploymentManifests(
  layout: { stateDir: string },
): Promise<LocalDeploymentManifest[]> {
  const root = join(layout.stateDir, "deployments");
  const projectEntries = await readDirEntries(root);
  if (!projectEntries) return [];

  // Read-only scans of independent directories; `Promise.all` keeps the
  // directory-listing order in the result.
  const perProject = await Promise.all(
    projectEntries.filter(isDeploymentTreeDir).map(async (projectEntry) => {
      const projectDir = join(root, projectEntry.name);
      const envEntries = await readDirEntries(projectDir);
      if (!envEntries) return [];
      const found = await Promise.all(
        envEntries.filter(isDeploymentTreeDir).map((envEntry) =>
          readLocalManifest(join(projectDir, envEntry.name))
        ),
      );
      return found.filter((m): m is LocalDeploymentManifest => m !== undefined);
    }),
  );
  return perProject.flat();
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

async function copyIfPresent(from: string, to: string): Promise<boolean> {
  let content: string;
  try {
    content = await Deno.readTextFile(from);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
  await writeComposeFileSecure(to, content);
  return true;
}

async function removePreviousDir(deploymentDir: string): Promise<string> {
  const previousDir = join(deploymentDir, COMPOSE_PREVIOUS_DIRNAME);
  try {
    await Deno.remove(previousDir, { recursive: true });
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  return previousDir;
}

async function resetPreviousDir(deploymentDir: string): Promise<string> {
  const previousDir = await removePreviousDir(deploymentDir);
  await Deno.mkdir(previousDir, { recursive: true, mode: 0o750 });
  return previousDir;
}

/**
 * Copy the live `compose.yaml`, `.env` and `deployment.json` into
 * `<deploymentDir>/previous/` (replacing whatever was there) and return their
 * index, or `null` when there is no readable earlier deploy to keep.
 *
 * Called by {@link publishStagedRuntimeCompose} just before it overwrites the
 * live files, so `previous/` always holds the deploy this one replaced. Only
 * one generation back is kept.
 */
export async function retainPreviousDeployment(
  deploymentDir: string,
): Promise<DeploymentPrevious | null> {
  const live = await readDeploymentManifest(deploymentDir);
  const composePath = join(deploymentDir, RUNTIME_COMPOSE_FILENAME);
  if (live === null || !(await fileExists(composePath))) {
    // Nothing readable to keep: drop any older copy so `previous/` and the
    // manifest's `previous` index never disagree.
    await removePreviousDir(deploymentDir);
    return null;
  }
  const previousDir = await resetPreviousDir(deploymentDir);
  await copyIfPresent(composePath, join(previousDir, RUNTIME_COMPOSE_FILENAME));
  await copyIfPresent(
    join(deploymentDir, COMPOSE_ENV_FILENAME),
    join(previousDir, COMPOSE_ENV_FILENAME),
  );
  await copyIfPresent(
    join(deploymentDir, DEPLOYMENT_MANIFEST_FILENAME),
    join(previousDir, DEPLOYMENT_MANIFEST_FILENAME),
  );
  return {
    generation: live.generation,
    projectName: live.projectName,
    composeSha256: live.composeSha256,
  };
}

/**
 * Publish a single compiled `compose.yaml` plus `deployment.json`, then prune
 * leftover compose files. The files being replaced are kept under `previous/`
 * first and indexed in the manifest's `previous` field.
 */
export async function publishStagedRuntimeCompose(
  deploymentDir: string,
  stageDir: string,
  manifest: DeploymentManifest,
): Promise<string[]> {
  const staged = join(stageDir, RUNTIME_COMPOSE_FILENAME);
  const live = join(deploymentDir, RUNTIME_COMPOSE_FILENAME);
  const content = await Deno.readTextFile(staged);
  const previous = await retainPreviousDeployment(deploymentDir);
  const { previous: _stale, ...rest } = manifest;
  await writeComposeFileSecure(live, content);
  await writeDeploymentManifest(
    deploymentDir,
    previous ? { ...rest, previous } : rest,
  );
  await pruneStaleComposeLayerFiles(
    deploymentDir,
    new Set([RUNTIME_COMPOSE_FILENAME]),
  );
  return [live];
}

/** Compose chain of the deploy kept under `previous/`, or `null` when none was kept. */
export async function previousComposePaths(
  deploymentDir: string,
): Promise<string[] | null> {
  const path = join(
    deploymentDir,
    COMPOSE_PREVIOUS_DIRNAME,
    RUNTIME_COMPOSE_FILENAME,
  );
  return (await fileExists(path)) ? [path] : null;
}

/**
 * Put the files kept under `previous/` back as the live deployment (rollback of
 * a failed sequential deploy) and return the live compose chain, or `null` when
 * there is nothing to restore.
 *
 * The restored manifest loses its own `previous` index and `previous/` is
 * removed: both described a deploy that no longer exists once this one is the
 * live one again, and keeping either would let the next publish record a
 * bogus "previous".
 */
export async function restorePreviousDeployment(
  deploymentDir: string,
): Promise<string[] | null> {
  const previousDir = join(deploymentDir, COMPOSE_PREVIOUS_DIRNAME);
  const manifest = await readDeploymentManifest(previousDir);
  const composeFrom = join(previousDir, RUNTIME_COMPOSE_FILENAME);
  if (manifest === null || !(await fileExists(composeFrom))) return null;
  const live = join(deploymentDir, RUNTIME_COMPOSE_FILENAME);
  await writeComposeFileSecure(live, await Deno.readTextFile(composeFrom));
  const hadEnv = await copyIfPresent(
    join(previousDir, COMPOSE_ENV_FILENAME),
    join(deploymentDir, COMPOSE_ENV_FILENAME),
  );
  if (!hadEnv) await removeComposeEnvFile(deploymentDir);
  const { previous: _index, ...restored } = manifest;
  await writeDeploymentManifest(deploymentDir, restored);
  await removePreviousDir(deploymentDir);
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
