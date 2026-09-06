import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { defaultSensorIo } from "../collector/sensors/discovery.ts";
import { collectFilesystemTopology } from "./filesystem-topology.ts";

const test = Deno.test.bind(Deno);

function fixtureRoot(name: string): string {
  return fromFileUrl(new URL(`./testdata/${name}`, import.meta.url));
}

function fixtureText(name: string): string {
  return Deno.readTextFileSync(
    new URL(`../collector/testdata/${name}`, import.meta.url),
  );
}

function fakeStatfs() {
  return {
    blocks: 1000,
    bfree: 500,
    bavail: 400,
    bsize: 4096,
    files: 100,
    ffree: 50,
  };
}

test("collectFilesystemTopology: root, hosting, and Docker resolving to the same device collapse to one entry with every role", async () => {
  // proc-mounts.txt: /dev/sda1 is mounted at both "/" and "/var/lib/docker".
  const filesystems = await collectFilesystemTopology({
    readProcFile: (path) =>
      path === "/proc/mounts" ? fixtureText("proc-mounts.txt") : undefined,
    statfs: () => fakeStatfs(),
    resolveHostingPath: () => "/",
    resolveDockerDataRoot: () => Promise.resolve("/var/lib/docker"),
    io: defaultSensorIo(),
    sysRoot: fixtureRoot("net-topology"),
  });

  const merged = filesystems.find((fs) => fs.sourceDevice === "/dev/sda1");
  assertEquals(merged !== undefined, true);
  assertEquals(new Set(merged!.roles), new Set(["root", "hosting", "docker"]));
  assertEquals(
    filesystems.filter((fs) => fs.sourceDevice === "/dev/sda1").length,
    1,
  );
});

test("collectFilesystemTopology: distinct devices for hosting and Docker stay as separate entries", async () => {
  const filesystems = await collectFilesystemTopology({
    readProcFile: (path) =>
      path === "/proc/mounts" ? fixtureText("proc-mounts.txt") : undefined,
    statfs: () => fakeStatfs(),
    resolveHostingPath: () => "/srv/users",
    resolveDockerDataRoot: () => Promise.resolve("/mnt/docker-data"),
    io: defaultSensorIo(),
    sysRoot: fixtureRoot("net-topology"),
  });

  const root = filesystems.find((fs) => fs.roles.includes("root"));
  const hosting = filesystems.find((fs) => fs.roles.includes("hosting"));
  const docker = filesystems.find((fs) => fs.roles.includes("docker"));
  assertEquals(root?.sourceDevice, "/dev/sda1");
  assertEquals(hosting?.sourceDevice, "/dev/sdb1");
  assertEquals(docker?.sourceDevice, "/dev/nvme0n1p1");
  assertEquals(filesystems.length, 3);
});
