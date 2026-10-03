/**
 * Kind allowlists applied while topology is enumerated, so entities that can
 * never be monitored (pseudo filesystems, container plumbing) take no slot
 * and never enter topology identity — a Docker restart cannot bump the
 * topology generation.
 */

const ALLOWED_FS_TYPES = new Set([
  "ext2",
  "ext3",
  "ext4",
  "xfs",
  "btrfs",
  "zfs",
  "f2fs",
  "bcachefs",
]);

const EXCLUDED_MOUNT_ROOTS = [
  "/var/lib/docker/",
  "/run/",
  "/snap/",
  "/boot/",
] as const;

/** Whether a mount is a real, monitorable filesystem. */
export function isAllowedFilesystem(
  fsType: string,
  mountpoint: string,
): boolean {
  if (!ALLOWED_FS_TYPES.has(fsType)) return false;
  if (mountpoint === "/boot") return false;
  return !EXCLUDED_MOUNT_ROOTS.some((root) => mountpoint.startsWith(root));
}
