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
  assertEquals(
    capabilities.sensors.gpuPower.map((c) => `${c.chip}:${c.label}`),
    ["amdgpu:PPT"],
  );

  assertEquals(capabilities.storageMounts.system?.path, "/");
  assertEquals(
    capabilities.storageMounts.system?.availableBytes,
    350_000 * 4096,
  );
  assertEquals(capabilities.storageMounts.hosting?.path, "/srv/users");
  assertEquals(capabilities.storageMounts.docker?.path, "/var/lib/docker");
  assertEquals(
    capabilities.storageMounts.docker?.availableBytes,
    50_000 * 4096,
  );

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
  });

  assertEquals(capabilities.sensors.cpuTemperature, []);
  assertEquals(capabilities.storageMounts.system, null);
  assertEquals(capabilities.storageMounts.hosting, null);
  assertEquals(capabilities.storageMounts.docker, null);
  assertEquals(capabilities.storageMounts.candidates, []);
  assertEquals(capabilities.networkInterfaces, []);
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
  });
  assertEquals(capabilities.storageMounts.hosting, null);
});
