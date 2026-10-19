import { dirname, join } from "@std/path";
import type { LayoutPaths } from "../paths/layout.ts";
import { forEachSequential } from "../util/sequential.ts";
import type {
  EnvironmentDeployPrincipalMaterial,
  EnvironmentDeployStorageMaterial,
} from "../contracts/commands-contracts.ts";
import type { DecryptSecretsFn } from "./materialize-tls.ts";
import { ensureAssetFolder } from "./asset-folders.ts";
import {
  ensureDirectoryOwnedByPrincipal,
  lookupPrincipalIds,
  principalUnixGroupName,
  type RunFn,
} from "./ensure-principal.ts";
import { runDocker } from "./docker-cli.ts";
import { directoryExists } from "../permissions/privileged-read.ts";

const STORAGE_ROOT = "storage";

function principalById(
  principals: EnvironmentDeployPrincipalMaterial[] | undefined,
): Map<string, EnvironmentDeployPrincipalMaterial> {
  const map = new Map<string, EnvironmentDeployPrincipalMaterial>();
  for (const principal of principals ?? []) {
    map.set(principal.principalId, principal);
  }
  return map;
}

function resolveOwnership(
  entry: EnvironmentDeployStorageMaterial,
  principalMap: Map<string, EnvironmentDeployPrincipalMaterial>,
): EnvironmentDeployPrincipalMaterial | undefined {
  if (!entry.principalId) return undefined;
  return principalMap.get(entry.principalId);
}

async function maybeChown(
  hostPath: string,
  ownership: EnvironmentDeployPrincipalMaterial | undefined,
): Promise<void> {
  if (!ownership) return;
  await ensureDirectoryOwnedByPrincipal(
    hostPath,
    ownership.username,
    principalUnixGroupName(ownership.username),
  );
}

/**
 * The segments of a storage file name, relative to its location. Refuses
 * anything that could leave the location (`..`, an absolute path) or that is
 * ambiguous (`.`, empty segments, a trailing slash).
 */
function storageFileSegments(name: string): string[] {
  const segments = name.split("/");
  const bad = name.startsWith("/") ||
    segments.some((s) => s === "" || s === "." || s === "..");
  if (bad) {
    throw new TypeError(`Invalid storage file name: ${name}`);
  }
  return segments;
}

/** `lstat`, with "absent" as `null` rather than an exception. */
async function lstatOrNull(path: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.lstat(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

/**
 * Create `dir` if absent and refuse it unless it is a real directory. `lstat`
 * never follows a link, so a link planted in its place is refused rather than
 * walked through.
 */
async function ensureRealDirectory(dir: string): Promise<void> {
  if (await lstatOrNull(dir) === null) {
    await Deno.mkdir(dir, { mode: 0o750 });
  }
  const info = await Deno.lstat(dir);
  if (!info.isDirectory || info.isSymlink) {
    throw new Error(`${dir} is not a directory`);
  }
}

/**
 * A path storage directory with no principal to own it. The daemon creates it
 * where it may (its own storage root); anywhere it may not — a principal home,
 * an operator mount — it must already exist, because root has nobody to hand
 * a new directory to. An existing one the daemon cannot traverse is confirmed
 * through tp-host rather than failing the deploy. Either way a link planted in
 * its place is refused, never walked through.
 */
async function materializeUnownedDirectory(hostPath: string): Promise<void> {
  try {
    await Deno.mkdir(dirname(hostPath), { recursive: true, mode: 0o750 });
    await ensureRealDirectory(hostPath);
    return;
  } catch (err) {
    if (!(err instanceof Deno.errors.PermissionDenied)) throw err;
  }
  if (await directoryExists(hostPath)) return;
  throw new Error(
    `storage directory ${hostPath} does not exist and has no principal to own it; assign the storage to a principal or create the directory on the host`,
  );
}

/**
 * Write `content` to `path` without following a link at `path`: a new file is
 * opened with `createNew` (`O_EXCL`, which never follows) next to it and then
 * renamed over it. `rename(2)` replaces a link rather than writing through it,
 * and the file is never seen half-written.
 */
async function replaceFileNoFollow(
  path: string,
  content: string,
): Promise<void> {
  const existing = await lstatOrNull(path);
  if (existing?.isDirectory) {
    throw new Error(`${path} is a directory`);
  }
  const temp = join(
    dirname(path),
    `.tp-storage-${crypto.randomUUID()}.tmp`,
  );
  await Deno.writeTextFile(temp, content, { createNew: true, mode: 0o640 });
  try {
    await Deno.rename(temp, path);
  } catch (err) {
    await Deno.remove(temp).catch(() => undefined);
    throw err;
  }
}

async function materializeFile(
  baseDir: string,
  entry: EnvironmentDeployStorageMaterial,
  ownership: EnvironmentDeployPrincipalMaterial | undefined,
  content: string,
): Promise<string> {
  const segments = storageFileSegments(entry.name);
  const parents = segments.slice(0, -1).map((_, i) =>
    join(baseDir, ...segments.slice(0, i + 1))
  );
  // Parent before child, each one checked before anything is created in it.
  await forEachSequential([baseDir, ...parents], ensureRealDirectory);
  const hostPath = join(baseDir, ...segments);
  await replaceFileNoFollow(hostPath, content);
  await maybeChown(hostPath, ownership);
  return hostPath;
}

async function materializeDockerVolume(
  entry: EnvironmentDeployStorageMaterial,
): Promise<string> {
  if (!entry.volumeName || entry.volumeName.length === 0) {
    throw new Error(
      `volume ${entry.storageId} missing volumeName`,
    );
  }
  const volumeName = entry.volumeName;
  const create = await runDocker(["volume", "create", volumeName]);
  if (!create.success) {
    throw new Error(
      create.stderr || `Failed to create docker volume ${volumeName}`,
    );
  }
  return volumeName;
}

/**
 * A path copy lives only in its volume folder (`<owner>/<scope>/volumes/<name>`),
 * named by `folder`. A `sourcePath` with no folder names nothing the daemon will
 * create, re-own or bind-mount, so the deploy is refused.
 */
function assertHasFolderForSourcePath(
  entry: EnvironmentDeployStorageMaterial,
): void {
  if (entry.sourcePath === undefined) return;
  throw new Error(
    `storage ${entry.storageId}: a path copy needs the folder the control plane plans for it (sent source path ${entry.sourcePath} without one)`,
  );
}

/**
 * A volume folder (`<owner>/<scope>/volumes/<name>`): checked against the
 * record of its first components, then created `<owner>:<owner> 0750`. Only
 * the folder itself is given to the owner, never anything inside it: files a
 * container writes keep the user id the container ran as.
 */
async function materializeVolumeFolder(
  layout: LayoutPaths,
  entry: EnvironmentDeployStorageMaterial,
  ownership: EnvironmentDeployPrincipalMaterial | undefined,
): Promise<string> {
  if (entry.folder === undefined) {
    throw new Error(`storage ${entry.storageId} has no folder`);
  }
  if (ownership?.username !== entry.folder.owner) {
    throw new Error(
      `storage ${entry.storageId}: its folder belongs to ${entry.folder.owner}, who is not the site owner this deploy names for it`,
    );
  }
  return await ensureAssetFolder(layout, entry.storageId, {
    ...entry.folder,
    kind: "volume",
  });
}

async function materializeHostPathEntry(
  layout: LayoutPaths,
  baseDir: string,
  entry: EnvironmentDeployStorageMaterial,
  ownership: EnvironmentDeployPrincipalMaterial | undefined,
  fileContent: string,
): Promise<string> {
  if (entry.folder !== undefined && entry.kind === "directory") {
    return await materializeVolumeFolder(layout, entry, ownership);
  }
  assertHasFolderForSourcePath(entry);
  let hostPath = baseDir;

  if (entry.kind === "directory") {
    if (ownership) {
      await ensureDirectoryOwnedByPrincipal(
        hostPath,
        ownership.username,
        principalUnixGroupName(ownership.username),
      );
    } else {
      await materializeUnownedDirectory(hostPath);
    }
  } else if (entry.kind === "file") {
    hostPath = await materializeFile(baseDir, entry, ownership, fileContent);
  }

  return hostPath;
}

function isEncryptedEnvelope(envelope: string): boolean {
  return envelope.startsWith("tpdaemon.") || envelope.startsWith("tpsecret.");
}

async function decryptEntryContents(
  entries: EnvironmentDeployStorageMaterial[],
  decryptSecrets?: DecryptSecretsFn,
): Promise<(string | null)[]> {
  const contentEnvelopes = entries.map((entry) => entry.contentEnvelope ?? "");
  const hasEncryptedContent = contentEnvelopes.some(isEncryptedEnvelope);
  if (!hasEncryptedContent) {
    return entries.map(() => "");
  }
  if (!decryptSecrets) {
    throw new Error(
      "Storage content present but secrets decrypt is unavailable",
    );
  }
  const decryptedContents = await decryptSecrets(contentEnvelopes);
  if (decryptedContents.length !== entries.length) {
    throw new Error("secrets/decrypt returned unexpected length");
  }
  return decryptedContents;
}

function resolveEntryFileContent(
  entry: EnvironmentDeployStorageMaterial,
  decrypted: string | null | undefined,
): string {
  const envelope = entry.contentEnvelope;
  if (!envelope || envelope.length === 0) return "";
  if (!isEncryptedEnvelope(envelope)) return envelope;
  if (typeof decrypted !== "string") {
    throw new TypeError(
      `Failed to decrypt storage content for ${entry.storageId}`,
    );
  }
  return decrypted;
}

/**
 * Materialize one physical copy. Later `storage.location.ensure` can call this
 * without going through `environment.deploy`.
 */
export async function materializeLocation(
  layout: LayoutPaths,
  organizationId: string,
  entry: EnvironmentDeployStorageMaterial,
  ownership: EnvironmentDeployPrincipalMaterial | undefined,
  fileContent: string,
): Promise<string> {
  const baseDir = storageHostPath(
    layout,
    organizationId,
    entry.storageId,
    entry.locationId,
  );
  await Deno.mkdir(baseDir, { recursive: true, mode: 0o750 });

  if (entry.kind === "volume" || entry.provider === "docker") {
    return await materializeDockerVolume(entry);
  }

  return await materializeHostPathEntry(
    layout,
    baseDir,
    entry,
    ownership,
    fileContent,
  );
}

export async function materializeStorageEntries(
  layout: LayoutPaths,
  organizationId: string,
  entries: EnvironmentDeployStorageMaterial[],
  principals?: EnvironmentDeployPrincipalMaterial[],
  decryptSecrets?: DecryptSecretsFn,
): Promise<Map<string, string>> {
  const mountPaths = new Map<string, string>();
  const principalMap = principalById(principals);
  const decryptedContents = await decryptEntryContents(entries, decryptSecrets);

  // Host paths / docker volumes are created in order; a failure stops the rest.
  await forEachSequential(entries, async (entry, i) => {
    const hostPath = await materializeLocation(
      layout,
      organizationId,
      entry,
      resolveOwnership(entry, principalMap),
      resolveEntryFileContent(entry, decryptedContents[i]),
    );
    mountPaths.set(entry.locationId, hostPath);
  });

  return mountPaths;
}

export function storageHostPath(
  layout: LayoutPaths,
  organizationId: string,
  storageId: string,
  locationId: string,
): string {
  return join(
    layout.stateDir,
    STORAGE_ROOT,
    organizationId,
    storageId,
    locationId,
    "data",
  );
}

/** The user and group ids a container runs as to write into an owner's volume. */
export type VolumeOwnerIds = ReadonlyMap<
  string,
  { uid: number; gid: number }
>;

/**
 * Ids of the site owner behind each volume folder, by storage id. A container
 * that mounts the folder is run as these ids (unless its own compose file
 * names a user), so what it writes belongs to the owner the SFTP login and the
 * backups see. The ids come from the deploy's principal material when it names
 * them, else from the account on this host.
 */
export async function resolveVolumeOwnerIds(
  entries: readonly EnvironmentDeployStorageMaterial[],
  principals: readonly EnvironmentDeployPrincipalMaterial[] | undefined,
  runFn?: RunFn,
): Promise<VolumeOwnerIds> {
  const byId = principalById(
    principals as EnvironmentDeployPrincipalMaterial[],
  );
  const owners = new Map<string, { uid: number; gid: number }>();
  const out = new Map<string, { uid: number; gid: number }>();
  const wanted = entries.filter((entry) =>
    entry.folder !== undefined && entry.kind === "directory"
  );
  await forEachSequential(wanted, async (entry) => {
    const owner = entry.folder!.owner;
    let ids = owners.get(owner);
    if (ids === undefined) {
      // The account on this host is the truth; the deploy's own ids only
      // stand in before the account exists.
      const material = entry.principalId
        ? byId.get(entry.principalId)
        : undefined;
      ids = await lookupPrincipalIds(owner, runFn) ??
        (material?.uid !== undefined && material.gid !== undefined
          ? { uid: material.uid, gid: material.gid }
          : undefined);
      if (ids === undefined) {
        throw new Error(
          `storage ${entry.storageId}: the site owner ${owner} has no account on this host yet`,
        );
      }
      owners.set(owner, ids);
    }
    out.set(entry.storageId, ids);
  });
  return out;
}
