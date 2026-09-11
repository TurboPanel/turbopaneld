import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import { fromFileUrl } from "@std/path";
import { collectMetricsCapabilities } from "./capabilities.ts";
import { defaultSensorIo } from "./sensors/index.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function fixtureRoot(name: string): string {
  return fromFileUrl(new URL(`./testdata/${name}`, import.meta.url));
}

const emptyHost = {
  resolveHostingPath: () => Promise.resolve("/srv/users"),
  resolveDockerDataRoot: () => Promise.resolve(null),
  probeStorage: () => Promise.resolve(null),
  pathExists: () => Promise.resolve(true),
  readProcNetDev: () =>
    Promise.resolve(
      "Inter-|   Receive                                                |  Transmit\n" +
        " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n" +
        "    lo: 100 0 0 0 0 0 0 0 100 0 0 0 0 0 0 0\n" +
        "  eth0: 200 0 0 0 0 0 0 0 200 0 0 0 0 0 0 0\n" +
        "   tp0: 300 0 0 0 0 0 0 0 300 0 0 0 0 0 0 0\n" +
        "veth0: 400 0 0 0 0 0 0 0 400 0 0 0 0 0 0 0\n",
    ),
  readProcMounts: () => Promise.resolve("/dev/sda2 / ext4 rw,relatime 0 0\n"),
  countProcesses: () => Promise.resolve(12),
};

it("collectMetricsCapabilities on a VM yields empty sensor pools and docker_absent", async () => {
  const capabilities = await collectMetricsCapabilities({
    sysRoot: fixtureRoot("sensors-none"),
    io: defaultSensorIo(),
    ...emptyHost,
  });
  assertEquals(capabilities.sensors.cpuTemperature, []);
  assertEquals(capabilities.sensors.cpuFan, []);
  assertEquals(capabilities.sensors.gpuDevices, []);
  assertEquals(capabilities.sensors.reasons?.diskTemperature, "no_hwmon");
  assertEquals(capabilities.storageMounts.docker, {
    probedPath: null,
    result: null,
    reason: "docker_absent",
  });
  assertEquals(capabilities.process, { probedPath: "/proc" });
  assertEquals(capabilities.networkInterfaces, [
    { name: "eth0", classification: "uplink" },
    { name: "lo", classification: "loopback" },
    { name: "tp0", classification: "fabric" },
    { name: "veth0", classification: "container-bridge" },
  ]);
});

it("collectMetricsCapabilities splits CPU vs system fans and shares ambient/disk pools", async () => {
  const capabilities = await collectMetricsCapabilities({
    sysRoot: fixtureRoot("sensors-fans-ambient"),
    io: defaultSensorIo(),
    ...emptyHost,
  });
  assertEquals(capabilities.sensors.cpuFan.length > 0, true);
  assertEquals(
    capabilities.sensors.systemFan1,
    capabilities.sensors.systemFan2,
  );
  assertEquals(
    capabilities.sensors.boardTemperature,
    capabilities.sensors.ambient1Temperature,
  );
  assertEquals(
    capabilities.sensors.ambient1Temperature,
    capabilities.sensors.ambient2Temperature,
  );
  assertEquals(
    capabilities.sensors.disk1Temperature,
    capabilities.sensors.disk2Temperature,
  );
  const cpuFan = capabilities.sensors.cpuFan[0];
  assertEquals(cpuFan?.reading?.unit, "rpm");
  assertEquals(cpuFan?.reading?.value, 1200);
});

it("collectMetricsCapabilities attaches GPU power readings and leaves RAPL CPU power unread", async () => {
  const capabilities = await collectMetricsCapabilities({
    sysRoot: fixtureRoot("sensors-amd"),
    io: defaultSensorIo(),
    ...emptyHost,
  });
  assertEquals(
    capabilities.sensors.cpuPower.every((c) => c.reading === null),
    true,
  );
  const gpu = capabilities.sensors.gpuDevices[0];
  assertEquals(gpu?.chip, "amdgpu");
  assertEquals(gpu?.power[0]?.reading?.unit, "watts");
  assertEquals(gpu?.power[0]?.reading?.value, 37);
  assertEquals(gpu?.temperature[0]?.reading?.unit, "celsius");
});

it("collectMetricsCapabilities reports path_not_found and proc_unreadable", async () => {
  const capabilities = await collectMetricsCapabilities({
    sysRoot: fixtureRoot("sensors-none"),
    io: defaultSensorIo(),
    ...emptyHost,
    resolveHostingPath: () => Promise.resolve("/mnt/missing-hosting"),
    pathExists: (path) => Promise.resolve(path !== "/mnt/missing-hosting"),
    countProcesses: () => Promise.resolve(null),
    procDir: "/missing-proc",
  });
  assertEquals(capabilities.storageMounts.hosting, {
    probedPath: "/mnt/missing-hosting",
    result: null,
    reason: "path_not_found",
  });
  assertEquals(capabilities.process, {
    probedPath: "/missing-proc",
    reason: "proc_unreadable",
  });
});

test("collectMetricsCapabilities fills hosting/system probes and mount candidates", async () => {
  const capabilities = await collectMetricsCapabilities({
    sysRoot: fixtureRoot("sensors-none"),
    io: defaultSensorIo(),
    ...emptyHost,
    probeStorage: (path) =>
      Promise.resolve({
        totalBytes: path === "/" ? 1000 : 2000,
        availableBytes: path === "/" ? 400 : 800,
      }),
    resolveHostingPath: () => Promise.resolve("/srv/users"),
    resolveDockerDataRoot: () => Promise.resolve("/var/lib/docker"),
  });
  assertEquals(capabilities.storageMounts.system, {
    path: "/",
    totalBytes: 1000,
    availableBytes: 400,
  });
  assertEquals(capabilities.storageMounts.hosting.result, {
    path: "/srv/users",
    totalBytes: 2000,
    availableBytes: 800,
  });
  assertEquals(
    capabilities.storageMounts.docker.result?.path,
    "/var/lib/docker",
  );
  assertEquals(capabilities.storageMounts.candidates[0]?.path, "/");
  assertEquals(capabilities.storageMounts.candidates[0]?.source, "/dev/sda2");
});
