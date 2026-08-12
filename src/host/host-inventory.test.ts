import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  countCpuThreads,
  countPhysicalCpuCores,
  hostInventoryFromProc,
  parseMeminfoTotals,
  resetHostInventoryCacheForTests,
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

  it("hostInventoryFromProc merges cores, threads, and memory", () => {
    resetHostInventoryCacheForTests();
    const cpuinfo = [
      "processor\t: 0",
      "physical id\t: 0",
      "core id\t\t: 0",
      "cpu cores\t: 2",
      "",
      "processor\t: 1",
      "physical id\t: 0",
      "core id\t\t: 0",
      "cpu cores\t: 2",
      "",
      "processor\t: 2",
      "physical id\t: 0",
      "core id\t\t: 1",
      "cpu cores\t: 2",
      "",
      "processor\t: 3",
      "physical id\t: 0",
      "core id\t\t: 1",
      "cpu cores\t: 2",
      "",
    ].join("\n");
    const inventory = hostInventoryFromProc(
      "cpu  0 0 0 0\ncpu0 0 0 0 0\ncpu1 0 0 0 0\ncpu2 0 0 0 0\ncpu3 0 0 0 0\n",
      "MemTotal: 4096000 kB\nSwapTotal: 0 kB\n",
      cpuinfo,
    );
    assertEquals(inventory, {
      cpuCores: 2,
      cpuThreads: 4,
      memoryTotalBytes: 4096000 * 1024,
      swapTotalBytes: 0,
    });
  });

  it("hostInventoryFromProc equates cores to threads without topology", () => {
    assertEquals(
      hostInventoryFromProc(
        "cpu  0\ncpu0 0\ncpu1 0\n",
        undefined,
        "processor\t: 0\n",
      ),
      { cpuCores: 2, cpuThreads: 2 },
    );
  });

  it("hostInventoryFromProc returns undefined when empty", () => {
    assertEquals(hostInventoryFromProc(undefined, undefined), undefined);
    assertEquals(hostInventoryFromProc("", "bogus"), undefined);
  });
});
