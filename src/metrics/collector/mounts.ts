/**
 * Host mount-table domain: parse `/proc/mounts`, enumerate the block-backed
 * filesystems an administrator could select for hosting storage, and resolve
 * which disk devices back a set of probed paths so disk aggregation can
 * prefer the devices TurboPanel actually uses.
 *
 * All consumers stay on async file reads — no `findmnt`/`lsblk` subprocess.
 */

export type MountEntry = {
  /** Mount source, e.g. `/dev/nvme0n1p2` or `tmpfs`. */
  source: string;
  /** Mount point with octal escapes (`\040` etc.) decoded. */
  mountPoint: string;
  /** Filesystem type, e.g. `ext4`. */
  fsType: string;
};

/** Filesystem types never offered as storage mount candidates. */
const CANDIDATE_EXCLUDED_FS_TYPES = new Set([
  "squashfs",
  "iso9660",
  "erofs",
  "udf",
]);

/** Decode `/proc/mounts` octal escapes (`\040` space, `\011` tab, `\134` backslash). */
function decodeMountField(field: string): string {
  return field.replace(
    /\\([0-7]{3})/g,
    (_, oct: string) => String.fromCodePoint(Number.parseInt(oct, 8)),
  );
}

/** Parse `/proc/mounts` rows (`source mountpoint fstype options dump pass`). */
export function parseProcMounts(text: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    entries.push({
      source: decodeMountField(parts[0]),
      mountPoint: decodeMountField(parts[1]),
      fsType: parts[2],
    });
  }
  return entries;
}

/**
 * Block-device-backed mounts an administrator could select as the hosting
 * filesystem: `/dev/`-sourced (loop devices excluded), read-write-capable
 * filesystem types, deduplicated by mount point and sorted by path.
 */
export function storageMountCandidates(entries: MountEntry[]): MountEntry[] {
  const byMountPoint = new Map<string, MountEntry>();
  for (const entry of entries) {
    if (!entry.source.startsWith("/dev/")) continue;
    if (entry.source.startsWith("/dev/loop")) continue;
    if (CANDIDATE_EXCLUDED_FS_TYPES.has(entry.fsType)) continue;
    if (!byMountPoint.has(entry.mountPoint)) {
      byMountPoint.set(entry.mountPoint, entry);
    }
  }
  return [...byMountPoint.values()].sort((a, b) =>
    a.mountPoint.localeCompare(b.mountPoint)
  );
}

/** The mount entry whose mount point is the longest path prefix of `path`. */
export function mountForPath(
  entries: MountEntry[],
  path: string,
): MountEntry | undefined {
  let best: MountEntry | undefined;
  for (const entry of entries) {
    const mp = entry.mountPoint;
    const isPrefix = mp === "/" ||
      path === mp ||
      path.startsWith(mp.endsWith("/") ? mp : `${mp}/`);
    if (!isPrefix) continue;
    if (!best || mp.length > best.mountPoint.length) best = entry;
  }
  return best;
}

/**
 * Kernel device names (as they appear in `/proc/diskstats`) backing `paths`.
 *
 * Only direct `/dev/<name>` sources resolve — `/dev/mapper/*`, network, and
 * pseudo sources yield nothing for that path, letting the caller fall back
 * to the whole-disk filter. Partition names are returned as-is; whole-disk
 * mapping is `block-devices.ts`'s concern.
 */
export function backingDeviceNames(
  entries: MountEntry[],
  paths: string[],
): string[] {
  const names = new Set<string>();
  for (const path of paths) {
    const mount = mountForPath(entries, path);
    if (!mount) continue;
    const match = /^\/dev\/([^/]+)$/.exec(mount.source);
    if (!match) continue;
    names.add(match[1]);
  }
  return [...names];
}
