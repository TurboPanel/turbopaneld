/**
 * Filesystem topology: wraps `collector/mounts.ts`'s mount-table parsing and
 * `collector/hosting.ts`/Docker data-root resolution, deduped by
 * {@link deriveFilesystemId} so the system root, the hosting path, and the
 * Docker data root — often the same physical filesystem — collapse to one
 * `FilesystemTopology` entry carrying every role that resolved onto it,
 * instead of three duplicate entries.
 */
import {
  type MountEntry,
  mountForPath,
  parseProcMounts,
} from "../collector/mounts.ts";
import { probeStorage } from "../collector/filesystem.ts";
import type { StatfsResult } from "../collector/types.ts";
import { deriveFilesystemId, type IdentityIo } from "./identity.ts";
import type { FilesystemRole, FilesystemTopology } from "./types.ts";

export type FilesystemTopologyDeps = {
  readProcFile: (
    path: string,
  ) => string | undefined | Promise<string | undefined>;
  /** Raw `statfs` read (same shape as `MetricsCapabilityDeps.statfs`) — `probeStorage` does the byte/inode reduction. */
  statfs: (
    path: string,
  ) => StatfsResult | null | Promise<StatfsResult | null>;
  resolveHostingPath: () => string | Promise<string>;
  resolveDockerDataRoot: () => Promise<string | null>;
  io: IdentityIo;
  sysRoot?: string;
};

/** Direct `/dev/<name>` kernel device name backing a mount source; `undefined` for `/dev/mapper/*`, network, or pseudo sources. */
function kernelDeviceName(source: string): string | undefined {
  const match = /^\/dev\/([^/]+)$/.exec(source);
  return match?.[1];
}

type RoleGroup = {
  /** First-resolved entry for the group — display fields (mountpoint/fsType/sourceDevice) come from this one. */
  entry: MountEntry;
  roles: Set<FilesystemRole>;
};

/**
 * Resolve every (path, role) candidate to a mount entry, then group by
 * *resolved filesystem id* rather than mount point — two different mount
 * points backed by the same device (a bind mount, or the same disk mounted
 * again elsewhere) still collapse to one `FilesystemTopology` entry, which
 * is the whole point of deduping by identity instead of by path.
 */
async function groupByFilesystemId(
  candidates: Array<{ path: string | null; role: FilesystemRole }>,
  mountEntries: MountEntry[],
  io: IdentityIo,
  root: string,
): Promise<Map<string, RoleGroup>> {
  const groups = new Map<string, RoleGroup>();
  for (const { path, role } of candidates) {
    if (!path) continue;
    const entry = mountForPath(mountEntries, path);
    if (!entry) continue;
    const deviceName = kernelDeviceName(entry.source) ?? null;
    const filesystemId = await deriveFilesystemId(
      { sourceDevice: entry.source, deviceName, mountpoint: entry.mountPoint },
      io,
      root,
    );
    const existing = groups.get(filesystemId);
    if (existing) {
      existing.roles.add(role);
    } else {
      groups.set(filesystemId, { entry, roles: new Set([role]) });
    }
  }
  return groups;
}

/** Enumerate every filesystem the daemon cares about (root/hosting/Docker), deduped by resolved identity. */
export async function collectFilesystemTopology(
  deps: FilesystemTopologyDeps,
): Promise<FilesystemTopology[]> {
  const root = deps.sysRoot ?? "/sys";
  const [mountsText, hostingPath, dockerRoot] = await Promise.all([
    deps.readProcFile("/proc/mounts"),
    Promise.resolve().then(() => deps.resolveHostingPath()).catch(() => null),
    deps.resolveDockerDataRoot().catch(() => null),
  ]);
  if (!mountsText) return [];
  const mountEntries = parseProcMounts(mountsText);

  const groups = await groupByFilesystemId(
    [
      { path: "/", role: "root" },
      { path: hostingPath, role: "hosting" },
      { path: dockerRoot, role: "docker" },
    ],
    mountEntries,
    deps.io,
    root,
  );

  return await Promise.all(
    [...groups.entries()].map(
      async ([filesystemId, { entry, roles }]): Promise<FilesystemTopology> => {
        const probe = await probeStorage(entry.mountPoint, {
          statfs: deps.statfs,
        });
        return {
          filesystemId,
          mountpoint: entry.mountPoint,
          fsType: entry.fsType,
          sourceDevice: entry.source,
          totalBytes: probe?.totalBytes ?? null,
          totalInodes: probe?.totalInodes ?? null,
          roles: [...roles],
        };
      },
    ),
  );
}
