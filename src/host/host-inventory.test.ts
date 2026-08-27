import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  advertisedMhzFromModelName,
  countCpuSockets,
  countCpuThreads,
  countPhysicalCpuCores,
  hostResourcesFromProc,
  normalizePciSlot,
  parseCpulist,
  parseMeminfoTotals,
  parseNvidiaSmiMemoryCsv,
  parseSizeToBytes,
  parseUeventMap,
  readCpuModelName,
  readHostResources,
  resetHostResourcesCacheForTests,
  stripPciHexPrefix,
} from "./host-inventory.ts";

function writeFile(path: string, contents: string): void {
  Deno.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  Deno.writeTextFileSync(path, contents);
}

function buildFixtureRoots(): {
  procRoot: string;
  sysRoot: string;
  root: string;
} {
  const root = Deno.makeTempDirSync({ prefix: "tp-host-inventory-" });
  const procRoot = `${root}/proc`;
  const sysRoot = `${root}/sys`;

  writeFile(
    `${procRoot}/stat`,
    [
      "cpu  10 0 0 0 0 0 0 0",
      "cpu0 5 0 0 0 0 0 0 0",
      "cpu1 5 0 0 0 0 0 0 0",
      "",
    ].join("\n"),
  );
  writeFile(
    `${procRoot}/meminfo`,
    "MemTotal:       2097152 kB\nSwapTotal:      1048576 kB\n",
  );
  writeFile(
    `${procRoot}/cpuinfo`,
    [
      "processor\t: 0",
      "vendor_id\t: GenuineIntel",
      "model name\t: Fixture CPU @ 3.20GHz",
      "physical id\t: 0",
      "core id\t\t: 0",
      "cpu cores\t: 2",
      "",
      "processor\t: 1",
      "vendor_id\t: GenuineIntel",
      "model name\t: Fixture CPU @ 3.20GHz",
      "physical id\t: 0",
      "core id\t\t: 1",
      "cpu cores\t: 2",
      "",
    ].join("\n"),
  );

  writeFile(`${sysRoot}/devices/cpu_core/cpus`, "0\n");
  writeFile(`${sysRoot}/devices/cpu_atom/cpus`, "1\n");
  writeFile(`${sysRoot}/devices/cpu_lowpower/cpus`, "\n");

  const cpu0 = `${sysRoot}/devices/system/cpu/cpu0`;
  writeFile(`${cpu0}/cache/index0/level`, "1\n");
  writeFile(`${cpu0}/cache/index0/type`, "Data\n");
  writeFile(`${cpu0}/cache/index0/size`, "48K\n");
  writeFile(`${cpu0}/cache/index1/level`, "1\n");
  writeFile(`${cpu0}/cache/index1/type`, "Instruction\n");
  writeFile(`${cpu0}/cache/index1/size`, "32K\n");
  writeFile(`${cpu0}/cache/index2/level`, "2\n");
  writeFile(`${cpu0}/cache/index2/type`, "Unified\n");
  writeFile(`${cpu0}/cache/index2/size`, "2M\n");
  writeFile(`${cpu0}/cache/index3/level`, "3\n");
  writeFile(`${cpu0}/cache/index3/type`, "Unified\n");
  writeFile(`${cpu0}/cache/index3/size`, "16M\n");
  writeFile(`${cpu0}/cache/index4/level`, "4\n");
  writeFile(`${cpu0}/cache/index4/type`, "Unified\n");
  writeFile(`${cpu0}/cache/index4/size`, "128M\n");
  // Unified L1 (applyCacheIndex level===1 without data/instruction)
  writeFile(`${cpu0}/cache/index5/level`, "1\n");
  writeFile(`${cpu0}/cache/index5/type`, "Unified\n");
  writeFile(`${cpu0}/cache/index5/size`, "64K\n");
  writeFile(`${cpu0}/cpufreq/base_frequency`, "3200000\n");
  writeFile(`${cpu0}/cpufreq/cpuinfo_max_freq`, "4800000\n");

  const card0 = `${sysRoot}/class/drm/card0/device`;
  writeFile(`${card0}/vendor`, "0x10de\n");
  writeFile(`${card0}/device`, "0x2d04\n");
  writeFile(
    `${card0}/uevent`,
    "DRIVER=nvidia\nPCI_SLOT_NAME=0000:01:00.0\n",
  );
  writeFile(
    `${procRoot}/driver/nvidia/gpus/0000:01:00.0/information`,
    "Model: NVIDIA GeForce RTX Fixture\nIRQ:  16\n",
  );

  const card1 = `${sysRoot}/class/drm/card1/device`;
  writeFile(`${card1}/vendor`, "0x1002\n");
  writeFile(`${card1}/device`, "0x73ff\n");
  writeFile(
    `${card1}/uevent`,
    "DRIVER=amdgpu\nPCI_SLOT_NAME=0000:02:00.0\n",
  );
  writeFile(`${card1}/marketing_name`, "Fixture Radeon\n");
  writeFile(`${card1}/mem_info_vram_total`, "8589934592\n");

  Deno.mkdirSync(`${sysRoot}/class/drm/card2/device`, { recursive: true });
  Deno.mkdirSync(`${sysRoot}/class/drm/renderD128`, { recursive: true });

  const card3 = `${sysRoot}/class/drm/card3/device`;
  writeFile(`${card3}/vendor`, "0x10de\n");
  writeFile(`${card3}/device`, "0x1234\n");
  writeFile(
    `${card3}/uevent`,
    "DRIVER=nvidia\nPCI_SLOT_NAME=00000000:03:00.0\n",
  );
  writeFile(`${card3}/product_name`, "Fixture Product GPU\n");

  return { procRoot, sysRoot, root };
}

describe("host-inventory", () => {
  it("countCpuThreads counts online cpuN lines only", () => {
    const text = [
      "cpu  10 0 0 0 0 0 0 0",
      "cpu0 5 0 0 0 0 0 0 0",
      "cpu1 5 0 0 0 0 0 0 0",
      "intr 0",
    ].join("\n");
    assertEquals(countCpuThreads(text), 2);
  });

  it("countPhysicalCpuCores uses unique physical id + core id pairs", () => {
    // 4 physical cores × 2 threads (HT) → 8 processors, 4 unique cores.
    const blocks: string[] = [];
    for (let core = 0; core < 4; core++) {
      for (const _thread of [0, 1]) {
        const processor = blocks.length;
        blocks.push(
          [
            `processor\t: ${processor}`,
            "vendor_id\t: GenuineIntel",
            "physical id\t: 0",
            `core id\t\t: ${core}`,
            "cpu cores\t: 4",
            "siblings\t: 8",
          ].join("\n"),
        );
      }
    }
    assertEquals(countPhysicalCpuCores(blocks.join("\n\n") + "\n"), 4);
  });

  it("countPhysicalCpuCores falls back to cpu cores × sockets", () => {
    const text = [
      "processor\t: 0",
      "physical id\t: 0",
      "cpu cores\t: 4",
      "",
      "processor\t: 1",
      "physical id\t: 0",
      "cpu cores\t: 4",
      "",
      "processor\t: 2",
      "physical id\t: 1",
      "cpu cores\t: 4",
      "",
      "processor\t: 3",
      "physical id\t: 1",
      "cpu cores\t: 4",
      "",
    ].join("\n");
    assertEquals(countPhysicalCpuCores(text), 8);
  });

  it("countPhysicalCpuCores returns 0 without topology", () => {
    assertEquals(
      countPhysicalCpuCores("processor\t: 0\nmodel name\t: Fake\n"),
      0,
    );
  });

  it("countCpuSockets counts distinct physical ids", () => {
    const text = [
      "processor\t: 0",
      "physical id\t: 0",
      "",
      "processor\t: 1",
      "physical id\t: 1",
      "",
    ].join("\n");
    assertEquals(countCpuSockets(text), 2);
  });

  it("readCpuModelName returns first model name", () => {
    const text = [
      "processor\t: 0",
      "model name\t: Intel(R) Core(TM) i7-9700 CPU @ 3.00GHz",
      "",
      "processor\t: 1",
      "model name\t: Intel(R) Core(TM) i7-9700 CPU @ 3.00GHz",
      "",
    ].join("\n");
    assertEquals(
      readCpuModelName(text),
      "Intel(R) Core(TM) i7-9700 CPU @ 3.00GHz",
    );
  });

  it("parseMeminfoTotals reads MemTotal and SwapTotal", () => {
    const text = [
      "MemTotal:       16384000 kB",
      "MemAvailable:   8192000 kB",
      "SwapTotal:      2097152 kB",
      "SwapFree:       2097152 kB",
    ].join("\n");
    assertEquals(parseMeminfoTotals(text), {
      memoryTotalBytes: 16384000 * 1024,
      swapTotalBytes: 2097152 * 1024,
    });
  });

  it("parseMeminfoTotals keeps zero SwapTotal", () => {
    const text = [
      "MemTotal:        1024000 kB",
      "SwapTotal:             0 kB",
    ].join("\n");
    assertEquals(parseMeminfoTotals(text), {
      memoryTotalBytes: 1024000 * 1024,
      swapTotalBytes: 0,
    });
  });

  it("parseCpulist expands ranges and strides", () => {
    assertEquals(parseCpulist("0-3,8"), [0, 1, 2, 3, 8]);
    assertEquals(parseCpulist("0-7:2"), [0, 2, 4, 6]);
    assertEquals(parseCpulist("0,,2"), [0, 2]);
    assertEquals(parseCpulist(""), []);
  });

  it("parseSizeToBytes accepts sysfs and cpuinfo units", () => {
    assertEquals(parseSizeToBytes("32K"), 32 * 1024);
    assertEquals(parseSizeToBytes("32KiB"), 32 * 1024);
    assertEquals(parseSizeToBytes("8192 KB"), 8192 * 1024);
    assertEquals(parseSizeToBytes("8M"), 8 * 1024 * 1024);
    assertEquals(parseSizeToBytes("8MiB"), 8 * 1024 * 1024);
  });

  it("advertisedMhzFromModelName reads @ GHz", () => {
    assertEquals(
      advertisedMhzFromModelName("Intel(R) Core(TM) i7-4790K CPU @ 4.00GHz"),
      4000,
    );
    assertEquals(advertisedMhzFromModelName("Fake CPU"), undefined);
  });

  it("hostResourcesFromProc lists one socket with vendor, cores, and threads", () => {
    resetHostResourcesCacheForTests();
    const cpuinfo = [
      "processor\t: 0",
      "vendor_id\t: GenuineIntel",
      "model name\t: Fake CPU @ 3.00GHz",
      "physical id\t: 0",
      "core id\t\t: 0",
      "cpu cores\t: 2",
      "cache size\t: 8192 KB",
      "",
      "processor\t: 1",
      "vendor_id\t: GenuineIntel",
      "model name\t: Fake CPU @ 3.00GHz",
      "physical id\t: 0",
      "core id\t\t: 0",
      "cpu cores\t: 2",
      "cache size\t: 8192 KB",
      "",
      "processor\t: 2",
      "vendor_id\t: GenuineIntel",
      "model name\t: Fake CPU @ 3.00GHz",
      "physical id\t: 0",
      "core id\t\t: 1",
      "cpu cores\t: 2",
      "cache size\t: 8192 KB",
      "",
      "processor\t: 3",
      "vendor_id\t: GenuineIntel",
      "model name\t: Fake CPU @ 3.00GHz",
      "physical id\t: 0",
      "core id\t\t: 1",
      "cpu cores\t: 2",
      "cache size\t: 8192 KB",
      "",
    ].join("\n");
    const resources = hostResourcesFromProc(
      "cpu  0 0 0 0\ncpu0 0 0 0 0\ncpu1 0 0 0 0\ncpu2 0 0 0 0\ncpu3 0 0 0 0\n",
      "MemTotal: 4096000 kB\nSwapTotal: 0 kB\n",
      cpuinfo,
      "x86_64",
    );
    assertEquals(resources, {
      cpus: [
        {
          vendorId: "GenuineIntel",
          name: "Fake CPU @ 3.00GHz",
          architecture: "x86_64",
          cores: { total: 2 },
          threads: { total: 4 },
          cache: { l3: 8192 * 1024 },
          speedMhz: 3000,
        },
      ],
      memory: { totalBytes: 4096000 * 1024 },
      swap: { totalBytes: 0 },
    });
  });

  it("hostResourcesFromProc lists two sockets in physical-id order", () => {
    const cpuinfo = [
      "processor\t: 0",
      "vendor_id\t: GenuineIntel",
      "model name\t: Dual Socket",
      "physical id\t: 1",
      "core id\t\t: 0",
      "",
      "processor\t: 1",
      "vendor_id\t: GenuineIntel",
      "model name\t: Dual Socket",
      "physical id\t: 0",
      "core id\t\t: 0",
      "",
    ].join("\n");
    const resources = hostResourcesFromProc(
      "cpu  0\ncpu0 0\ncpu1 0\n",
      undefined,
      cpuinfo,
      "x86_64",
    );
    assertEquals(resources?.cpus?.map((cpu) => cpu.cores?.total), [1, 1]);
    assertEquals(resources?.cpus?.[0]?.threads?.total, 1);
    assertEquals(resources?.cpus?.[1]?.threads?.total, 1);
  });

  it("hostResourcesFromProc splits hybrid P/E cores from sysfs cpulists", () => {
    const cpuinfo = [
      "processor\t: 0",
      "vendor_id\t: GenuineIntel",
      "model name\t: Hybrid",
      "physical id\t: 0",
      "core id\t\t: 0",
      "",
      "processor\t: 1",
      "vendor_id\t: GenuineIntel",
      "model name\t: Hybrid",
      "physical id\t: 0",
      "core id\t\t: 0",
      "",
      "processor\t: 2",
      "vendor_id\t: GenuineIntel",
      "model name\t: Hybrid",
      "physical id\t: 0",
      "core id\t\t: 8",
      "",
      "processor\t: 3",
      "vendor_id\t: GenuineIntel",
      "model name\t: Hybrid",
      "physical id\t: 0",
      "core id\t\t: 9",
      "",
    ].join("\n");
    const resources = hostResourcesFromProc(
      "cpu  0\ncpu0 0\ncpu1 0\ncpu2 0\ncpu3 0\n",
      undefined,
      cpuinfo,
      "x86_64",
      {
        pCpus: "0-1",
        eCpus: "2-3",
        cacheForCpu: () => ({
          l1d: 48 * 1024,
          l1i: 64 * 1024,
          l2: 2 * 1024 * 1024,
          l3: 36 * 1024 * 1024,
        }),
        freqForCpu: () => ({ speedMhz: 3200, turboMhz: 6000 }),
      },
    );
    assertEquals(resources?.cpus, [
      {
        vendorId: "GenuineIntel",
        name: "Hybrid",
        architecture: "x86_64",
        cores: { total: 3, p: 1, e: 2 },
        threads: { total: 4, p: 2, e: 2 },
        cache: {
          l1d: 48 * 1024,
          l1i: 64 * 1024,
          l2: 2 * 1024 * 1024,
          l3: 36 * 1024 * 1024,
          l1: 112 * 1024,
        },
        speedMhz: 3200,
        turboMhz: 6000,
      },
    ]);
  });

  it("hostResourcesFromProc attaches injected GPUs", () => {
    const resources = hostResourcesFromProc(
      "cpu  0\ncpu0 0\n",
      undefined,
      "processor\t: 0\nphysical id\t: 0\ncore id\t: 0\n",
      "x86_64",
      {
        gpus: [
          {
            vendorId: "0x10de",
            name: "NVIDIA GeForce RTX 5060 Ti",
            memoryBytes: 16 * 1024 * 1024 * 1024,
            driver: "nvidia",
            pciId: "10de:2d04",
            pciSlot: "0000:01:00.0",
          },
        ],
      },
    );
    assertEquals(resources?.gpus, [
      {
        vendorId: "0x10de",
        name: "NVIDIA GeForce RTX 5060 Ti",
        memoryBytes: 16 * 1024 * 1024 * 1024,
        driver: "nvidia",
        pciId: "10de:2d04",
        pciSlot: "0000:01:00.0",
      },
    ]);
  });

  it("hostResourcesFromProc equates cores to threads without topology", () => {
    assertEquals(
      hostResourcesFromProc(
        "cpu  0\ncpu0 0\ncpu1 0\n",
        undefined,
        "processor\t: 0\n",
      ),
      {
        cpus: [
          {
            cores: { total: 2 },
            threads: { total: 2 },
          },
        ],
      },
    );
  });

  it("hostResourcesFromProc returns undefined when empty", () => {
    assertEquals(hostResourcesFromProc(undefined, undefined), undefined);
    assertEquals(hostResourcesFromProc("", "bogus"), undefined);
  });

  it("parseCpulist rejects invalid strides and ranges", () => {
    assertEquals(parseCpulist("0-3:0"), []);
    assertEquals(parseCpulist("3-1"), []);
    assertEquals(parseCpulist("abc"), []);
    assertEquals(parseCpulist("0-7:2"), [0, 2, 4, 6]);
  });

  it("parseSizeToBytes accepts GiB / bare bytes / rejects junk", () => {
    assertEquals(parseSizeToBytes("8G"), 8 * 1024 * 1024 * 1024);
    assertEquals(parseSizeToBytes("8GiB"), 8 * 1024 * 1024 * 1024);
    assertEquals(parseSizeToBytes("512B"), 512);
    assertEquals(parseSizeToBytes(""), undefined);
    assertEquals(parseSizeToBytes("nope"), undefined);
  });

  it("advertisedMhzFromModelName accepts MHz suffixes", () => {
    assertEquals(
      advertisedMhzFromModelName("Some CPU @ 2400MHz"),
      2400,
    );
    assertEquals(advertisedMhzFromModelName("no clock"), undefined);
  });

  it("stripPciHexPrefix and normalizePciSlot handle PCI ids", () => {
    assertEquals(stripPciHexPrefix("0x10DE"), "10de");
    assertEquals(stripPciHexPrefix("10de"), "10de");
    assertEquals(normalizePciSlot("00000000:01:00.0"), "0000:01:00.0");
    assertEquals(normalizePciSlot("0000:01:00.0"), "0000:01:00.0");
    assertEquals(normalizePciSlot("noslot"), "noslot");
  });

  it("parseUeventMap and parseNvidiaSmiMemoryCsv parse fixture text", () => {
    const uevent = parseUeventMap(
      "DRIVER=nvidia\nPCI_SLOT_NAME=0000:01:00.0\n=skip\n",
    );
    assertEquals(uevent.get("DRIVER"), "nvidia");
    assertEquals(uevent.get("PCI_SLOT_NAME"), "0000:01:00.0");
    assertEquals(parseUeventMap(undefined).size, 0);

    const memory = parseNvidiaSmiMemoryCsv(
      "00000000:01:00.0, 16384\n\nbad\n0000:02:00.0, -1\n",
    );
    assertEquals(memory.get("0000:01:00.0"), 16384 * 1024 * 1024);
    assertEquals(memory.has("0000:02:00.0"), false);
  });

  it("readHostResources walks a fixture proc/sys tree for CPU + GPUs", () => {
    resetHostResourcesCacheForTests();
    const { procRoot, sysRoot, root } = buildFixtureRoots();
    try {
      const resources = readHostResources({
        procRoot,
        sysRoot,
        architecture: "x86_64",
        nvidiaSmiCsv: () => "0000:01:00.0, 16384\n00000000:03:00.0, 8192\n",
      });
      if (!resources?.cpus?.[0]) {
        throw new TypeError("expected fixture CPU socket");
      }
      assertEquals(resources.cpus[0].vendorId, "GenuineIntel");
      assertEquals(resources.cpus[0].name, "Fixture CPU @ 3.20GHz");
      assertEquals(resources.cpus[0].architecture, "x86_64");
      assertEquals(resources.cpus[0].cores, { total: 2, p: 1, e: 1 });
      assertEquals(resources.cpus[0].threads, { total: 2, p: 1, e: 1 });
      assertEquals(resources.cpus[0].cache, {
        l1d: 48 * 1024,
        l1i: 32 * 1024,
        l1: 64 * 1024,
        l2: 2 * 1024 * 1024,
        l3: 16 * 1024 * 1024,
        l4: 128 * 1024 * 1024,
      });
      assertEquals(resources.cpus[0].speedMhz, 3200);
      assertEquals(resources.cpus[0].turboMhz, 4800);
      assertEquals(resources.memory?.totalBytes, 2097152 * 1024);
      assertEquals(resources.swap?.totalBytes, 1048576 * 1024);

      if (!resources.gpus || resources.gpus.length < 3) {
        throw new TypeError("expected at least three GPUs from fixture cards");
      }
      assertEquals(resources.gpus[0], {
        vendorId: "0x10de",
        driver: "nvidia",
        pciSlot: "0000:01:00.0",
        pciId: "10de:2d04",
        name: "NVIDIA GeForce RTX Fixture",
        memoryBytes: 16384 * 1024 * 1024,
      });
      assertEquals(resources.gpus[1], {
        vendorId: "0x1002",
        driver: "amdgpu",
        pciSlot: "0000:02:00.0",
        pciId: "1002:73ff",
        name: "Fixture Radeon",
        memoryBytes: 8589934592,
      });
      assertEquals(resources.gpus[2], {
        vendorId: "0x10de",
        driver: "nvidia",
        pciSlot: "00000000:03:00.0",
        pciId: "10de:1234",
        name: "Fixture Product GPU",
        memoryBytes: 8192 * 1024 * 1024,
      });
    } finally {
      Deno.removeSync(root, { recursive: true });
      resetHostResourcesCacheForTests();
    }
  });

  it("readHostResources falls back to vendor:device GPU name and skips empty DRM", () => {
    resetHostResourcesCacheForTests();
    const root = Deno.makeTempDirSync({ prefix: "tp-host-gpu-fallback-" });
    const procRoot = `${root}/proc`;
    const sysRoot = `${root}/sys`;
    try {
      writeFile(`${procRoot}/stat`, "cpu  0\ncpu0 0\n");
      writeFile(`${procRoot}/meminfo`, "MemTotal: 1024 kB\nSwapTotal: 0 kB\n");
      writeFile(
        `${procRoot}/cpuinfo`,
        "processor\t: 0\nphysical id\t: 0\ncore id\t: 0\n",
      );
      Deno.mkdirSync(`${sysRoot}/class/drm/card0/device`, { recursive: true });
      const card = `${sysRoot}/class/drm/card1/device`;
      writeFile(`${card}/vendor`, "0x8086\n");
      writeFile(`${card}/device`, "0xabcd\n");
      writeFile(`${card}/uevent`, "DRIVER=i915\n");

      const resources = readHostResources({
        procRoot,
        sysRoot,
        architecture: "x86_64",
        nvidiaSmiCsv: () => undefined,
      });
      assertEquals(resources?.gpus, [
        {
          vendorId: "0x8086",
          driver: "i915",
          pciId: "8086:abcd",
          name: "0x8086 0xabcd",
        },
      ]);
    } finally {
      Deno.removeSync(root, { recursive: true });
      resetHostResourcesCacheForTests();
    }
  });

  it("readHostResources returns undefined when fixture trees are empty", () => {
    resetHostResourcesCacheForTests();
    const root = Deno.makeTempDirSync({ prefix: "tp-host-empty-" });
    try {
      assertEquals(
        readHostResources({
          procRoot: `${root}/proc`,
          sysRoot: `${root}/sys`,
          architecture: "",
          nvidiaSmiCsv: () => undefined,
        }),
        undefined,
      );
    } finally {
      Deno.removeSync(root, { recursive: true });
      resetHostResourcesCacheForTests();
    }
  });

  it("readHostResources caches only the default (non-injected) path", () => {
    resetHostResourcesCacheForTests();
    const { procRoot, sysRoot, root } = buildFixtureRoots();
    try {
      const first = readHostResources({
        procRoot,
        sysRoot,
        architecture: "x86_64",
        nvidiaSmiCsv: () => undefined,
      });
      if (!first) throw new TypeError("expected fixture resources");
      // Injected reads must not populate the process cache.
      assertEquals(
        readHostResources({
          procRoot: `${root}/missing-proc`,
          sysRoot: `${root}/missing-sys`,
          architecture: "",
          nvidiaSmiCsv: () => undefined,
        }),
        undefined,
      );
    } finally {
      Deno.removeSync(root, { recursive: true });
      resetHostResourcesCacheForTests();
    }
  });

  it("readHostResources uses runCat fallback when Deno.readTextFileSync fails", () => {
    resetHostResourcesCacheForTests();
    const root = Deno.makeTempDirSync({ prefix: "tp-host-cat-" });
    const enc = new TextEncoder();
    const files = new Map<string, string>([
      [
        `${root}/proc/stat`,
        "cpu  0\ncpu0 0\n",
      ],
      [
        `${root}/proc/meminfo`,
        "MemTotal: 2048 kB\nSwapTotal: 0 kB\n",
      ],
      [
        `${root}/proc/cpuinfo`,
        "processor\t: 0\nphysical id\t: 0\ncore id\t: 0\n",
      ],
    ]);
    try {
      const resources = readHostResources({
        procRoot: `${root}/proc`,
        sysRoot: `${root}/sys`,
        architecture: "x86_64",
        nvidiaSmiCsv: () => undefined,
        runCat: (path) => {
          const body = files.get(path);
          if (!body) return { code: 1, stdout: new Uint8Array() };
          return { code: 0, stdout: enc.encode(body) };
        },
      });
      assertEquals(resources?.cpus?.[0]?.threads?.total, 1);
      assertEquals(resources?.memory?.totalBytes, 2048 * 1024);
    } finally {
      Deno.removeSync(root, { recursive: true });
      resetHostResourcesCacheForTests();
    }
  });

  it("readHostResources treats runCat throw as missing proc text", () => {
    resetHostResourcesCacheForTests();
    const root = Deno.makeTempDirSync({ prefix: "tp-host-cat-throw-" });
    try {
      const resources = readHostResources({
        procRoot: `${root}/missing-proc`,
        sysRoot: `${root}/missing-sys`,
        architecture: "x86_64",
        nvidiaSmiCsv: () => undefined,
        runCat: () => {
          throw new Error("no cat");
        },
      });
      // Missing proc text still yields an architecture-only socket placeholder.
      assertEquals(resources, { cpus: [{ architecture: "x86_64" }] });
    } finally {
      Deno.removeSync(root, { recursive: true });
      resetHostResourcesCacheForTests();
    }
  });

  it("readHostResources treats DRM readDirSync errors as no GPUs", () => {
    resetHostResourcesCacheForTests();
    const { procRoot, sysRoot, root } = buildFixtureRoots();
    try {
      const resources = readHostResources({
        procRoot,
        sysRoot,
        architecture: "x86_64",
        nvidiaSmiCsv: () => undefined,
        readDirSync: () => {
          throw new Error("drm unavailable");
        },
      });
      if (!resources?.cpus?.[0]) {
        throw new TypeError("expected CPU without GPUs");
      }
      assertEquals(resources.gpus, undefined);
    } finally {
      Deno.removeSync(root, { recursive: true });
      resetHostResourcesCacheForTests();
    }
  });

  it("readHostResources spawns nvidia-smi from PATH when nvidiaSmiCsv is omitted", () => {
    resetHostResourcesCacheForTests();
    const { procRoot, sysRoot, root } = buildFixtureRoots();
    const binDir = Deno.makeTempDirSync({ prefix: "tp-nvidia-smi-" });
    const previousPath = Deno.env.get("PATH") ?? "";
    try {
      Deno.writeTextFileSync(
        `${binDir}/nvidia-smi`,
        String.raw`#!/bin/sh
if [ "$1" = "--query-gpu=pci.bus_id,memory.total" ]; then
  echo "0000:01:00.0, 4096"
  exit 0
fi
exit 1
`,
      );
      Deno.chmodSync(`${binDir}/nvidia-smi`, 0o755);
      Deno.env.set("PATH", `${binDir}:${previousPath}`);

      const resources = readHostResources({
        procRoot,
        sysRoot,
        architecture: "x86_64",
      });
      if (!resources?.gpus?.[0]) {
        throw new TypeError("expected GPU with nvidia-smi memory");
      }
      assertEquals(resources.gpus[0].memoryBytes, 4096 * 1024 * 1024);
    } finally {
      Deno.env.set("PATH", previousPath);
      Deno.removeSync(binDir, { recursive: true });
      Deno.removeSync(root, { recursive: true });
      resetHostResourcesCacheForTests();
    }
  });

  it("readHostResources tolerates missing or failing nvidia-smi on PATH", () => {
    resetHostResourcesCacheForTests();
    const { procRoot, sysRoot, root } = buildFixtureRoots();
    const binDir = Deno.makeTempDirSync({ prefix: "tp-nvidia-fail-" });
    const previousPath = Deno.env.get("PATH") ?? "";
    try {
      Deno.writeTextFileSync(
        `${binDir}/nvidia-smi`,
        String.raw`#!/bin/sh
exit 1
`,
      );
      Deno.chmodSync(`${binDir}/nvidia-smi`, 0o755);
      Deno.env.set("PATH", `${binDir}:${previousPath}`);

      const withFailingBinary = readHostResources({
        procRoot,
        sysRoot,
        architecture: "x86_64",
      });
      if (!withFailingBinary?.gpus?.[0]) {
        throw new TypeError("expected GPU without nvidia memory");
      }
      assertEquals(withFailingBinary.gpus[0].memoryBytes, undefined);

      Deno.env.set("PATH", "/no/such/turbopanel-bin");
      const withoutBinary = readHostResources({
        procRoot,
        sysRoot,
        architecture: "x86_64",
      });
      if (!withoutBinary?.gpus?.[0]) {
        throw new TypeError("expected GPU when nvidia-smi is absent");
      }
      assertEquals(withoutBinary.gpus[0].memoryBytes, undefined);
    } finally {
      Deno.env.set("PATH", previousPath);
      Deno.removeSync(binDir, { recursive: true });
      Deno.removeSync(root, { recursive: true });
      resetHostResourcesCacheForTests();
    }
  });

  it("parse helpers cover edge rejects and duplicate cpulist entries", () => {
    assertEquals(parseCpulist("0,0,1-2,1"), [0, 1, 2]);
    assertEquals(parseCpulist("0-x"), []);
    assertEquals(parseCpulist("a-b"), []);
    assertEquals(parseCpulist("0-7:1.5"), []);
    assertEquals(parseCpulist("-1-3"), []);
    assertEquals(advertisedMhzFromModelName("CPU @ 0GHz"), undefined);
    assertEquals(advertisedMhzFromModelName("CPU @ bogon"), undefined);
    assertEquals(advertisedMhzFromModelName("CPU @ 0MHz"), undefined);
    assertEquals(advertisedMhzFromModelName("CPU @ -2MHz"), undefined);
  });

  it("hostResourcesFromProc covers ARM implementer and non-numeric socket ids", () => {
    const arm = hostResourcesFromProc(
      "cpu  0\ncpu0 0\n",
      undefined,
      [
        "processor\t: 0",
        "CPU implementer\t: 0x41",
        "model name\t: Cortex-A72",
        "physical id\t: 0",
        "core id\t\t: 0",
        " : skipped-empty-key",
        "not-a-field",
        "",
      ].join("\n"),
      "aarch64",
    );
    assertEquals(arm?.cpus?.[0]?.vendorId, "0x41");
    assertEquals(arm?.cpus?.[0]?.name, "Cortex-A72");
    assertEquals(arm?.cpus?.[0]?.architecture, "aarch64");

    const dual = hostResourcesFromProc(
      "cpu  0\ncpu0 0\ncpu1 0\n",
      undefined,
      [
        "processor\t: 0",
        "physical id\t: sock-b",
        "core id\t\t: 0",
        "",
        "processor\t: 1",
        "physical id\t: sock-a",
        "core id\t\t: 0",
        "",
      ].join("\n"),
      "x86_64",
    );
    assertEquals(dual?.cpus?.map((s) => s.architecture), [
      "x86_64",
      "x86_64",
    ]);
    // Non-numeric physical ids sort lexicographically (sock-a before sock-b).
    assertEquals(dual?.cpus?.length, 2);
  });

  it("hostResourcesFromProc uses cpu cores field and expands ungrouped threads", () => {
    const fromCpuCores = hostResourcesFromProc(
      "cpu  0\ncpu0 0\ncpu1 0\n",
      undefined,
      [
        "processor\t: 0",
        "cpu cores\t: 8",
        "",
        "processor\t: 1",
        "cpu cores\t: 8",
        "",
      ].join("\n"),
    );
    assertEquals(fromCpuCores?.cpus?.[0]?.cores?.total, 8);
    assertEquals(fromCpuCores?.cpus?.[0]?.threads?.total, 2);

    const expanded = hostResourcesFromProc(
      "cpu  0\ncpu0 0\ncpu1 0\ncpu2 0\ncpu3 0\n",
      undefined,
      "processor\t: 0\n",
    );
    assertEquals(expanded?.cpus?.[0]?.threads?.total, 4);
    assertEquals(expanded?.cpus?.[0]?.cores?.total, 4);

    // Single processor already matches /proc/stat — expandUngroupedSocketThreads no-ops.
    const matched = hostResourcesFromProc(
      "cpu  0\ncpu0 0\n",
      undefined,
      "processor\t: 0\n",
    );
    assertEquals(matched?.cpus?.[0]?.threads?.total, 1);
  });

  it("hostResourcesFromProc falls back to cpu counts when hybrid lists lack core ids", () => {
    const resources = hostResourcesFromProc(
      "cpu  0\ncpu0 0\ncpu1 0\n",
      undefined,
      [
        "processor\t: 0",
        "physical id\t: 0",
        "",
        "processor\t: 1",
        "physical id\t: 0",
        "",
      ].join("\n"),
      "x86_64",
      { pCpus: "0", eCpus: "1" },
    );
    assertEquals(resources?.cpus?.[0]?.cores, { total: 2, p: 1, e: 1 });
    assertEquals(resources?.cpus?.[0]?.threads, { total: 2, p: 1, e: 1 });
  });

  it("hostResourcesFromProc keeps injected L1 when already set and falls back from empty cache", () => {
    const cpuinfo = [
      "processor\t: 0",
      "vendor_id\t: GenuineIntel",
      "model name\t: Cache CPU",
      "physical id\t: 0",
      "core id\t\t: 0",
      "cache size\t: 4096 KB",
      "",
    ].join("\n");
    const withL1 = hostResourcesFromProc(
      "cpu  0\ncpu0 0\n",
      undefined,
      cpuinfo,
      "x86_64",
      {
        cacheForCpu: () => ({
          l1: 80 * 1024,
          l1d: 48 * 1024,
          l1i: 32 * 1024,
        }),
      },
    );
    assertEquals(withL1?.cpus?.[0]?.cache, {
      l1: 80 * 1024,
      l1d: 48 * 1024,
      l1i: 32 * 1024,
    });

    const emptyCache = hostResourcesFromProc(
      "cpu  0\ncpu0 0\n",
      undefined,
      cpuinfo,
      "x86_64",
      { cacheForCpu: () => ({}) },
    );
    assertEquals(emptyCache?.cpus?.[0]?.cache, { l3: 4096 * 1024 });
  });

  it("hostResourcesFromProc builds topologyless and name-only sockets", () => {
    const topologyless = hostResourcesFromProc(
      "cpu  0\ncpu0 0\ncpu1 0\n",
      undefined,
      "Hardware\t: Raspberry Pi 5\n",
      "aarch64",
    );
    assertEquals(topologyless?.cpus?.[0], {
      name: "Raspberry Pi 5",
      architecture: "aarch64",
      cores: { total: 2 },
      threads: { total: 2 },
    });

    const nameOnly = hostResourcesFromProc(
      undefined,
      undefined,
      "Processor\t: ARMv7 Processor\n",
    );
    assertEquals(nameOnly, {
      cpus: [{ name: "ARMv7 Processor" }],
    });
  });

  it("readHostResources defaults architecture and skips invalid cache / GPU names", () => {
    resetHostResourcesCacheForTests();
    const root = Deno.makeTempDirSync({ prefix: "tp-host-edges-" });
    const procRoot = `${root}/proc`;
    const sysRoot = `${root}/sys`;
    try {
      writeFile(`${procRoot}/stat`, "cpu  0\ncpu0 0\n");
      writeFile(
        `${procRoot}/meminfo`,
        "MemTotal: 1024 kB\nSwapTotal: 0 kB\n",
      );
      writeFile(
        `${procRoot}/cpuinfo`,
        "processor\t: 0\nphysical id\t: 0\ncore id\t\t: 0\n",
      );

      const cpu0 = `${sysRoot}/devices/system/cpu/cpu0`;
      writeFile(`${cpu0}/cache/index0/level`, "not-a-level\n");
      writeFile(`${cpu0}/cache/index0/type`, "Data\n");
      writeFile(`${cpu0}/cache/index0/size`, "48K\n");
      writeFile(`${cpu0}/cache/index1/level`, "1\n");
      writeFile(`${cpu0}/cache/index1/type`, "Data\n");
      writeFile(`${cpu0}/cache/index1/size`, "bogus\n");
      writeFile(`${cpu0}/cpufreq/base_frequency`, "0\n");
      writeFile(`${cpu0}/cpufreq/cpuinfo_max_freq`, "nan\n");

      writeFile(`${sysRoot}/class/drm/card0/device/vendor`, "0x10de\n");
      // device id omitted → name stays undefined (no marketing/product/nvidia Model).
      writeFile(
        `${sysRoot}/class/drm/card0/device/uevent`,
        "DRIVER=nvidia\nPCI_SLOT_NAME=0000:01:00.0\n",
      );
      writeFile(
        `${procRoot}/driver/nvidia/gpus/0000:01:00.0/information`,
        "IRQ:       16\nModel:     \nGPU UUID:  GPU-fixture\n",
      );

      writeFile(`${sysRoot}/class/drm/card1/device/vendor`, "0x1002\n");
      writeFile(`${sysRoot}/class/drm/card1/device/device`, "0x73ff\n");
      writeFile(
        `${sysRoot}/class/drm/card1/device/uevent`,
        "DRIVER=amdgpu\nPCI_SLOT_NAME=0000:02:00.0\n",
      );
      writeFile(
        `${procRoot}/driver/nvidia/gpus/0000:02:00.0/information`,
        "IRQ:       17\nSomething: else\n",
      );

      const resources = readHostResources({
        procRoot,
        sysRoot,
        // Omit architecture → Deno.build.arch default in resolveInventoryLayout.
        nvidiaSmiCsv: () => undefined,
      });
      if (!resources?.cpus?.[0]) {
        throw new TypeError("expected socket with default architecture");
      }
      assertEquals(resources.cpus[0].architecture, Deno.build.arch);
      assertEquals(resources.cpus[0].cache, undefined);
      assertEquals(resources.cpus[0].speedMhz, undefined);
      assertEquals(resources.cpus[0].turboMhz, undefined);

      if (!resources.gpus || resources.gpus.length < 2) {
        throw new TypeError("expected two GPUs from edge fixtures");
      }
      assertEquals(resources.gpus[0].name, undefined);
      assertEquals(resources.gpus[0].vendorId, "0x10de");
      assertEquals(resources.gpus[1].name, "0x1002 0x73ff");
    } finally {
      Deno.removeSync(root, { recursive: true });
      resetHostResourcesCacheForTests();
    }
  });

  it("readHostResources process-caches the default host path", () => {
    resetHostResourcesCacheForTests();
    try {
      const first = readHostResources();
      const second = readHostResources();
      assertEquals(second, first);
    } finally {
      resetHostResourcesCacheForTests();
    }
  });
});
