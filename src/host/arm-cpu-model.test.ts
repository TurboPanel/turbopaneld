import { assertEquals } from "@std/assert";
import { armCpuModelFromCpuinfo, armCpuPartName } from "./arm-cpu-model.ts";

/** Sonar typescript:S2187 only recognizes `test()`; see src/AGENTS.md. */
const test = Deno.test.bind(Deno);

const PI5_CPUINFO = Deno.readTextFileSync(
  new URL("./testdata/raspberry-pi-5-cpuinfo.txt", import.meta.url),
);

test("armCpuPartName names a known implementer and part, any case and spacing", () => {
  assertEquals(armCpuPartName("0x41", "0xd0b"), "Cortex-A76");
  assertEquals(armCpuPartName(" 0x41", " 0xD0C"), "Neoverse-N1");
  assertEquals(armCpuPartName("0xc0", "0xac3"), "Ampere-1");
});

test("armCpuPartName does not guess an unknown or missing pair", () => {
  assertEquals(armCpuPartName("0x41", "0xfff"), undefined);
  assertEquals(armCpuPartName("0x61", "0xd0b"), undefined);
  assertEquals(armCpuPartName(undefined, "0xd0b"), undefined);
  assertEquals(armCpuPartName("0x41", undefined), undefined);
});

test("armCpuModelFromCpuinfo names a Raspberry Pi 5's cores once", () => {
  assertEquals(armCpuModelFromCpuinfo(PI5_CPUINFO), "Cortex-A76");
});

test("armCpuModelFromCpuinfo lists each core kind of a mixed chip in order", () => {
  const block = (part: string) =>
    `processor\t: 0\nCPU implementer\t: 0x41\nCPU part\t: ${part}\n`;
  const text = [block("0xd0b"), block("0xd05"), block("0xd0b")].join("\n");
  assertEquals(armCpuModelFromCpuinfo(text), "Cortex-A76 + Cortex-A55");
});

test("armCpuModelFromCpuinfo is undefined for an x86 cpuinfo", () => {
  assertEquals(
    armCpuModelFromCpuinfo("processor\t: 0\nmodel name\t: Test CPU\n"),
    undefined,
  );
});
