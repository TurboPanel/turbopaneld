import { assertEquals, assertNotEquals } from "@std/assert";
import { computeSlotMapping } from "../../contracts/topology-slot-mapping.ts";
import {
  computeTopologyGeneration,
  MEMORY_TOTAL_TOLERANCE_BYTES,
  resolveTopologyGeneration,
  topologyGenerationPath,
} from "./generation.ts";
import {
  EMPTY_TOPOLOGY_OVERRIDES,
  type TopologySnapshotInputs,
} from "../../contracts/topology-types.ts";

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
    assertEquals(beforeMapping.normalNicSlots, afterMapping.normalNicSlots);
    assertEquals(afterMapping.normalNicSlots, ["mac:a"]);
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
      nicSlotDeviceIds: ["mac:b"],
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
    memoryTotalBytes: null,
    swapTotalBytes: null,
    cpuShape: {
      sockets: 1,
      coresPerSocket: 1,
      threadsPerSocket: 1,
      logicalCores: 0,
    },
  };
  assertEquals(computeTopologyGeneration(null, fingerprint), 0);
});

test("resolveTopologyGeneration never consults the capability plan", () => {
  const source = Deno.readTextFileSync(
    new URL("./generation.ts", import.meta.url),
  );
  assertEquals(source.includes("capability-plan"), false);
  assertEquals(source.includes("capabilityPlan"), false);
  assertEquals(source.includes("truncateSample"), false);
});

const GIB = 1024 * 1024 * 1024;

async function ticks(
  dir: string,
  readings: TopologySnapshotInputs[],
): Promise<number[]> {
  const out: number[] = [];
  for (const reading of readings) {
    // Ticks are sequential by nature: each reads the previous tick's state.
    out.push(
      await resolveTopologyGeneration(reading, EMPTY_TOPOLOGY_OVERRIDES, {
        daemonStateDir: dir,
      }),
    );
  }
  return out;
}

function sized(
  memoryTotalBytes: number | null,
  cores = 1,
): TopologySnapshotInputs {
  return inputs({
    memoryTotalBytes,
    swapTotalBytes: GIB,
    cpu: {
      sockets: 1,
      coresPerSocket: cores,
      threadsPerSocket: cores,
      model: null,
      cores: Array.from({ length: cores }, (_, i) => ({
        logicalIndex: i,
        coreId: `core:${i}`,
      })),
    },
  });
}

test("a RAM resize starts a new generation", async () => {
  await withTempStateDir(async (dir) => {
    assertEquals(await ticks(dir, [sized(GIB), sized(4 * GIB)]), [0, 1]);
  });
});

test("an identical reading keeps the generation", async () => {
  await withTempStateDir(async (dir) => {
    assertEquals(await ticks(dir, [sized(GIB), sized(GIB), sized(GIB)]), [
      0,
      0,
      0,
    ]);
  });
});

test("memory jitter below the tolerance keeps the generation, even drifting", async () => {
  await withTempStateDir(async (dir) => {
    const half = MEMORY_TOTAL_TOLERANCE_BYTES / 2;
    const gens = await ticks(dir, [
      sized(GIB),
      sized(GIB - 4096),
      sized(GIB + half),
      sized(GIB + 2 * half - 1),
      sized(GIB - half),
    ]);
    assertEquals(gens, [0, 0, 0, 0, 0]);
  });
});

test("memory change above the tolerance bumps once", async () => {
  await withTempStateDir(async (dir) => {
    const gens = await ticks(dir, [
      sized(GIB),
      sized(GIB + MEMORY_TOTAL_TOLERANCE_BYTES + 1),
      sized(GIB + MEMORY_TOTAL_TOLERANCE_BYTES + 1),
    ]);
    assertEquals(gens, [0, 1, 1]);
  });
});

test("a CPU core count change starts a new generation", async () => {
  await withTempStateDir(async (dir) => {
    assertEquals(await ticks(dir, [sized(GIB, 1), sized(GIB, 2)]), [0, 1]);
  });
});

test("a persisted record without the size fields bumps once, then settles", async () => {
  await withTempStateDir(async (dir) => {
    assertEquals(await ticks(dir, [sized(GIB)]), [0]);
    // Rewrite the file the way an older daemon stored it.
    const path = topologyGenerationPath(dir);
    const record = JSON.parse(await Deno.readTextFile(path));
    delete record.fingerprint.memoryTotalBytes;
    delete record.fingerprint.swapTotalBytes;
    delete record.fingerprint.cpuShape;
    await Deno.writeTextFile(path, JSON.stringify(record));
    assertEquals(await ticks(dir, [sized(GIB), sized(GIB), sized(GIB)]), [
      1,
      1,
      1,
    ]);
  });
});
