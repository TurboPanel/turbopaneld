import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import {
  backingDeviceNames,
  mountForPath,
  parseProcMounts,
  storageMountCandidates,
} from "./mounts.ts";

function fixture(name: string): string {
  return Deno.readTextFileSync(
    new URL(`./testdata/${name}`, import.meta.url),
  );
}

it("parseProcMounts parses rows and decodes octal escapes", () => {
  const entries = parseProcMounts(
    [
      "/dev/sda1 / ext4 rw,relatime 0 0",
      String.raw`/dev/sdb1 /mnt/my\040disk ext4 rw 0 0`,
      "short line",
      "",
    ].join("\n"),
  );
  assertEquals(entries, [
    { source: "/dev/sda1", mountPoint: "/", fsType: "ext4" },
    { source: "/dev/sdb1", mountPoint: "/mnt/my disk", fsType: "ext4" },
  ]);
});

it("storageMountCandidates keeps block-backed mounts, deduped and sorted", () => {
  const candidates = storageMountCandidates(
    parseProcMounts(fixture("proc-mounts.txt")),
  );
  assertEquals(
    candidates.map((c) => `${c.source} ${c.mountPoint} ${c.fsType}`),
    [
      "/dev/sda1 / ext4",
      "/dev/nvme0n1p1 /mnt/docker-data ext4",
      "/dev/sdb1 /srv/users xfs",
      "/dev/sda1 /var/lib/docker ext4",
    ],
  );
});

it("storageMountCandidates drops loop devices and squashfs mounts", () => {
  const candidates = storageMountCandidates(parseProcMounts(
    [
      "/dev/loop3 /snap/foo/1 ext4 ro 0 0",
      "/dev/sr0 /media/cdrom iso9660 ro 0 0",
      "/dev/sda2 /data squashfs ro 0 0",
      "tmpfs /tmp tmpfs rw 0 0",
    ].join("\n"),
  ));
  assertEquals(candidates, []);
});

it("mountForPath picks the longest matching mount-point prefix", () => {
  const entries = parseProcMounts(fixture("proc-mounts.txt"));
  assertEquals(mountForPath(entries, "/")?.source, "/dev/sda1");
  assertEquals(mountForPath(entries, "/srv/users")?.source, "/dev/sdb1");
  assertEquals(
    mountForPath(entries, "/srv/users/alice/site")?.source,
    "/dev/sdb1",
  );
  assertEquals(
    mountForPath(entries, "/var/lib/docker")?.mountPoint,
    "/var/lib/docker",
  );
  // Prefix matching is path-segment aware: /srv/users2 is NOT under /srv/users.
  assertEquals(mountForPath(entries, "/srv/users2")?.mountPoint, "/");
  assertEquals(mountForPath([], "/anything"), undefined);
});

it("backingDeviceNames resolves /dev sources and skips unresolvable ones", () => {
  const entries = parseProcMounts(fixture("proc-mounts.txt"));
  assertEquals(
    backingDeviceNames(entries, ["/", "/srv/users", "/mnt/docker-data"]).sort(
      (a, b) => a.localeCompare(b),
    ),
    ["nvme0n1p1", "sda1", "sdb1"],
  );
  // Same backing device for two paths is reported once.
  assertEquals(backingDeviceNames(entries, ["/", "/var/lib/docker"]), ["sda1"]);
  // /dev/mapper/* and pseudo sources never resolve to a diskstats name.
  const mapper = parseProcMounts("/dev/mapper/vg-root / ext4 rw 0 0");
  assertEquals(backingDeviceNames(mapper, ["/"]), []);
});
