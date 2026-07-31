import { dirname, join } from "@std/path";
import type { LayoutPaths } from "../paths/layout.ts";
import type {
  EnvironmentDeployPrincipalMaterial,
  EnvironmentDeployStorageMaterial,
} from "../instance/commands/contracts.ts";
import type { DecryptSecretsFn } from "./materialize-tls.ts";
import { ensureDirectoryOwnedByPrincipal } from "./ensure-principal.ts";
import { runDocker } from "./docker-cli.ts";

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

/**
 * Legacy volume naming for older instances that omit `volumeName`.
 * The instance owns naming for new deploys — prefer `entry.volumeName`.
 */
function namespaceDockerVolumeName(
  organizationId: string,
  name: string,
): string {
  return `tp-${organizationId.slice(0, 8)}-${name}`;
}

async function maybeChown(
  hostPath: string,
  ownership: EnvironmentDeployPrincipalMaterial | undefined,
): Promise<void> {
  if (!ownership) return;
  await ensureDirectoryOwnedByPrincipal(hostPath, ownership.uid, ownership.gid);
}

async function ensureParentDirectory(hostPath: string): Promise<void> {
  const parent = dirname(hostPath);
  if (parent.length === 0 || parent === hostPath) return;
  await Deno.mkdir(parent, { recursive: true, mode: 0o750 });
}

async function materializeDirectory(
  hostPath: string,
  ownership: EnvironmentDeployPrincipalMaterial | undefined,
): Promise<void> {
  await Deno.mkdir(hostPath, { recursive: true, mode: 0o750 });
  await maybeChown(hostPath, ownership);
}

async function materializeFile(
  baseDir: string,
  entry: EnvironmentDeployStorageMaterial,
  ownership: EnvironmentDeployPrincipalMaterial | undefined,
  content: string,
): Promise<string> {
  const hostPath = join(baseDir, entry.name);
  await ensureParentDirectory(hostPath);
  await Deno.writeTextFile(hostPath, content, { mode: 0o640 });
  await maybeChown(hostPath, ownership);
  return hostPath;
}

async function materializeDockerVolume(
  organizationId: string,
  entry: EnvironmentDeployStorageMaterial,
): Promise<string> {
  // Instance owns Docker volume names (`volumeName`); legacy fallback only
  // for older control planes that omit the field.
  const volumeName = entry.volumeName && entry.volumeName.length > 0
    ? entry.volumeName
    : namespaceDockerVolumeName(organizationId, entry.name);
  const create = await runDocker(["volume", "create", volumeName]);
  if (!create.success) {
    throw new Error(
      create.stderr || `Failed to create docker volume ${volumeName}`,
    );
  }
  return volumeName;
}

async function materializeHostPathEntry(
  baseDir: string,
  entry: EnvironmentDeployStorageMaterial,
  ownership: EnvironmentDeployPrincipalMaterial | undefined,
  fileContent: string,
): Promise<string> {
  let hostPath = entry.sourcePath ?? baseDir;

  if (entry.kind === "directory") {
    await materializeDirectory(hostPath, ownership);
  } else if (entry.kind === "file") {
    hostPath = await materializeFile(baseDir, entry, ownership, fileContent);
  } else if (entry.kind === "bind_mount") {
    if (ownership) {
      // Sudo-backed create so parents under principal-owned 0750 trees exist.
      await ensureDirectoryOwnedByPrincipal(
        hostPath,
        ownership.uid,
        ownership.gid,
      );
    } else {
      await ensureParentDirectory(hostPath);
      await Deno.mkdir(hostPath, { recursive: true, mode: 0o750 }).catch(() => {
        // Path may already exist as a file mount point.
      });
    }
  }

  return hostPath;
}

function isEncryptedEnvelope(envelope: string): boolean {
  return envelope.startsWith("denc.") || envelope.startsWith("enc.");
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

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    const baseDir = join(
      layout.stateDir,
      STORAGE_ROOT,
      organizationId,
      entry.storageId,
    );
    await Deno.mkdir(baseDir, { recursive: true, mode: 0o750 });

    if (entry.kind === "docker_volume") {
      mountPaths.set(
        entry.storageId,
        await materializeDockerVolume(organizationId, entry),
      );
      continue;
    }

    const hostPath = await materializeHostPathEntry(
      baseDir,
      entry,
      resolveOwnership(entry, principalMap),
      resolveEntryFileContent(entry, decryptedContents[i]),
    );
    mountPaths.set(entry.storageId, hostPath);
  }

  return mountPaths;
}

export function storageHostPath(
  layout: LayoutPaths,
  organizationId: string,
  storageId: string,
): string {
  return join(layout.stateDir, STORAGE_ROOT, organizationId, storageId);
}
