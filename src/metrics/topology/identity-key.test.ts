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
