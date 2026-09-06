import { assertEquals } from "@std/assert";
import { CounterBaselineTracker } from "../baseline.ts";
import { buildGpuSamples } from "./index.ts";
import type {
  GpuAdapter,
  GpuAdapterSet,
  GpuReadContext,
  GpuReading,
} from "./adapter.ts";
import type { GpuTopology } from "../../topology/types.ts";

const test = Deno.test.bind(Deno);

function gpu(overrides: Partial<GpuTopology> = {}): GpuTopology {
  return {
    gpuId: "pci:0000:01:00.0",
    kind: "drm",
    pciPath: "0000:01:00.0",
    vendor: "amd",
    chip: "amdgpu",
    ...overrides,
  };
}

function fakeAdapter(
  id: GpuAdapter["id"],
  read: (
    gpu: GpuTopology,
    ctx: GpuReadContext,
  ) => Promise<GpuReading | null> | GpuReading | null,
): GpuAdapter {
  return {
    id,
    probe: () => Promise.resolve(),
    read: async (g, ctx) => await read(g, ctx),
  };
}

function nullAdapter(id: GpuAdapter["id"]): GpuAdapter {
  return fakeAdapter(id, () => null);
}

function ctx(overrides: Partial<GpuReadContext> = {}): {
  tracker: CounterBaselineTracker;
  bootGeneration: number;
  seconds: number;
} {
  return {
    tracker: new CounterBaselineTracker(),
    bootGeneration: 1,
    seconds: 60,
    ...overrides,
  };
}

test("buildGpuSamples never drops a topology-enumerated GPU even when every adapter returns null", async () => {
  const adapters: GpuAdapterSet = {
    dcgm: nullAdapter("dcgm"),
    nvml: nullAdapter("nvml"),
    sysfs: nullAdapter("sysfs"),
  };
  const samples = await buildGpuSamples(
    [gpu({ gpuId: "gpu-a" }), gpu({ gpuId: "gpu-b" })],
    adapters,
    ctx(),
  );
  assertEquals(samples.length, 2);
  assertEquals(samples.map((s) => s.gpuId), ["gpu-a", "gpu-b"]);
  for (const sample of samples) {
    assertEquals(sample.utilizationPercent, null);
    assertEquals(sample.memoryUsedBytes, null);
    assertEquals(sample.throttlePercent, null);
  }
});

test("buildGpuSamples routes AMD/Intel GPUs to sysfs only, never dcgm/nvml", async () => {
  let sysfsCalled = false;
  const adapters: GpuAdapterSet = {
    dcgm: fakeAdapter("dcgm", () => {
      throw new Error("dcgm must never be consulted for a non-NVIDIA GPU");
    }),
    nvml: fakeAdapter("nvml", () => {
      throw new Error("nvml must never be consulted for a non-NVIDIA GPU");
    }),
    sysfs: fakeAdapter("sysfs", () => {
      sysfsCalled = true;
      return { utilizationPercent: 42 };
    }),
  };
  const samples = await buildGpuSamples(
    [gpu({ vendor: "amd" })],
    adapters,
    ctx(),
  );
  assertEquals(sysfsCalled, true);
  assertEquals(samples[0].utilizationPercent, 42);
});

test("buildGpuSamples: NVIDIA GPUs prefer DCGM per field, backfilling only what DCGM left unset from NVML", async () => {
  let nvmlCalled = false;
  const adapters: GpuAdapterSet = {
    dcgm: fakeAdapter("dcgm", () => ({ utilizationPercent: 55 })),
    nvml: fakeAdapter("nvml", () => {
      nvmlCalled = true;
      return { utilizationPercent: 10, powerWatts: 200 };
    }),
    sysfs: nullAdapter("sysfs"),
  };
  const samples = await buildGpuSamples(
    [gpu({ vendor: "nvidia" })],
    adapters,
    ctx(),
  );
  // DCGM is still consulted and still wins any field it has a value for —
  // its utilizationPercent is never overridden by NVML's. But DCGM leaving
  // powerWatts unset for this GPU no longer strands the field at `null`
  // when NVML (a real reading of the same physical GPU) has it.
  assertEquals(nvmlCalled, true);
  assertEquals(samples[0].utilizationPercent, 55);
  assertEquals(samples[0].powerWatts, 200);
});

test("buildGpuSamples: DCGM's own null for a field it attempted (e.g. throttlePercent not yet computable) still falls through to NVML", async () => {
  const adapters: GpuAdapterSet = {
    dcgm: fakeAdapter("dcgm", () => ({
      utilizationPercent: 55,
      throttlePercent: null,
    })),
    nvml: fakeAdapter("nvml", () => ({ throttlePercent: 12 })),
    sysfs: nullAdapter("sysfs"),
  };
  const samples = await buildGpuSamples(
    [gpu({ vendor: "nvidia" })],
    adapters,
    ctx(),
  );
  assertEquals(samples[0].utilizationPercent, 55);
  assertEquals(samples[0].throttlePercent, 12);
});

test("buildGpuSamples: NVIDIA falls back to NVML when DCGM has nothing for this GPU", async () => {
  const adapters: GpuAdapterSet = {
    dcgm: nullAdapter("dcgm"),
    nvml: fakeAdapter("nvml", () => ({ powerWatts: 250 })),
    sysfs: nullAdapter("sysfs"),
  };
  const samples = await buildGpuSamples(
    [gpu({ vendor: "nvidia" })],
    adapters,
    ctx(),
  );
  assertEquals(samples[0].powerWatts, 250);
  assertEquals(samples[0].utilizationPercent, null);
});

test("buildGpuSamples treats a throwing adapter the same as a null reading and falls through", async () => {
  const adapters: GpuAdapterSet = {
    dcgm: fakeAdapter("dcgm", () => {
      throw new Error("scrape blew up");
    }),
    nvml: fakeAdapter("nvml", () => ({ temperatureCelsius: 61 })),
    sysfs: nullAdapter("sysfs"),
  };
  const samples = await buildGpuSamples(
    [gpu({ vendor: "nvidia" })],
    adapters,
    ctx(),
  );
  assertEquals(samples[0].temperatureCelsius, 61);
});

test("buildGpuSamples invalidates baseline keys for a GPU with no reading this tick", async () => {
  const tracker = new CounterBaselineTracker();
  // Seed a prior violation-counter baseline, as if NVML had reported before.
  tracker.rate("gpu:nvml:gpu-a:violation", 1000, 1, 60);

  const adapters: GpuAdapterSet = {
    dcgm: nullAdapter("dcgm"),
    nvml: nullAdapter("nvml"),
    sysfs: nullAdapter("sysfs"),
  };
  await buildGpuSamples(
    [gpu({ gpuId: "gpu-a", vendor: "nvidia" })],
    adapters,
    ctx({ tracker }),
  );

  // A lower value after invalidation reads as a fresh first-observation
  // (`null`), never a spurious negative delta against the stale baseline.
  const rate = tracker.rate("gpu:nvml:gpu-a:violation", 500, 1, 60);
  assertEquals(rate, null);
});

test("buildGpuSamples merges a partial reading with every unset field as null", async () => {
  const adapters: GpuAdapterSet = {
    dcgm: nullAdapter("dcgm"),
    nvml: nullAdapter("nvml"),
    sysfs: fakeAdapter("sysfs", () => ({ temperatureCelsius: 55 })),
  };
  const samples = await buildGpuSamples([gpu()], adapters, ctx());
  const sample = samples[0];
  assertEquals(sample.temperatureCelsius, 55);
  assertEquals(sample.utilizationPercent, null);
  assertEquals(sample.memoryUsedBytes, null);
  assertEquals(sample.memoryActivityPercent, null);
  assertEquals(sample.memoryTemperatureCelsius, null);
  assertEquals(sample.powerWatts, null);
  assertEquals(sample.pcieReceiveBytesPerSecond, null);
  assertEquals(sample.pcieTransmitBytesPerSecond, null);
  assertEquals(sample.throttlePercent, null);
});
