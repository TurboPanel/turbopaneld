import { assertEquals } from "@std/assert";
import { isAllowedFilesystem } from "./allowlist.ts";

const test = Deno.test.bind(Deno);

test("real on-disk filesystems are allowed", () => {
  for (const fsType of ["ext4", "xfs", "btrfs", "zfs", "f2fs", "bcachefs"]) {
    assertEquals(isAllowedFilesystem(fsType, "/srv"), true, fsType);
  }
});

test("pseudo, overlay, fuse and squashfs filesystems are dropped", () => {
  for (
    const fsType of [
      "tmpfs",
      "devtmpfs",
      "overlay",
      "squashfs",
      "nsfs",
      "proc",
      "sysfs",
      "cgroup2",
      "fuse.sshfs",
      "fuse",
    ]
  ) {
    assertEquals(isAllowedFilesystem(fsType, "/x"), false, fsType);
  }
});

test("mounts under docker, run, snap and boot are dropped even when ext4", () => {
  for (
    const mountpoint of [
      "/var/lib/docker/overlay2/abc/merged",
      "/run/user/1000",
      "/snap/core/1",
      "/boot",
      "/boot/efi",
    ]
  ) {
    assertEquals(isAllowedFilesystem("ext4", mountpoint), false, mountpoint);
  }
  // A dedicated Docker data volume is not "under" /var/lib/docker.
  assertEquals(isAllowedFilesystem("ext4", "/var/lib/docker"), true);
  assertEquals(isAllowedFilesystem("ext4", "/bootstrap"), true);
});
