import { assertEquals, assertNotEquals } from "@std/assert";
import type { TopologySnapshot } from "../../contracts/topology-types.ts";
import { topologyIdentityKey } from "./identity-key.ts";

const test = Deno.test.bind(Deno);

function snapshot(overrides: Partial<TopologySnapshot> = {}): TopologySnapshot {
  return {
    networks: [
      {
        deviceId: "mac:a",
        kind: "uplink",
        name: "eth0",
        identity: { mac: "a" },
      },
    ],
    filesystems: [],
    blockDevices: [],
    gpus: [],
    hardwareSignals: [],
    cpu: {
      sockets: 1,
      coresPerSocket: 1,
      threadsPerSocket: 1,
      model: null,
      cores: [],
    },
    numaNodes: [],
    memoryTotalBytes: null,
    swapTotalBytes: null,
    ...overrides,
  } as TopologySnapshot;
}

test("topologyIdentityKey: an interface rename (same deviceId) keeps the key", () => {
  const renamed = snapshot({
    networks: [
      {
        deviceId: "mac:a",
        kind: "uplink",
        name: "enp3s0",
        identity: { mac: "a" },
      },
    ],
  });
  assertEquals(topologyIdentityKey(renamed), topologyIdentityKey(snapshot()));
});

test("topologyIdentityKey: a new deviceId (hotplug) changes the key", () => {
  const added = snapshot({
    networks: [
      ...snapshot().networks,
      {
        deviceId: "mac:b",
        kind: "uplink",
        name: "eth1",
        identity: { mac: "b" },
      },
    ],
  });
  assertNotEquals(topologyIdentityKey(added), topologyIdentityKey(snapshot()));
});

test("topologyIdentityKey: the order the entities were discovered in does not matter", () => {
  const nic = (id: string) => ({
    deviceId: id,
    kind: "uplink" as const,
    name: id,
    identity: { mac: id },
  });
  assertEquals(
    topologyIdentityKey(snapshot({ networks: [nic("mac:a"), nic("mac:b")] })),
    topologyIdentityKey(snapshot({ networks: [nic("mac:b"), nic("mac:a")] })),
  );
});

test("topologyIdentityKey: sizes never change the key", () => {
  const resized = snapshot({
    memoryTotalBytes: 64 * 1024 ** 3,
    swapTotalBytes: 8 * 1024 ** 3,
    cpu: {
      sockets: 2,
      coresPerSocket: 8,
      threadsPerSocket: 16,
      model: null,
      cores: [],
    },
  });
  assertEquals(topologyIdentityKey(resized), topologyIdentityKey(snapshot()));
});

test("topologyIdentityKey never consults the capability plan", () => {
  const source = Deno.readTextFileSync(
    new URL("./identity-key.ts", import.meta.url),
  );
  assertEquals(source.includes("capability"), false);
});

const uplink = (id: string, defaultRoute?: boolean) => ({
  deviceId: id,
  kind: "uplink" as const,
  name: id,
  identity: { mac: id },
  ...(defaultRoute ? { defaultRoute } : {}),
});

const fs = (
  id: string,
  roles: TopologySnapshot["filesystems"][number]["roles"],
) => ({
  filesystemId: id,
  mountpoint: `/${id}`,
  fsType: "ext4",
  sourceDevice: id,
  totalBytes: null,
  totalInodes: null,
  roles,
});

test("topologyIdentityKey: the default route moving between uplinks changes the key", () => {
  const onA = snapshot({ networks: [uplink("mac:a", true), uplink("mac:b")] });
  const onB = snapshot({ networks: [uplink("mac:a"), uplink("mac:b", true)] });
  assertNotEquals(topologyIdentityKey(onA), topologyIdentityKey(onB));
});

test("topologyIdentityKey: a NIC changing kind changes the key", () => {
  const asUplink = snapshot({ networks: [uplink("mac:a")] });
  const asFabric = snapshot({
    networks: [{ ...uplink("mac:a"), kind: "fabric" as const }],
  });
  assertNotEquals(topologyIdentityKey(asUplink), topologyIdentityKey(asFabric));
});

test("topologyIdentityKey: a filesystem role change changes the key, including a hosting role move", () => {
  const before = snapshot({
    filesystems: [fs("fs:a", ["root", "hosting"]), fs("fs:b", ["docker"])],
  });
  const moved = snapshot({
    filesystems: [fs("fs:a", ["root"]), fs("fs:b", ["docker", "hosting"])],
  });
  assertNotEquals(topologyIdentityKey(before), topologyIdentityKey(moved));
  // Role order alone is not a change.
  const reordered = snapshot({
    filesystems: [fs("fs:a", ["hosting", "root"]), fs("fs:b", ["docker"])],
  });
  assertEquals(topologyIdentityKey(before), topologyIdentityKey(reordered));
});

test("topologyIdentityKey: a block-device change changes the key, service or not", () => {
  const dev = (
    id: string,
    deviceType: "physical" | "virtual" | "partition",
    isServiceDevice: boolean,
  ) => ({ deviceId: id, kernelName: id, deviceType, isServiceDevice });
  const base = snapshot({ blockDevices: [dev("blk:a", "physical", true)] });
  const added = snapshot({
    blockDevices: [
      dev("blk:a", "physical", true),
      dev("blk:b", "physical", false),
    ],
  });
  const retyped = snapshot({ blockDevices: [dev("blk:a", "virtual", true)] });
  assertNotEquals(topologyIdentityKey(base), topologyIdentityKey(added));
  assertNotEquals(topologyIdentityKey(base), topologyIdentityKey(retyped));
});
