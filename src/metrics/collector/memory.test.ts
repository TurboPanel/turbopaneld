import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import { readMemoryGauges } from "./memory.ts";

function fixture(name: string): string {
  return Deno.readTextFileSync(
    new URL(`./testdata/${name}`, import.meta.url),
  );
}

it("readMemoryGauges yields the five raw v2 memory fields", () => {
  const mem = readMemoryGauges(fixture("proc-meminfo.txt"));
  assertEquals(mem, {
    totalBytes: 8000000 * 1024,
    availableBytes: 4000000 * 1024,
    freeBytes: 2000000 * 1024,
    swapTotalBytes: 2000000 * 1024,
    swapFreeBytes: 1000000 * 1024,
  });
});

it("readMemoryGauges returns null for unparsable input", () => {
  assertEquals(readMemoryGauges(""), null);
});
