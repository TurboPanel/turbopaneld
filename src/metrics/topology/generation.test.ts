import { assertEquals, assertNotEquals } from "@std/assert";
import { computeSlotMapping } from "../../contracts/topology-slot-mapping.ts";
import {
  computeTopologyGeneration,
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

test("resolveTopologyGeneration: a filesystem changing size (a resize, or a dataset that fills) does not bump the generation", async () => {
  await withTempStateDir(async (daemonStateDir) => {
    const withSize = (totalBytes: number | null) =>
      inputs({
        filesystems: [
          {
            filesystemId: "fs:dev:/dev/sda1",
            mountpoint: "/",
            fsType: "ext4",
            sourceDevice: "/dev/sda1",
            totalBytes,
            totalInodes: totalBytes === null ? null : 6_000_000,
            roles: ["root"],
          },
        ],
      });
    const gens: number[] = [];
    for (
      const size of [null, 100_000_000_000, 120_000_000_000, 90_000_000_000]
    ) {
      gens.push(
        await resolveTopologyGeneration(
          withSize(size),
          EMPTY_TOPOLOGY_OVERRIDES,
          { daemonStateDir },
        ),
      );
    }
    assertEquals(gens, [0, 0, 0, 0]);
  });
});

test("computeTopologyGeneration: null previous state starts at 0", () => {
  const fingerprint = {
    networkDeviceIds: [],
    filesystemIds: [],
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

test("a RAM resize does not start a new generation", async () => {
  await withTempStateDir(async (dir) => {
    assertEquals(await ticks(dir, [sized(GIB), sized(4 * GIB)]), [0, 0]);
  });
});

test("a flood of different memory sizes cannot mint generations", async () => {
  await withTempStateDir(async (dir) => {
    const readings = Array.from(
      { length: 500 },
      (_, i) => sized(GIB + i * 64 * 1024 * 1024, 1 + (i % 7)),
    );
    const gens = await ticks(dir, readings);
    assertEquals(new Set(gens), new Set([0]));
  });
});

test("a CPU core count change does not start a new generation", async () => {
  await withTempStateDir(async (dir) => {
    assertEquals(await ticks(dir, [sized(GIB, 1), sized(GIB, 2)]), [0, 0]);
  });
});

test("a record stored by an earlier build (with size fields) keeps its generation", async () => {
  await withTempStateDir(async (dir) => {
    assertEquals(await ticks(dir, [sized(GIB)]), [0]);
    // Rewrite the file the way the earlier build stored it, size fields and all.
    const path = topologyGenerationPath(dir);
    const record = JSON.parse(await Deno.readTextFile(path));
    record.fingerprint.memoryTotalBytes = GIB;
    record.fingerprint.swapTotalBytes = GIB;
    record.fingerprint.filesystemCapacities = [];
    record.fingerprint.cpuShape = {
      sockets: 1,
      coresPerSocket: 1,
      threadsPerSocket: 1,
      logicalCores: 1,
    };
    await Deno.writeTextFile(path, JSON.stringify(record));
    assertEquals(await ticks(dir, [sized(2 * GIB), sized(2 * GIB)]), [0, 0]);
  });
});

test("an entity change still starts a new generation", async () => {
  await withTempStateDir(async (dir) => {
    const gens = await ticks(dir, [
      sized(GIB),
      inputs({
        ...sized(GIB),
        networks: [
          {
            deviceId: "mac:new",
            kind: "uplink",
            name: "eth9",
            identity: { mac: "new" },
          },
        ],
      }),
    ]);
    assertEquals(gens, [0, 1]);
  });
});
