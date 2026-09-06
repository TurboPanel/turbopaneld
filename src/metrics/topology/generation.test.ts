import { assertEquals, assertNotEquals } from "@std/assert";
import { computeSlotMapping } from "./slot-mapping.ts";
import {
  computeTopologyGeneration,
  resolveTopologyGeneration,
} from "./generation.ts";
import {
  EMPTY_TOPOLOGY_OVERRIDES,
  type TopologySnapshotInputs,
} from "./types.ts";

const test = Deno.test.bind(Deno);

function inputs(
  overrides: Partial<TopologySnapshotInputs> = {},
): TopologySnapshotInputs {
  return {
    bootGeneration: 0,
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
  };
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

test("resolveTopologyGeneration: first tick starts at generation 0", async () => {
  await withTempStateDir(async (daemonStateDir) => {
    const generation = await resolveTopologyGeneration(
      inputs(),
      EMPTY_TOPOLOGY_OVERRIDES,
      {
        daemonStateDir,
      },
    );
    assertEquals(generation, 0);
  });
});

test("resolveTopologyGeneration: an interface rename (same deviceId, different name) does not bump the generation", async () => {
  await withTempStateDir(async (daemonStateDir) => {
    const first = await resolveTopologyGeneration(
      inputs(),
      EMPTY_TOPOLOGY_OVERRIDES,
      {
        daemonStateDir,
      },
    );
    const renamed = inputs({
      networks: [
        {
          deviceId: "mac:a",
          kind: "uplink",
          name: "eth1",
          identity: { mac: "a" },
        },
      ],
    });
    const second = await resolveTopologyGeneration(
      renamed,
      EMPTY_TOPOLOGY_OVERRIDES,
      {
        daemonStateDir,
      },
    );
    assertEquals(first, 0);
    assertEquals(second, 0);
  });
});

test("resolveTopologyGeneration: a new deviceId appearing (hotplug) bumps the generation", async () => {
  await withTempStateDir(async (daemonStateDir) => {
    const first = await resolveTopologyGeneration(
      inputs(),
      EMPTY_TOPOLOGY_OVERRIDES,
      {
        daemonStateDir,
      },
    );
    const withNewNic = inputs({
      networks: [
        {
          deviceId: "mac:a",
          kind: "uplink",
          name: "eth0",
          identity: { mac: "a" },
        },
        {
          deviceId: "mac:b",
          kind: "uplink",
          name: "eth1",
          identity: { mac: "b" },
        },
      ],
    });
    const second = await resolveTopologyGeneration(
      withNewNic,
      EMPTY_TOPOLOGY_OVERRIDES,
      {
        daemonStateDir,
      },
    );
    assertEquals(first, 0);
    assertEquals(second, 1);
  });
});

test("resolveTopologyGeneration: NIC1/NIC2 slot mapping stays pinned to deviceId across a rename", async () => {
  await withTempStateDir(async (daemonStateDir) => {
    const before = inputs();
    await resolveTopologyGeneration(before, EMPTY_TOPOLOGY_OVERRIDES, {
      daemonStateDir,
    });
    const beforeMapping = computeSlotMapping(
      { ...before, generation: 0 },
      EMPTY_TOPOLOGY_OVERRIDES,
    );

    const renamed = inputs({
      networks: [
        {
          deviceId: "mac:a",
          kind: "uplink",
          name: "eth9",
          identity: { mac: "a" },
        },
      ],
    });
    const generation = await resolveTopologyGeneration(
      renamed,
      EMPTY_TOPOLOGY_OVERRIDES,
      {
        daemonStateDir,
      },
    );
    const afterMapping = computeSlotMapping(
      { ...renamed, generation },
      EMPTY_TOPOLOGY_OVERRIDES,
    );

    assertEquals(generation, 0);
    assertEquals(beforeMapping.normalNicSlot1, afterMapping.normalNicSlot1);
    assertEquals(afterMapping.normalNicSlot1, "mac:a");
  });
});

test("resolveTopologyGeneration: an operator override reassigning a slot bumps the generation even with no identity-set change", async () => {
  await withTempStateDir(async (daemonStateDir) => {
    const twoNics = inputs({
      networks: [
        {
          deviceId: "mac:a",
          kind: "uplink",
          name: "eth0",
          identity: { mac: "a" },
        },
        {
          deviceId: "mac:b",
          kind: "uplink",
          name: "eth1",
          identity: { mac: "b" },
        },
      ],
    });
    const first = await resolveTopologyGeneration(
      twoNics,
      EMPTY_TOPOLOGY_OVERRIDES,
      {
        daemonStateDir,
      },
    );
    const second = await resolveTopologyGeneration(twoNics, {
      ...EMPTY_TOPOLOGY_OVERRIDES,
      nicSlot1DeviceId: "mac:b",
    }, { daemonStateDir });
    assertEquals(first, 0);
    assertNotEquals(second, first);
  });
});

test("resolveTopologyGeneration: filesystem totalBytes going from null to a finite value bumps the generation", async () => {
  await withTempStateDir(async (daemonStateDir) => {
    const unknownCapacity = inputs({
      filesystems: [
        {
          filesystemId: "fs:dev:/dev/sda1",
          mountpoint: "/",
          fsType: "ext4",
          sourceDevice: "/dev/sda1",
          totalBytes: null,
          totalInodes: null,
          roles: ["root"],
        },
      ],
    });
    const first = await resolveTopologyGeneration(
      unknownCapacity,
      EMPTY_TOPOLOGY_OVERRIDES,
      { daemonStateDir },
    );
    const knownCapacity = inputs({
      filesystems: [
        {
          filesystemId: "fs:dev:/dev/sda1",
          mountpoint: "/",
          fsType: "ext4",
          sourceDevice: "/dev/sda1",
          totalBytes: 100_000_000_000,
          totalInodes: 6_000_000,
          roles: ["root"],
        },
      ],
    });
    const second = await resolveTopologyGeneration(
      knownCapacity,
      EMPTY_TOPOLOGY_OVERRIDES,
      { daemonStateDir },
    );
    assertEquals(first, 0);
    assertEquals(second, 1);
  });
});

test("computeTopologyGeneration: null previous state starts at 0", () => {
  const fingerprint = {
    networkDeviceIds: [],
    filesystemIds: [],
    filesystemCapacities: [],
    serviceBlockDeviceIds: [],
    gpuIds: [],
    hardwareSignalIds: [],
    slotMapping: computeSlotMapping(
      { ...inputs(), generation: 0 },
      EMPTY_TOPOLOGY_OVERRIDES,
    ),
  };
  assertEquals(computeTopologyGeneration(null, fingerprint), 0);
});
