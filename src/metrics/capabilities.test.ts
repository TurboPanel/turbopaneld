import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import { fromFileUrl } from "@std/path";
import { collectMetricsCapabilities } from "./capabilities.ts";
import { defaultSensorIo, discoverSensors } from "./collector/sensors/index.ts";
import type { StatfsResult } from "./collector/types.ts";

function fixture(name: string): string {
  return Deno.readTextFileSync(
    new URL(`./collector/testdata/${name}`, import.meta.url),
  );
}

function fixtureRoot(name: string): string {
  return fromFileUrl(new URL(`./collector/testdata/${name}`, import.meta.url));
}

const STATFS_BY_PATH: Record<string, StatfsResult> = {
  "/": { blocks: 1_000_000, bfree: 400_000, bavail: 350_000, bsize: 4096 },
  "/srv/users": {
    blocks: 500_000,
    bfree: 200_000,
    bavail: 150_000,
    bsize: 4096,
  },
  "/var/lib/docker": {
    blocks: 250_000,
    bfree: 100_000,
    bavail: 50_000,
    bsize: 4096,
  },
};

it("collectMetricsCapabilities reuses the collector's building blocks", async () => {
  const capabilities = await collectMetricsCapabilities({
    readProcFile: (path) => {
      if (path === "/proc/net/dev") {
        return fixture("proc-net-dev-with-fabric-tunnel.txt");
      }
      if (path === "/proc/mounts") return fixture("proc-mounts.txt");
      return undefined;
    },
    statfs: (path) => STATFS_BY_PATH[path] ?? null,
    resolveDockerDataRoot: () => Promise.resolve("/var/lib/docker"),
    resolveHostingPath: () => "/srv/users",
    resolveFabricInterfaces: () => Promise.resolve(["tp0"]),
    discoverSensors: () =>
      discoverSensors(fixtureRoot("sensors-amd"), defaultSensorIo()),
  });

  assertEquals(
    capabilities.sensors.cpuTemperature.map((c) => `${c.chip}:${c.label}`),
    ["k10temp:Tctl"],
  );
  assertEquals(capabilities.sensors.cpuTemperature[0].reading, {
    value: 52.25,
    unit: "celsius",
  });
  // No fan candidates in this fixture — the CPU/system fan split and the
  // (empty) flattened gpuFan pool all resolve to empty arrays, not a crash.
  assertEquals(capabilities.sensors.cpuFan, []);
  assertEquals(capabilities.sensors.systemFan1, []);
  assertEquals(capabilities.sensors.gpuFan, []);

  // GPU candidates are grouped per device, not flattened to a bare pool —
  // temperature/power readings ride along on each candidate.
  assertEquals(capabilities.sensors.gpuDevices.length, 1);
  const [gpu] = capabilities.sensors.gpuDevices;
  assertEquals(gpu.chip, "amdgpu");
  assertEquals(
    gpu.temperature.map((c) => `${c.chip}:${c.label}`),
    ["amdgpu:edge", "amdgpu:junction"],
  );
  assertEquals(
    gpu.temperature.find((c) => c.label === "edge")?.reading,
    { value: 61, unit: "celsius" },
  );
  assertEquals(gpu.power.map((c) => `${c.chip}:${c.label}`), ["amdgpu:PPT"]);
  assertEquals(gpu.power[0].reading, { value: 37, unit: "watts" });

  assertEquals(capabilities.storageMounts.system?.path, "/");
  assertEquals(
    capabilities.storageMounts.system?.availableBytes,
    350_000 * 4096,
  );
  assertEquals(capabilities.storageMounts.hosting.probedPath, "/srv/users");
  assertEquals(capabilities.storageMounts.hosting.result?.path, "/srv/users");
  assertEquals(capabilities.storageMounts.hosting.reason, undefined);
  assertEquals(
    capabilities.storageMounts.docker.probedPath,
    "/var/lib/docker",
  );
  assertEquals(
    capabilities.storageMounts.docker.result?.path,
    "/var/lib/docker",
  );
  assertEquals(
    capabilities.storageMounts.docker.result?.availableBytes,
    50_000 * 4096,
  );
  assertEquals(capabilities.storageMounts.docker.reason, undefined);

  // Mount-table candidates: block-backed mounts only, probed for capacity;
  // /mnt/docker-data has no statfs answer here and drops out.
  assertEquals(
    capabilities.storageMounts.candidates.map((c) => ({
      path: c.path,
      source: c.source,
      fsType: c.fsType,
    })),
    [
      { path: "/", source: "/dev/sda1", fsType: "ext4" },
      { path: "/srv/users", source: "/dev/sdb1", fsType: "xfs" },
      { path: "/var/lib/docker", source: "/dev/sda1", fsType: "ext4" },
    ],
  );
  assertEquals(
    capabilities.storageMounts.candidates[0].totalBytes,
    1_000_000 * 4096,
  );
  assertEquals(
    capabilities.storageMounts.candidates[0].availableBytes,
    350_000 * 4096,
  );

  assertEquals(capabilities.networkInterfaces, [
    { name: "docker0", classification: "container-bridge" },
    { name: "eth0", classification: "uplink" },
    { name: "lo", classification: "loopback" },
    { name: "tp0", classification: "fabric" },
    { name: "veth123", classification: "container-bridge" },
  ]);

  // countProcesses defaults to countProcessesInProc("/proc") — not stubbed
  // here, so it runs for real against this host's own /proc.
  assertEquals(capabilities.process.probedPath, "/proc");
});

it("collectMetricsCapabilities splits the fan pool and shares the ambient pool across board/ambient1/ambient2, with readings on every candidate", async () => {
  const capabilities = await collectMetricsCapabilities({
    readProcFile: () => undefined,
    statfs: () => null,
    resolveDockerDataRoot: () => Promise.resolve(null),
    resolveHostingPath: () => "/srv/users",
    resolveFabricInterfaces: () => Promise.resolve([]),
    discoverSensors: () =>
      discoverSensors(fixtureRoot("sensors-fans-ambient"), defaultSensorIo()),
    countProcesses: () => null,
  });

  assertEquals(
    capabilities.sensors.cpuFan.map((c) => `${c.chip}:${c.label}`),
    ["coretemp:cpu_fan"],
  );
  assertEquals(capabilities.sensors.cpuFan[0].reading, {
    value: 1200,
    unit: "rpm",
  });

  const systemFanIds = capabilities.sensors.systemFan1.map((c) =>
    `${c.chip}:${c.label}`
  );
  assertEquals(systemFanIds, ["nct6775:sys_fan1", "nct6775:sys_fan2"]);
  // systemFan1/systemFan2 share the same candidate pool — either slot may
  // be assigned to either candidate.
  assertEquals(
    capabilities.sensors.systemFan2.map((c) => `${c.chip}:${c.label}`),
    systemFanIds,
  );

  const ambientIds = capabilities.sensors.ambient1Temperature.map((c) =>
    `${c.chip}:${c.label}`
  );
  assertEquals(ambientIds, ["nct6775:SYSTIN", "nct6775:AUXTIN"]);
  assertEquals(
    capabilities.sensors.ambient2Temperature.map((c) => `${c.chip}:${c.label}`),
    ambientIds,
  );
  assertEquals(
    capabilities.sensors.boardTemperature.map((c) => `${c.chip}:${c.label}`),
    ambientIds,
  );

  // This host has hwmon entries and a SATA block device (fixture's
  // `block/sda`) but no drivetemp chip — the opt-in reason, not "no_hwmon".
  assertEquals(capabilities.sensors.disk1Temperature, []);
  assertEquals(capabilities.sensors.disk2Temperature, []);
  assertEquals(capabilities.sensors.reasons, {
    diskTemperature: "drivetemp_not_loaded",
  });
});

it("collectMetricsCapabilities flattens gpuFan across every discovered GPU device", async () => {
  const capabilities = await collectMetricsCapabilities({
    readProcFile: () => undefined,
    statfs: () => null,
    resolveDockerDataRoot: () => Promise.resolve(null),
    resolveHostingPath: () => "/srv/users",
    resolveFabricInterfaces: () => Promise.resolve([]),
    discoverSensors: () =>
      discoverSensors(fixtureRoot("sensors-gpu-fan"), defaultSensorIo()),
    countProcesses: () => null,
  });

  assertEquals(capabilities.sensors.gpuDevices.length, 1);
  const [gpu] = capabilities.sensors.gpuDevices;
  assertEquals(gpu.fan.map((c) => `${c.chip}:${c.label}`), ["amdgpu:fan1"]);
  // gpuFan is the flattened pool the picker reads from directly.
  assertEquals(capabilities.sensors.gpuFan, gpu.fan);
  assertEquals(gpu.fan[0].reading, { value: 1800, unit: "rpm" });
});

it("collectMetricsCapabilities surfaces the no_hwmon reason on a VM-shaped host", async () => {
  const capabilities = await collectMetricsCapabilities({
    readProcFile: () => undefined,
    statfs: () => null,
    resolveDockerDataRoot: () => Promise.resolve(null),
    resolveHostingPath: () => "/srv/users",
    resolveFabricInterfaces: () => Promise.resolve([]),
    discoverSensors: () =>
      discoverSensors(fixtureRoot("sensors-none"), defaultSensorIo()),
    countProcesses: () => null,
  });

  assertEquals(capabilities.sensors.disk1Temperature, []);
  assertEquals(capabilities.sensors.reasons, { diskTemperature: "no_hwmon" });
});

it("collectMetricsCapabilities degrades to empty results on a bare host", async () => {
  const capabilities = await collectMetricsCapabilities({
    readProcFile: () => undefined,
    statfs: () => null,
    resolveDockerDataRoot: () => Promise.resolve(null),
    resolveHostingPath: () => "/srv/users",
    resolveFabricInterfaces: () => Promise.reject(new Error("fabric boom")),
    discoverSensors: () =>
      discoverSensors(fixtureRoot("sensors-none"), defaultSensorIo()),
    countProcesses: () => null,
  });

  assertEquals(capabilities.sensors.cpuTemperature, []);
  assertEquals(capabilities.storageMounts.system, null);
  assertEquals(capabilities.storageMounts.candidates, []);
  assertEquals(capabilities.networkInterfaces, []);

  // A resolved-but-unprobeable hosting path vs. an absent Docker root are
  // distinguishable reasons — and the probed path survives either way,
  // instead of collapsing to a bare null.
  assertEquals(capabilities.storageMounts.hosting, {
    probedPath: "/srv/users",
    result: null,
    reason: "statfs_unsupported",
  });
  assertEquals(capabilities.storageMounts.docker, {
    probedPath: null,
    result: null,
    reason: "docker_absent",
  });

  // /proc unreadable: the process chart's blank state now has a reason.
  assertEquals(capabilities.process, {
    probedPath: "/proc",
    reason: "proc_unreadable",
  });
});

it("collectMetricsCapabilities tolerates a throwing hosting-path resolver", async () => {
  const capabilities = await collectMetricsCapabilities({
    readProcFile: () => undefined,
    statfs: () => null,
    resolveDockerDataRoot: () => Promise.resolve(null),
    resolveHostingPath: () => Promise.reject(new Error("hosting boom")),
    resolveFabricInterfaces: () => Promise.resolve([]),
    discoverSensors: () =>
      discoverSensors(fixtureRoot("sensors-none"), defaultSensorIo()),
    countProcesses: () => Promise.reject(new Error("proc boom")),
  });
  // The resolver never produced a path at all, distinct from a resolved
  // path that just couldn't be statfs'd.
  assertEquals(capabilities.storageMounts.hosting, {
    probedPath: null,
    result: null,
    reason: "path_not_found",
  });
  // A throwing countProcesses degrades the same way a null result does.
  assertEquals(capabilities.process, {
    probedPath: "/proc",
    reason: "proc_unreadable",
  });
});

it("collectMetricsCapabilities reports the process probe path with no reason when counting succeeds", async () => {
  const capabilities = await collectMetricsCapabilities({
    readProcFile: () => undefined,
    statfs: () => null,
    resolveDockerDataRoot: () => Promise.resolve(null),
    resolveHostingPath: () => "/srv/users",
    resolveFabricInterfaces: () => Promise.resolve([]),
    discoverSensors: () =>
      discoverSensors(fixtureRoot("sensors-none"), defaultSensorIo()),
    countProcesses: () => 128,
  });
  assertEquals(capabilities.process, { probedPath: "/proc" });
});
