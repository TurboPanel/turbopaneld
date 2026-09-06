import { assertEquals } from "@std/assert";
import { CounterBaselineTracker } from "./baseline.ts";
import {
  parseVmstat,
  parseVmstatReclaim,
  resolvePageSizeBytes,
  vmstatRates,
} from "./parse-vmstat.ts";

const test = Deno.test.bind(Deno);

function fixture(name: string): string {
  return Deno.readTextFileSync(
    new URL(`./testdata/${name}`, import.meta.url),
  );
}

test("parseVmstat extracts swap/majfault/oom counters", () => {
  const counters = parseVmstat(fixture("proc-vmstat-1.txt"));
  assertEquals(counters, {
    pswpin: 100,
    pswpout: 200,
    pgmajfault: 5000,
    oomKill: 0,
  });
});

test("parseVmstat returns oomKill null when the vmstat entry is absent", () => {
  const counters = parseVmstat(fixture("proc-vmstat-no-oom.txt"));
  assertEquals(counters.oomKill, null);
  assertEquals(counters.pswpin, 100);
});

test("vmstatRates computes correct rate math", () => {
  const tracker = new CounterBaselineTracker();
  const first = parseVmstat(fixture("proc-vmstat-1.txt"));
  const second = parseVmstat(fixture("proc-vmstat-2.txt"));

  vmstatRates(first, 60, 4096, tracker, 0);
  const rates = vmstatRates(second, 60, 4096, tracker, 0);

  assertEquals(rates.swapInBytesPerSecond, ((160 - 100) / 60) * 4096);
  assertEquals(rates.swapOutBytesPerSecond, ((380 - 200) / 60) * 4096);
  assertEquals(rates.majorPageFaultsPerSecond, (5300 - 5000) / 60);
});

test("vmstatRates nulls all three on the first observation", () => {
  const tracker = new CounterBaselineTracker();
  const counters = parseVmstat(fixture("proc-vmstat-1.txt"));
  const rates = vmstatRates(counters, 60, 4096, tracker, 0);
  assertEquals(rates, {
    swapInBytesPerSecond: null,
    swapOutBytesPerSecond: null,
    majorPageFaultsPerSecond: null,
  });
});

test("resolvePageSizeBytes returns the host value on a non-4096 kernel page size", () => {
  const bytes = resolvePageSizeBytes({
    runGetconf: () => ({
      code: 0,
      stdout: new TextEncoder().encode("16384\n"),
    }),
  });
  assertEquals(bytes, 16384);
});

test("resolvePageSizeBytes falls back to 4096 when getconf fails", () => {
  const bytes = resolvePageSizeBytes({
    runGetconf: () => ({ code: 1, stdout: new Uint8Array() }),
  });
  assertEquals(bytes, 4096);
});

test("resolvePageSizeBytes falls back to 4096 when getconf throws (e.g. sandboxed --allow-run)", () => {
  const bytes = resolvePageSizeBytes({
    runGetconf: () => {
      throw new Deno.errors.NotCapable("no --allow-run");
    },
  });
  assertEquals(bytes, 4096);
});

test("resolvePageSizeBytes falls back to 4096 on unparsable output", () => {
  const bytes = resolvePageSizeBytes({
    runGetconf: () => ({
      code: 0,
      stdout: new TextEncoder().encode("not-a-number\n"),
    }),
  });
  assertEquals(bytes, 4096);
});

test("vmstatRates nulls all three across a boot generation change (reset)", () => {
  const tracker = new CounterBaselineTracker();
  const first = parseVmstat(fixture("proc-vmstat-1.txt"));
  vmstatRates(first, 60, 4096, tracker, 0);
  const second = parseVmstat(fixture("proc-vmstat-2.txt"));
  const rates = vmstatRates(second, 60, 4096, tracker, 1);
  assertEquals(rates, {
    swapInBytesPerSecond: null,
    swapOutBytesPerSecond: null,
    majorPageFaultsPerSecond: null,
  });
});

test("parseVmstatReclaim sums pgscan_direct and pgscan_kswapd separately (excluding pgscan_direct_throttle), and reads compact_stall", () => {
  const counters = parseVmstatReclaim(fixture("proc-vmstat-reclaim-1.txt"));
  assertEquals(counters, {
    pgscanDirect: 2000,
    pgscanKswapd: 10000,
    compactStall: 40,
  });
});

test("parseVmstatReclaim never folds in pgscan_anon/pgscan_file (a separate by-page-type breakdown) or the throttle counter", () => {
  const counters = parseVmstatReclaim(fixture("proc-vmstat-reclaim-1.txt"));
  // 2000, NOT 2000 + 3 (throttle) nor +5000+7000 (anon/file).
  assertEquals(counters.pgscanDirect, 2000);
});

test("parseVmstatReclaim returns null fields when their vmstat lines are absent", () => {
  const counters = parseVmstatReclaim("nr_free_pages 1000\n");
  assertEquals(counters, {
    pgscanDirect: null,
    pgscanKswapd: null,
    compactStall: null,
  });
});
