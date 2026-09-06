import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import {
  backingDeviceNames,
  type MapperResolverIo,
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
    {
      source: "/dev/sda1",
      mountPoint: "/",
      fsType: "ext4",
      options: "rw,relatime",
    },
    {
      source: "/dev/sdb1",
      mountPoint: "/mnt/my disk",
      fsType: "ext4",
      options: "rw",
    },
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

const noMapperDevices: MapperResolverIo = {
  listDir: () => [],
  readFile: () => undefined,
};

it("backingDeviceNames resolves /dev sources and skips unresolvable ones", async () => {
  const entries = parseProcMounts(fixture("proc-mounts.txt"));
  assertEquals(
    (await backingDeviceNames(
      entries,
      ["/", "/srv/users", "/mnt/docker-data"],
      noMapperDevices,
    )).sort((a, b) => a.localeCompare(b)),
    ["nvme0n1p1", "sda1", "sdb1"],
  );
  // Same backing device for two paths is reported once.
  assertEquals(
    await backingDeviceNames(
      entries,
      ["/", "/var/lib/docker"],
      noMapperDevices,
    ),
    ["sda1"],
  );
});

it("backingDeviceNames resolves /dev/mapper/* sources to the backing dm-N device via sysfs", async () => {
  const mapper = parseProcMounts("/dev/mapper/vg-root / ext4 rw 0 0");
  const io: MapperResolverIo = {
    listDir: (path) => path === "/sys/block" ? ["sda", "sda1", "dm-0"] : [],
    readFile: (path) =>
      path === "/sys/block/dm-0/dm/name" ? "vg-root\n" : undefined,
  };
  assertEquals(await backingDeviceNames(mapper, ["/"], io), ["dm-0"]);
});

it("backingDeviceNames yields nothing for /dev/mapper/* and pseudo sources when no dm device matches", async () => {
  const mapper = parseProcMounts("/dev/mapper/vg-root / ext4 rw 0 0");
  assertEquals(await backingDeviceNames(mapper, ["/"], noMapperDevices), []);
});
