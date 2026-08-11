import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  countCpuCores,
  hostInventoryFromProc,
  parseMeminfoTotals,
  resetHostInventoryCacheForTests,
} from "./host-inventory.ts";

describe("host-inventory", () => {
  it("countCpuCores counts online cpuN lines only", () => {
    const text = [
      "cpu  10 0 0 0 0 0 0 0",
      "cpu0 5 0 0 0 0 0 0 0",
      "cpu1 5 0 0 0 0 0 0 0",
      "intr 0",
    ].join("\n");
    assertEquals(countCpuCores(text), 2);
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

  it("hostInventoryFromProc merges cores and memory", () => {
    resetHostInventoryCacheForTests();
    const inventory = hostInventoryFromProc(
      "cpu  0 0 0 0\ncpu0 0 0 0 0\ncpu1 0 0 0 0\ncpu2 0 0 0 0\ncpu3 0 0 0 0\n",
      "MemTotal: 4096000 kB\nSwapTotal: 0 kB\n",
    );
    assertEquals(inventory, {
      cpuCores: 4,
      memoryTotalBytes: 4096000 * 1024,
      swapTotalBytes: 0,
    });
  });

  it("hostInventoryFromProc returns undefined when empty", () => {
    assertEquals(hostInventoryFromProc(undefined, undefined), undefined);
    assertEquals(hostInventoryFromProc("", "bogus"), undefined);
  });
});
