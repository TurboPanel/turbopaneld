import { assertEquals } from "@std/assert";
import { CounterBaselineTracker } from "./baseline.ts";
import { parsePsiLine, psiPercent, readPsi } from "./parse-psi.ts";

const test = Deno.test.bind(Deno);

function fixture(name: string): string {
  return Deno.readTextFileSync(
    new URL(`./testdata/${name}`, import.meta.url),
  );
}

test("parsePsiLine parses some and full totals", () => {
  const text = fixture("proc-pressure-memory.txt");
  assertEquals(parsePsiLine(text, "some"), 45000);
  assertEquals(parsePsiLine(text, "full"), 12000);
});

test("parsePsiLine returns null for a missing full line (CPU on older kernels)", () => {
  const text = fixture("proc-pressure-cpu.txt");
  assertEquals(parsePsiLine(text, "some"), 123456);
  assertEquals(parsePsiLine(text, "full"), null);
});

test("readPsi returns both totals null when the file is unreadable", async () => {
  const result = await readPsi(() => undefined, "/proc/pressure/cpu");
  assertEquals(result, { someTotalUs: null, fullTotalUs: null });
});

test("readPsi reads and parses a present file", async () => {
  const result = await readPsi(
    () => fixture("proc-pressure-io.txt"),
    "/proc/pressure/io",
  );
  assertEquals(result.someTotalUs, 980000);
  assertEquals(result.fullTotalUs, 210000);
});

test("psiPercent computes a percent-of-interval from a two-snapshot delta", () => {
  const tracker = new CounterBaselineTracker();
  const first = parsePsiLine(fixture("proc-pressure-io.txt"), "some");
  const second = parsePsiLine(fixture("proc-pressure-io-2.txt"), "some");

  assertEquals(psiPercent(first, 60, tracker, "psi:io:some", 0), null);
  const deltaUs = second! - first!;
  const expected = ((deltaUs / 1000) / (60 * 1000)) * 100;
  assertEquals(psiPercent(second, 60, tracker, "psi:io:some", 0), expected);
});

test("psiPercent returns null (never 0) when the source is unreadable this tick", () => {
  const tracker = new CounterBaselineTracker();
  tracker.delta("psi:cpu:full", 1000, 0);
  assertEquals(psiPercent(null, 60, tracker, "psi:cpu:full", 0), null);
});

test("psiPercent re-baselines on boot generation change", () => {
  const tracker = new CounterBaselineTracker();
  assertEquals(psiPercent(1000, 60, tracker, "psi:cpu:some", 0), null);
  assertEquals(psiPercent(50, 60, tracker, "psi:cpu:some", 1), null);
});

test("parsePsiLine returns null when the kind line has no total= field", () => {
  assertEquals(parsePsiLine("some avg10=1.00 avg60=1.00\n", "some"), null);
  assertEquals(parsePsiLine("some\n", "some"), null);
});

test("psiPercent clamps to 0–100 and nulls a non-positive interval after a baseline exists", () => {
  const tracker = new CounterBaselineTracker();
  assertEquals(psiPercent(1_000, 1, tracker, "psi:clamp", 0), null);
  // 2 s of stall in a 1 s window is 200% → clamped to 100.
  assertEquals(psiPercent(1_000 + 2_000_000, 1, tracker, "psi:clamp", 0), 100);

  const zeroWindow = new CounterBaselineTracker();
  assertEquals(psiPercent(1_000, 60, zeroWindow, "psi:zero", 0), null);
  assertEquals(psiPercent(2_000, 0, zeroWindow, "psi:zero", 0), null);
});
