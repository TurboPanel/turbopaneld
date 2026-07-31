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
