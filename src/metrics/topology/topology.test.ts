import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { defaultSensorIo } from "../collector/sensors/discovery.ts";
import { collectTopology } from "./topology.ts";
import { EMPTY_TOPOLOGY_OVERRIDES } from "./types.ts";

const test = Deno.test.bind(Deno);

function fixtureRoot(name: string): string {
  return fromFileUrl(new URL(`./testdata/${name}`, import.meta.url));
}

function fixtureText(name: string): string {
  return Deno.readTextFileSync(
    new URL(`../collector/testdata/${name}`, import.meta.url),
  );
}

async function withTempStateDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

test("collectTopology: composes every discovery module into one stamped snapshot", async () => {
  await withTempStateDir(async (daemonStateDir) => {
    const snapshot = await collectTopology({
      readProcFile: (path) => {
        if (path === "/proc/net/dev") {
          return "Inter-|   Receive\n face |bytes\n  eth0: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n";
        }
        if (path === "/proc/mounts") return fixtureText("proc-mounts.txt");
        if (path === "/proc/diskstats") {
          return fixtureText("proc-diskstats-nvme.txt");
        }
        if (path === "/proc/cpuinfo") return undefined;
        if (path === "/proc/meminfo") return undefined;
        return undefined;
      },
      statfs: () => ({ blocks: 1000, bfree: 500, bavail: 400, bsize: 4096 }),
      resolveDockerDataRoot: () => Promise.resolve("/var/lib/docker"),
      resolveHostingPath: () => "/srv/users",
      resolveFabricInterfaces: () => Promise.resolve([]),
      io: defaultSensorIo(),
      sysRoot: fixtureRoot("net-topology"),
      daemonStateDir,
      resolveTopologyOverrides: () => Promise.resolve(EMPTY_TOPOLOGY_OVERRIDES),
      resolveBootGeneration: () => Promise.resolve(0),
      collectHardwareSignals: () => Promise.resolve([]),
    });

    assertEquals(snapshot.generation, 0);
    assertEquals(snapshot.bootGeneration, 0);
    assertEquals(snapshot.networks.length, 1);
    assertEquals(snapshot.networks[0].name, "eth0");
    assertEquals(snapshot.filesystems.length > 0, true);
    assertEquals(snapshot.blockDevices.length > 0, true);
    assertEquals(snapshot.hardwareSignals, []);
  });
});

test("collectTopology: a /dev/mapper/* root resolves to its dm-N device and is marked isServiceDevice", async () => {
  await withTempStateDir(async (daemonStateDir) => {
    const snapshot = await collectTopology({
      readProcFile: (path) => {
        if (path === "/proc/net/dev") {
          return "Inter-|   Receive\n face |bytes\n  eth0: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n";
        }
        // An LVM root: the mount source is a /dev/mapper/* symlink target,
        // never a direct /dev/<name> — the production path this exercises.
        if (path === "/proc/mounts") {
          return "/dev/mapper/vg0-root / ext4 rw,relatime 0 0\n";
        }
        if (path === "/proc/diskstats") {
          return fixtureText("proc-diskstats-lvm.txt");
        }
        return undefined;
      },
      statfs: () => ({ blocks: 1000, bfree: 500, bavail: 400, bsize: 4096 }),
      resolveDockerDataRoot: () => Promise.resolve(null),
      resolveHostingPath: () => Promise.reject(new Error("no hosting path")),
      resolveFabricInterfaces: () => Promise.resolve([]),
      io: defaultSensorIo(),
      // dm-0's sysfs `dm/name` reads "vg0-root", matching the mapper source.
      sysRoot: fixtureRoot("block-graph-lvm"),
      daemonStateDir,
      resolveTopologyOverrides: () => Promise.resolve(EMPTY_TOPOLOGY_OVERRIDES),
      resolveBootGeneration: () => Promise.resolve(0),
      collectHardwareSignals: () => Promise.resolve([]),
    });

    const dm0 = snapshot.blockDevices.find((d) => d.kernelName === "dm-0");
    if (!dm0) throw new TypeError("expected dm-0 in block topology");
    assertEquals(dm0.isServiceDevice, true);

    // The physical disk backing the LVM PV is not itself the service
    // device — the virtual dm-0 device (which carries its own diskstats
    // counters) is.
    const sda = snapshot.blockDevices.find((d) => d.kernelName === "sda");
    assertEquals(sda?.isServiceDevice, false);
  });
});

test("collectTopology: a second identical tick reuses the same generation", async () => {
  await withTempStateDir(async (daemonStateDir) => {
    const deps = {
      readProcFile: (path: string) => {
        if (path === "/proc/net/dev") {
          return "Inter-|   Receive\n face |bytes\n  eth0: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n";
        }
        if (path === "/proc/mounts") return fixtureText("proc-mounts.txt");
        if (path === "/proc/diskstats") {
          return fixtureText("proc-diskstats-nvme.txt");
        }
        return undefined;
      },
      statfs: () => ({ blocks: 1000, bfree: 500, bavail: 400, bsize: 4096 }),
      resolveDockerDataRoot: () => Promise.resolve("/var/lib/docker"),
      resolveHostingPath: () => "/srv/users",
      resolveFabricInterfaces: () => Promise.resolve([]),
      io: defaultSensorIo(),
      sysRoot: fixtureRoot("net-topology"),
      daemonStateDir,
      resolveTopologyOverrides: () => Promise.resolve(EMPTY_TOPOLOGY_OVERRIDES),
      resolveBootGeneration: () => Promise.resolve(0),
      collectHardwareSignals: () => Promise.resolve([]),
    };
    const first = await collectTopology(deps);
    const second = await collectTopology(deps);
    assertEquals(first.generation, second.generation);
  });
});

test("collectTopology: a VM with real hwmon/RAPL sysfs still reports hardwareSignals: [] (isPhysicalMachine gates the real collector, not a fixture stub)", async () => {
  await withTempStateDir(async (daemonStateDir) => {
    const snapshot = await collectTopology({
      readProcFile: (path) => {
        if (path === "/proc/net/dev") {
          return "Inter-|   Receive\n face |bytes\n  eth0: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n";
        }
        if (path === "/proc/mounts") return fixtureText("proc-mounts.txt");
        if (path === "/proc/diskstats") {
          return fixtureText("proc-diskstats-nvme.txt");
        }
        return undefined;
      },
      statfs: () => ({ blocks: 1000, bfree: 500, bavail: 400, bsize: 4096 }),
      resolveDockerDataRoot: () => Promise.resolve("/var/lib/docker"),
      resolveHostingPath: () => "/srv/users",
      resolveFabricInterfaces: () => Promise.resolve([]),
      io: defaultSensorIo(),
      // Real hwmon (coretemp) + RAPL sysfs trees, same as a bare-metal
      // fixture — only `class/dmi/id/sys_vendor` (QEMU) differs. Deliberately
      // does NOT override `collectHardwareSignals` — this exercises the real
      // `isPhysicalMachine` gate in `collectTopologyInputs`, not a fixture
      // stub standing in for it.
      sysRoot: fixtureRoot("physical-vm-with-hwmon"),
      daemonStateDir,
      resolveTopologyOverrides: () => Promise.resolve(EMPTY_TOPOLOGY_OVERRIDES),
      resolveBootGeneration: () => Promise.resolve(0),
    });

    assertEquals(snapshot.hardwareSignals, []);
  });
});
