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

test("collectFilesystemTopology: root, hosting, Docker, backup and logs resolving to the same device collapse to one entry with every role", async () => {
  // proc-mounts.txt: /dev/sda1 is mounted at both "/" and "/var/lib/docker",
  // and neither /backup nor /var/log has a mount of its own, so both resolve
  // up to "/" — the single-disk shape every small host has.
  const filesystems = await collectFilesystemTopology({
    readProcFile: (path) =>
      path === "/proc/mounts" ? fixtureText("proc-mounts.txt") : undefined,
    statfs: () => fakeStatfs(),
    resolveHostingPath: () => "/",
    resolveDockerDataRoot: () => Promise.resolve("/var/lib/docker"),
    resolveBackupPath: () => "/backup",
    resolveLogsPath: () => "/var/log/turbopanel",
    io: defaultSensorIo(),
    sysRoot: fixtureRoot("net-topology"),
  });

  const merged = filesystems.find((fs) => fs.sourceDevice === "/dev/sda1");
  assertEquals(merged !== undefined, true);
  assertEquals(
    new Set(merged!.roles),
    new Set(["root", "hosting", "docker", "backup", "logs"]),
  );
  assertEquals(
    filesystems.filter((fs) => fs.sourceDevice === "/dev/sda1").length,
    1,
  );
});

test("collectFilesystemTopology: a backup root on its own device is a separate entry with the backup role", async () => {
  const filesystems = await collectFilesystemTopology({
    readProcFile: (path) =>
      path === "/proc/mounts" ? fixtureText("proc-mounts.txt") : undefined,
    statfs: () => fakeStatfs(),
    resolveHostingPath: () => "/",
    resolveDockerDataRoot: () => Promise.resolve(null),
    // An operator pointing TURBOPANEL_BACKUP_DIR at the second disk.
    resolveBackupPath: () => "/mnt/docker-data",
    resolveLogsPath: () => "/var/log/turbopanel",
    io: defaultSensorIo(),
    sysRoot: fixtureRoot("net-topology"),
  });

  const backup = filesystems.find((fs) => fs.roles.includes("backup"));
  assertEquals(backup?.sourceDevice, "/dev/nvme0n1p1");
  assertEquals(backup?.roles, ["backup"]);
  // The logs role still collapsed onto root, which also carries hosting.
  const root = filesystems.find((fs) => fs.roles.includes("root"));
  assertEquals(new Set(root!.roles), new Set(["root", "hosting", "logs"]));
});

test("collectFilesystemTopology: distinct devices for hosting and Docker stay as separate entries", async () => {
  const filesystems = await collectFilesystemTopology({
    readProcFile: (path) =>
      path === "/proc/mounts" ? fixtureText("proc-mounts.txt") : undefined,
    statfs: () => fakeStatfs(),
    resolveHostingPath: () => "/srv/users",
    resolveDockerDataRoot: () => Promise.resolve("/mnt/docker-data"),
    resolveBackupPath: () => "/backup",
    resolveLogsPath: () => "/var/log/turbopanel",
    io: defaultSensorIo(),
    sysRoot: fixtureRoot("net-topology"),
  });

  const root = filesystems.find((fs) => fs.roles.includes("root"));
  const hosting = filesystems.find((fs) => fs.roles.includes("hosting"));
  const docker = filesystems.find((fs) => fs.roles.includes("docker"));
  assertEquals(root?.sourceDevice, "/dev/sda1");
  assertEquals(hosting?.sourceDevice, "/dev/sdb1");
  assertEquals(docker?.sourceDevice, "/dev/nvme0n1p1");
  // Backup and logs have no mount of their own here, so both collapse onto
  // root rather than adding entries — still three filesystems.
  assertEquals(new Set(root!.roles), new Set(["root", "backup", "logs"]));
  assertEquals(filesystems.length, 3);
});
