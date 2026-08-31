import { assertEquals } from "@std/assert";
import { parseMeminfo } from "./parse-meminfo.ts";
import { it } from "@std/testing/bdd";

function fixture(name: string): string {
  return Deno.readTextFileSync(
    new URL(`./testdata/${name}`, import.meta.url),
  );
}

it("parseMeminfo passes raw byte gauges through without percent math", () => {
  const mem = parseMeminfo(fixture("proc-meminfo.txt"));
  assertEquals(mem, {
    totalBytes: 8000000 * 1024,
    availableBytes: 4000000 * 1024,
    freeBytes: 2000000 * 1024,
    swapTotalBytes: 2000000 * 1024,
    swapFreeBytes: 1000000 * 1024,
  });
});

it("parseMeminfo nulls both swap fields (never 0) on a swap-absent host", () => {
  const mem = parseMeminfo(fixture("proc-meminfo-no-swap.txt"));
  if (!mem) throw new TypeError("expected gauges for swap-absent host");
  assertEquals(mem.swapTotalBytes, null);
  assertEquals(mem.swapFreeBytes, null);
  assertEquals(mem.totalBytes, 8000000 * 1024);
});

it("parseMeminfo nulls swap when the lines are missing entirely", () => {
  const mem = parseMeminfo("MemTotal: 2000 kB\nMemAvailable: 500 kB\n");
  if (!mem) throw new TypeError("expected gauges without swap lines");
  assertEquals(mem.swapTotalBytes, null);
  assertEquals(mem.swapFreeBytes, null);
  assertEquals(mem.freeBytes, null);
});

it("parseMeminfo returns null when MemTotal or MemAvailable is missing", () => {
  assertEquals(parseMeminfo("SwapTotal: 1000 kB\n"), null);
  assertEquals(parseMeminfo("MemTotal: 1000 kB\n"), null);
});
