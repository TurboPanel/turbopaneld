import { assertEquals } from "@std/assert";
import {
  conntrackUsedPercent,
  fileHandlesUsedPercent,
  parseConntrackCount,
  parseConntrackMax,
  parseFileMax,
  parseFileNr,
} from "./parse-kernel-limits.ts";

const test = Deno.test.bind(Deno);

function fixture(name: string): string {
  return Deno.readTextFileSync(
    new URL(`./testdata/${name}`, import.meta.url),
  );
}

test("parseFileNr extracts allocated file handles (first field)", () => {
  assertEquals(parseFileNr(fixture("proc-file-nr.txt")), 4256);
});

test("parseFileMax extracts the ceiling", () => {
  assertEquals(parseFileMax(fixture("proc-file-max.txt")), 1048576);
});

test("fileHandlesUsedPercent computes percent math", () => {
  const nr = parseFileNr(fixture("proc-file-nr.txt"));
  const max = parseFileMax(fixture("proc-file-max.txt"));
  assertEquals(fileHandlesUsedPercent(nr, max), (4256 / 1048576) * 100);
});

test("fileHandlesUsedPercent returns null (not 0) when either input is missing", () => {
  assertEquals(fileHandlesUsedPercent(null, 1048576), null);
  assertEquals(fileHandlesUsedPercent(4256, null), null);
  assertEquals(fileHandlesUsedPercent(4256, 0), null);
});

test("parseConntrackCount/Max extract single integers", () => {
  assertEquals(parseConntrackCount(fixture("proc-conntrack-count.txt")), 12345);
  assertEquals(parseConntrackMax(fixture("proc-conntrack-max.txt")), 262144);
});

test("conntrackUsedPercent computes percent math", () => {
  const count = parseConntrackCount(fixture("proc-conntrack-count.txt"));
  const max = parseConntrackMax(fixture("proc-conntrack-max.txt"));
  assertEquals(conntrackUsedPercent(count, max), (12345 / 262144) * 100);
});

test("conntrackUsedPercent returns null (not 0) when the module isn't loaded (files absent)", () => {
  assertEquals(conntrackUsedPercent(null, null), null);
  assertEquals(conntrackUsedPercent(null, 262144), null);
  assertEquals(conntrackUsedPercent(12345, null), null);
});
