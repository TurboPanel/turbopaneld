import { assertEquals } from "@std/assert";
import { parseMeminfo } from "./parse-meminfo.ts";
import { it } from "@std/testing/bdd";

function fixture(name: string): string {
  return Deno.readTextFileSync(
    new URL(`./testdata/${name}`, import.meta.url),
  );
}

it("parseMeminfo derives memory and swap percentages", () => {
  const mem = parseMeminfo(fixture("proc-meminfo.txt"));
  assertEquals(mem !== null, true);
  assertEquals(mem!.memoryUsedBytes, 4000000 * 1024);
  assertEquals(mem!.memoryAvailableBytes, 4000000 * 1024);
  assertEquals(mem!.memoryUsedPercent, 50);
  assertEquals(mem!.swapUsedPercent, 50);
});

it("parseMeminfo returns null swap percent when SwapTotal is 0", () => {
  const mem = parseMeminfo(fixture("proc-meminfo-no-swap.txt"));
  assertEquals(mem !== null, true);
  assertEquals(mem!.swapUsedPercent, null);
});

it("parseMeminfo returns null when MemTotal or MemAvailable is missing", () => {
  assertEquals(parseMeminfo("SwapTotal: 1000 kB\n"), null);
  assertEquals(parseMeminfo("MemTotal: 1000 kB\n"), null);
});

it("parseMeminfo reports zero used percent when MemTotal is 0", () => {
  const mem = parseMeminfo(
    "MemTotal: 0 kB\nMemAvailable: 0 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n",
  );
  if (!mem) throw new TypeError("expected gauges for zero MemTotal");
  assertEquals(mem.memoryUsedPercent, 0);
  assertEquals(mem.swapUsedPercent, null);
});

it("parseMeminfo leaves swapUsedPercent null when swap fields are absent", () => {
  const mem = parseMeminfo("MemTotal: 2000 kB\nMemAvailable: 500 kB\n");
  if (!mem) throw new TypeError("expected gauges without swap");
  assertEquals(mem.memoryUsedBytes, 1500 * 1024);
  assertEquals(mem.swapUsedPercent, null);
});
