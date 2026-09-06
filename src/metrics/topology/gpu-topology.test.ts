import { assertEquals } from "@std/assert";
import { collectGpuTopology } from "./gpu-topology.ts";
import { fnv1aHex, type IdentityIo } from "./identity.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function memoryIo(
  files: Record<string, string | undefined>,
  dirs: Record<string, string[]>,
): IdentityIo {
  return {
    listDir: (path) => dirs[path] ?? [],
    readFile: (path) => files[path],
  };
}

test("collectGpuTopology: DRM cards take PCI identity and map known vendor ids", async () => {
  const root = "/sys";
  const gpus = await collectGpuTopology({
    sysRoot: root,
    io: memoryIo({
      [`${root}/class/drm/card0/device/vendor`]: "0x10de\n",
      [`${root}/class/drm/card0/device/uevent`]:
        "DRIVER=nvidia\nPCI_SLOT_NAME=0000:01:00.0\n",
      [`${root}/class/drm/card1/device/vendor`]: "8086\n",
      [`${root}/class/drm/card1/device/uevent`]:
        "DRIVER=i915\nPCI_SLOT_NAME=0000:00:02.0\n",
      [`${root}/class/drm/card2/device/vendor`]: "0x1002\n",
      [`${root}/class/drm/card2/device/uevent`]:
        "DRIVER=amdgpu\nPCI_SLOT_NAME=0000:03:00.0\n",
    }, {
      [`${root}/class/drm`]: [
        "card0",
        "card1",
        "card2",
        "renderD128",
        "version",
      ],
      [`${root}/class/hwmon`]: [],
    }),
  });

  assertEquals(gpus, [
    {
      gpuId: "pci:0000:00:02.0",
      kind: "drm",
      pciPath: "0000:00:02.0",
      vendor: "intel",
      chip: "i915",
    },
    {
      gpuId: "pci:0000:01:00.0",
      kind: "drm",
      pciPath: "0000:01:00.0",
      vendor: "nvidia",
      chip: "nvidia",
    },
    {
      gpuId: "pci:0000:03:00.0",
      kind: "drm",
      pciPath: "0000:03:00.0",
      vendor: "amd",
      chip: "amdgpu",
    },
  ]);
});

test("collectGpuTopology: a DRM card without a vendor id is skipped", async () => {
  const root = "/fixture";
  const gpus = await collectGpuTopology({
    sysRoot: root,
    io: memoryIo({
      [`${root}/class/drm/card0/device/vendor`]: "  \n",
      [`${root}/class/drm/card0/device/uevent`]: "DRIVER=nvidia\n",
    }, {
      [`${root}/class/drm`]: ["card0"],
      [`${root}/class/hwmon`]: [],
    }),
  });
  assertEquals(gpus, []);
});

test("collectGpuTopology: a DRM card without PCI falls back to a drm: hash and unknown chip", async () => {
  const root = "/fixture";
  const gpus = await collectGpuTopology({
    sysRoot: root,
    io: memoryIo({
      [`${root}/class/drm/card9/device/vendor`]: "0x1234\n",
    }, {
      [`${root}/class/drm`]: ["card9"],
      [`${root}/class/hwmon`]: [],
    }),
  });
  assertEquals(gpus, [{
    gpuId: `drm:${fnv1aHex("card9:unknown")}`,
    kind: "drm",
    pciPath: "",
    vendor: "0x1234",
    chip: "unknown",
  }]);
});

test("collectGpuTopology: hwmon GPU chips not already enumerated via DRM are appended as sysfs", async () => {
  const root = "/fixture";
  const gpus = await collectGpuTopology({
    sysRoot: root,
    io: memoryIo({
      [`${root}/class/hwmon/hwmon0/name`]: "coretemp\n",
      [`${root}/class/hwmon/hwmon1/name`]: "amdgpu\n",
      [`${root}/class/hwmon/hwmon1/device/vendor`]: "0x1002\n",
      [`${root}/class/hwmon/hwmon1/device/uevent`]:
        "DRIVER=amdgpu\nPCI_SLOT_NAME=0000:04:00.0\n",
      [`${root}/class/hwmon/hwmon2/name`]: "  \n",
    }, {
      [`${root}/class/drm`]: [],
      [`${root}/class/hwmon`]: ["hwmon0", "hwmon1", "hwmon2"],
    }),
  });
  assertEquals(gpus, [{
    gpuId: "pci:0000:04:00.0",
    kind: "sysfs",
    pciPath: "0000:04:00.0",
    vendor: "amd",
    chip: "amdgpu",
  }]);
});

test("collectGpuTopology: a hwmon chip that shares a DRM PCI id is not double-counted", async () => {
  const root = "/fixture";
  const gpus = await collectGpuTopology({
    sysRoot: root,
    io: memoryIo({
      [`${root}/class/drm/card0/device/vendor`]: "0x10de\n",
      [`${root}/class/drm/card0/device/uevent`]:
        "DRIVER=nvidia\nPCI_SLOT_NAME=0000:01:00.0\n",
      [`${root}/class/hwmon/hwmon3/name`]: "nouveau\n",
      [`${root}/class/hwmon/hwmon3/device/vendor`]: "0x10de\n",
      [`${root}/class/hwmon/hwmon3/device/uevent`]:
        "DRIVER=nouveau\nPCI_SLOT_NAME=0000:01:00.0\n",
    }, {
      [`${root}/class/drm`]: ["card0"],
      [`${root}/class/hwmon`]: ["hwmon3"],
    }),
  });
  assertEquals(gpus.length, 1);
  assertEquals(gpus[0].kind, "drm");
  assertEquals(gpus[0].gpuId, "pci:0000:01:00.0");
});

test("collectGpuTopology: two hwmon chips that collapse onto one gpuId keep only the first", async () => {
  const root = "/fixture";
  const gpus = await collectGpuTopology({
    sysRoot: root,
    io: memoryIo({
      [`${root}/class/hwmon/hwmon1/name`]: "amdgpu\n",
      [`${root}/class/hwmon/hwmon1/device/uevent`]:
        "PCI_SLOT_NAME=0000:08:00.0\n",
      [`${root}/class/hwmon/hwmon2/name`]: "radeon\n",
      [`${root}/class/hwmon/hwmon2/device/uevent`]:
        "PCI_SLOT_NAME=0000:08:00.0\n",
    }, {
      [`${root}/class/drm`]: [],
      [`${root}/class/hwmon`]: ["hwmon1", "hwmon2"],
    }),
  });
  assertEquals(gpus, [{
    gpuId: "pci:0000:08:00.0",
    kind: "sysfs",
    pciPath: "0000:08:00.0",
    vendor: "amdgpu",
    chip: "amdgpu",
  }]);
});

test("collectGpuTopology: a PCI-less hwmon GPU hashes as hwmon: and uses the chip as vendor when vendor is missing", async () => {
  const root = "/fixture";
  const gpus = await collectGpuTopology({
    sysRoot: root,
    io: memoryIo({
      [`${root}/class/hwmon/hwmon7/name`]: "i915\n",
    }, {
      [`${root}/class/drm`]: [],
      [`${root}/class/hwmon`]: ["hwmon7"],
    }),
  });
  assertEquals(gpus, [{
    gpuId: `hwmon:${fnv1aHex("hwmon7:i915")}`,
    kind: "sysfs",
    pciPath: "",
    vendor: "i915",
    chip: "i915",
  }]);
});

test("collectGpuTopology: defaults sysRoot to /sys when omitted", async () => {
  const listed: string[] = [];
  const gpus = await collectGpuTopology({
    io: {
      listDir: (path) => {
        listed.push(path);
        return [];
      },
      readFile: () => undefined,
    },
  });
  assertEquals(gpus, []);
  assertEquals(listed.includes("/sys/class/drm"), true);
  assertEquals(listed.includes("/sys/class/hwmon"), true);
});
