import { assertEquals } from "@std/assert";
import { CounterBaselineTracker } from "../baseline.ts";
import {
  normalizeNvidiaBusId,
  NvidiaSmiGpuAdapter,
  parseNvidiaSmiNumber,
  parseNvidiaSmiQuery,
} from "./nvidia-smi-adapter.ts";
import type { GpuReadContext } from "./adapter.ts";
import type { GpuTopology } from "../../../contracts/topology-types.ts";

const test = Deno.test.bind(Deno);

/** RTX 5060 Ti, driver 595.80, Debian 13 — captured as the daemon user. */
const RTX_5060_TI_CSV = "00000000:01:00.0, 0, 5, 34, 29, 4.66, 16311\n";

function ctx(): GpuReadContext {
  return {
    tracker: new CounterBaselineTracker(),
    bootGeneration: 1,
    seconds: 60,
  };
}

function gpu(pciPath = "0000:01:00.0"): GpuTopology {
  return {
    gpuId: `pci:${pciPath}`,
    kind: "drm",
    pciPath,
    vendor: "nvidia",
    chip: "nvidia",
  };
}

test("parseNvidiaSmiQuery reads an RTX 5060 Ti / driver 595.80 row", () => {
  assertEquals(
    parseNvidiaSmiQuery(RTX_5060_TI_CSV).get("0000:01:00.0"),
    {
      utilizationPercent: 0,
      memoryActivityPercent: 5,
      memoryUsedBytes: 34 * 1024 * 1024,
      memoryTotalBytes: 16311 * 1024 * 1024,
      temperatureCelsius: 29,
      powerWatts: 4.66,
    },
  );
});

test("parseNvidiaSmiQuery nulls placeholder cells and tolerates unit suffixes", () => {
  const rows = parseNvidiaSmiQuery(
    [
      "00000000:0A:00.0, [N/A], 12 %, 1024 MiB, [Not Supported], 70.5 W",
      "00000000:0B:00.0, N/A, [Unknown Error], [Insufficient Permissions], 41, [N/A]",
      "garbage line",
      "",
    ].join("\n"),
  );
  assertEquals(rows.get("0000:0a:00.0"), {
    utilizationPercent: null,
    memoryActivityPercent: 12,
    memoryUsedBytes: 1024 * 1024 * 1024,
    memoryTotalBytes: null,
    temperatureCelsius: null,
    powerWatts: 70.5,
  });
  assertEquals(rows.get("0000:0b:00.0"), {
    utilizationPercent: null,
    memoryActivityPercent: null,
    memoryUsedBytes: null,
    memoryTotalBytes: null,
    temperatureCelsius: 41,
    powerWatts: null,
  });
  assertEquals(rows.size, 2);
});

test("normalizeNvidiaBusId and parseNvidiaSmiNumber edge cases", () => {
  assertEquals(normalizeNvidiaBusId("00000000:0A:00.0"), "0000:0a:00.0");
  assertEquals(normalizeNvidiaBusId("0000:01:00.0"), "0000:01:00.0");
  assertEquals(parseNvidiaSmiNumber(undefined), null);
  assertEquals(parseNvidiaSmiNumber("-5"), null);
  assertEquals(parseNvidiaSmiNumber("abc"), null);
  assertEquals(parseNvidiaSmiNumber("150 %"), 150);
});

test("NvidiaSmiGpuAdapter maps the row for this GPU and shares one spawn per tick", async () => {
  let runs = 0;
  const adapter = new NvidiaSmiGpuAdapter({
    run: () => {
      runs++;
      return Promise.resolve(RTX_5060_TI_CSV);
    },
    now: () => 1_000,
  });
  const [a, b] = await Promise.all([
    adapter.read(gpu(), ctx()),
    adapter.read(gpu("0000:02:00.0"), ctx()),
  ]);
  assertEquals(runs, 1);
  assertEquals(a?.utilizationPercent, 0);
  assertEquals(a?.memoryActivityPercent, 5);
  assertEquals(a?.memoryUsedBytes, 34 * 1024 * 1024);
  assertEquals(a?.temperatureCelsius, 29);
  assertEquals(a?.powerWatts, 4.66);
  assertEquals(b, null);
  assertEquals(await adapter.read(gpu(""), ctx()), null);
});

test("NvidiaSmiGpuAdapter retries after a failed run but stops once nvidia-smi cannot spawn", async () => {
  let nowMs = 0;
  const results: (string | null | undefined)[] = [
    undefined,
    RTX_5060_TI_CSV,
    null,
  ];
  let runs = 0;
  const adapter = new NvidiaSmiGpuAdapter({
    run: () => Promise.resolve(results[runs++]),
    now: () => nowMs,
  });
  assertEquals(await adapter.read(gpu(), ctx()), null);
  nowMs += 60_000;
  assertEquals((await adapter.read(gpu(), ctx()))?.temperatureCelsius, 29);
  nowMs += 60_000;
  assertEquals(await adapter.read(gpu(), ctx()), null);
  nowMs += 60_000;
  assertEquals(await adapter.read(gpu(), ctx()), null);
  assertEquals(runs, 3);
  await adapter.probe();
});
