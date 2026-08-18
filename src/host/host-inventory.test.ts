import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  advertisedMhzFromModelName,
  countCpuSockets,
  countCpuThreads,
  countPhysicalCpuCores,
  hostResourcesFromProc,
  parseCpulist,
  parseMeminfoTotals,
  parseSizeToBytes,
  readCpuModelName,
  resetHostResourcesCacheForTests,
} from "./host-inventory.ts";

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
    assertEquals(parseCpulist(""), []);
  });

  it("parseSizeToBytes accepts sysfs and cpuinfo units", () => {
    assertEquals(parseSizeToBytes("32K"), 32 * 1024);
    assertEquals(parseSizeToBytes("8192 KB"), 8192 * 1024);
    assertEquals(parseSizeToBytes("8M"), 8 * 1024 * 1024);
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
});
