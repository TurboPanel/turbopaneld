import { assertEquals } from "@std/assert";
import { CounterBaselineTracker } from "../baseline.ts";
import { parsePrometheusExposition } from "../proxy/prom-exposition.ts";
import {
  DcgmGpuAdapter,
  normalizeDcgmPciBusId,
  parseDcgmGpuReading,
} from "./dcgm-adapter.ts";
import type { GpuReadContext } from "./adapter.ts";
import type { GpuTopology } from "../../topology/types.ts";

const test = Deno.test.bind(Deno);

const TWO_GPU_EXPOSITION = `
# HELP DCGM_FI_DEV_GPU_UTIL GPU utilization
# TYPE DCGM_FI_DEV_GPU_UTIL gauge
DCGM_FI_DEV_GPU_UTIL{gpu="0",UUID="GPU-aaa",pci_bus_id="00000000:01:00.0"} 42
DCGM_FI_DEV_GPU_UTIL{gpu="1",UUID="GPU-bbb",pci_bus_id="00000000:02:00.0"} 7
# HELP DCGM_FI_DEV_FB_USED Framebuffer used (MiB)
# TYPE DCGM_FI_DEV_FB_USED gauge
DCGM_FI_DEV_FB_USED{gpu="0",UUID="GPU-aaa",pci_bus_id="00000000:01:00.0"} 1024
# HELP DCGM_FI_DEV_GPU_TEMP GPU temperature
# TYPE DCGM_FI_DEV_GPU_TEMP gauge
DCGM_FI_DEV_GPU_TEMP{gpu="0",UUID="GPU-aaa",pci_bus_id="00000000:01:00.0"} 61
# HELP DCGM_FI_DEV_POWER_USAGE Power usage (W)
# TYPE DCGM_FI_DEV_POWER_USAGE gauge
DCGM_FI_DEV_POWER_USAGE{gpu="0",UUID="GPU-aaa",pci_bus_id="00000000:01:00.0"} 210.5
# HELP DCGM_FI_DEV_THERMAL_VIOLATION Cumulative thermal violation time (us)
# TYPE DCGM_FI_DEV_THERMAL_VIOLATION counter
DCGM_FI_DEV_THERMAL_VIOLATION{gpu="0",UUID="GPU-aaa",pci_bus_id="00000000:01:00.0"} 1000000
`;

// A vGPU profile exposition missing MEMORY_TEMP/THERMAL_VIOLATION entirely.
const VGPU_EXPOSITION = `
# HELP DCGM_FI_DEV_GPU_UTIL GPU utilization
# TYPE DCGM_FI_DEV_GPU_UTIL gauge
DCGM_FI_DEV_GPU_UTIL{gpu="0",UUID="GPU-vgpu",pci_bus_id="00000000:03:00.0"} 12
# HELP DCGM_FI_DEV_FB_USED Framebuffer used (MiB)
# TYPE DCGM_FI_DEV_FB_USED gauge
DCGM_FI_DEV_FB_USED{gpu="0",UUID="GPU-vgpu",pci_bus_id="00000000:03:00.0"} 256
# HELP DCGM_FI_DEV_GPU_TEMP GPU temperature
# TYPE DCGM_FI_DEV_GPU_TEMP gauge
DCGM_FI_DEV_GPU_TEMP{gpu="0",UUID="GPU-vgpu",pci_bus_id="00000000:03:00.0"} 50
# HELP DCGM_FI_DEV_POWER_USAGE Power usage (W)
# TYPE DCGM_FI_DEV_POWER_USAGE gauge
DCGM_FI_DEV_POWER_USAGE{gpu="0",UUID="GPU-vgpu",pci_bus_id="00000000:03:00.0"} 45
`;

function gpu(overrides: Partial<GpuTopology> = {}): GpuTopology {
  return {
    gpuId: "pci:0000:01:00.0",
    kind: "drm",
    pciPath: "0000:01:00.0",
    vendor: "nvidia",
    chip: "nvidia",
    ...overrides,
  };
}

function ctx(overrides: Partial<GpuReadContext> = {}): GpuReadContext {
  return {
    tracker: new CounterBaselineTracker(),
    bootGeneration: 1,
    seconds: 60,
    ...overrides,
  };
}

test("normalizeDcgmPciBusId collapses the 8-hex-digit DCGM domain to sysfs' 4-hex-digit form", () => {
  assertEquals(normalizeDcgmPciBusId("00000000:01:00.0"), "0000:01:00.0");
  assertEquals(normalizeDcgmPciBusId("00000000:1A:00.0"), "0000:1a:00.0");
  assertEquals(normalizeDcgmPciBusId("not-a-pci-id"), "not-a-pci-id");
});

test("parseDcgmGpuReading maps every current field and converts MiB to bytes", () => {
  const samples = parsePrometheusExposition(TWO_GPU_EXPOSITION);
  const tracker = new CounterBaselineTracker();
  // Prime the violation-counter baseline — a tracker's first observation is
  // always `null`, mirroring how the collector's tracker persists tick to
  // tick rather than being recreated per-call.
  tracker.rate("gpu:dcgm:pci:0000:01:00.0:violation", 0, 1, 60);

  const reading = parseDcgmGpuReading(samples, gpu(), ctx({ tracker }));
  assertEquals(reading?.utilizationPercent, 42);
  assertEquals(reading?.memoryUsedBytes, 1024 * 1024 * 1024);
  assertEquals(reading?.temperatureCelsius, 61);
  assertEquals(reading?.powerWatts, 210.5);
  // 1,000,000us of violation over a 60s interval = 1s/60s = ~1.67%.
  assertEquals(
    Math.round((reading?.throttlePercent ?? 0) * 100) / 100,
    1.67,
  );
});

test("parseDcgmGpuReading correlates by pci_bus_id and never mixes two GPUs' series", () => {
  const samples = parsePrometheusExposition(TWO_GPU_EXPOSITION);
  const reading = parseDcgmGpuReading(
    samples,
    gpu({ pciPath: "0000:02:00.0" }),
    ctx(),
  );
  assertEquals(reading?.utilizationPercent, 7);
  // GPU 1 has no FB_USED/TEMP/POWER series at all in the fixture.
  assertEquals(reading?.memoryUsedBytes, undefined);
  assertEquals(reading?.temperatureCelsius, undefined);
});

test("parseDcgmGpuReading returns null when the GPU's pci_bus_id is absent from the exposition", () => {
  const samples = parsePrometheusExposition(TWO_GPU_EXPOSITION);
  const reading = parseDcgmGpuReading(
    samples,
    gpu({ pciPath: "0000:99:00.0" }),
    ctx(),
  );
  assertEquals(reading, null);
});

test("parseDcgmGpuReading leaves vGPU-missing fields unset rather than fabricating values", () => {
  const samples = parsePrometheusExposition(VGPU_EXPOSITION);
  const reading = parseDcgmGpuReading(
    samples,
    gpu({ pciPath: "0000:03:00.0" }),
    ctx(),
  );
  assertEquals(reading?.utilizationPercent, 12);
  assertEquals(reading?.memoryTemperatureCelsius, undefined);
  assertEquals(reading?.throttlePercent, undefined);
});

test("DcgmGpuAdapter.read returns null for a non-NVIDIA GPU without scraping", async () => {
  let scraped = false;
  const adapter = new DcgmGpuAdapter({
    fetchText: () => {
      scraped = true;
      return Promise.resolve(TWO_GPU_EXPOSITION);
    },
  });
  const reading = await adapter.read(gpu({ vendor: "amd" }), ctx());
  assertEquals(reading, null);
  assertEquals(scraped, false);
});

test("DcgmGpuAdapter.read returns null when the endpoint is unreachable", async () => {
  const adapter = new DcgmGpuAdapter({
    fetchText: () => Promise.resolve(undefined),
  });
  const reading = await adapter.read(gpu(), ctx());
  assertEquals(reading, null);
});

test("DcgmGpuAdapter.read returns null when the body has none of the expected metric names", async () => {
  const adapter = new DcgmGpuAdapter({
    fetchText: () => Promise.resolve("some_unrelated_metric 1\n"),
  });
  const reading = await adapter.read(gpu(), ctx());
  assertEquals(reading, null);
});

test("DcgmGpuAdapter.read succeeds on a valid scrape", async () => {
  const adapter = new DcgmGpuAdapter({
    fetchText: () => Promise.resolve(TWO_GPU_EXPOSITION),
  });
  const reading = await adapter.read(gpu(), ctx());
  assertEquals(reading?.utilizationPercent, 42);
});

test("parseDcgmGpuReading returns null when the GPU has no PCI path", () => {
  const samples = parsePrometheusExposition(TWO_GPU_EXPOSITION);
  assertEquals(parseDcgmGpuReading(samples, gpu({ pciPath: "" }), ctx()), null);
});

test("parseDcgmGpuReading maps memory-activity, memory-temp, and PCIe series when present", () => {
  const text = `${TWO_GPU_EXPOSITION}
DCGM_FI_DEV_MEM_COPY_UTIL{gpu="0",UUID="GPU-aaa",pci_bus_id="00000000:01:00.0"} 18
DCGM_FI_DEV_MEMORY_TEMP{gpu="0",UUID="GPU-aaa",pci_bus_id="00000000:01:00.0"} 72
DCGM_FI_PROF_PCIE_RX_BYTES{gpu="0",UUID="GPU-aaa",pci_bus_id="00000000:01:00.0"} 4096
DCGM_FI_PROF_PCIE_TX_BYTES{gpu="0",UUID="GPU-aaa",pci_bus_id="00000000:01:00.0"} 2048
`;
  const reading = parseDcgmGpuReading(
    parsePrometheusExposition(text),
    gpu(),
    ctx(),
  );
  assertEquals(reading?.memoryActivityPercent, 18);
  assertEquals(reading?.memoryTemperatureCelsius, 72);
  assertEquals(reading?.pcieReceiveBytesPerSecond, 4096);
  assertEquals(reading?.pcieTransmitBytesPerSecond, 2048);
});

test("DcgmGpuAdapter.probe is a no-op and a throwing parse degrades the read to null", async () => {
  const adapter = new DcgmGpuAdapter({
    fetchText: () => Promise.resolve(TWO_GPU_EXPOSITION),
  });
  await adapter.probe();
  const tracker = {
    rate: () => {
      throw new Error("tracker failed");
    },
  } as unknown as CounterBaselineTracker;
  assertEquals(await adapter.read(gpu(), ctx({ tracker })), null);
});
