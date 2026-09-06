/**
 * DCGM (`dcgm-exporter`) GPU adapter — scrapes the default loopback
 * Prometheus exposition (`127.0.0.1:9400/metrics`) and correlates each
 * series' `pci_bus_id` label to topology `GpuTopology.pciPath`. Reuses the
 * shared scrape/retry primitives (`proxy/prom-exposition.ts`,
 * `proxy/endpoint-cache.ts`) the Caddy/ProxySQL traffic scrapers already
 * use — a successful scrape is never cached (values change every tick),
 * only a failure is remembered, so a stopped/absent dcgm-exporter is not
 * re-dialed every interval forever.
 *
 * Field mapping is verified against current (non-deprecated) DCGM field
 * names. Any field absent from a given exposition body (older DCGM, an
 * unsupported GPU, a vGPU profile) stays unset here — the orchestrator
 * treats an unset field as `null`, never a `KeyError`.
 */
import type { GpuTopology } from "../../topology/types.ts";
import { createRetryBoundedProbe } from "../proxy/endpoint-cache.ts";
import {
  containsAnyMetricName,
  fetchLoopbackText,
  parsePrometheusExposition,
  type PromSample,
} from "../proxy/prom-exposition.ts";
import type { GpuAdapter, GpuReadContext, GpuReading } from "./adapter.ts";

/** dcgm-exporter's default listener. */
export const DCGM_EXPORTER_ADDR = "127.0.0.1:9400";

const BYTES_PER_MIB = 1024 * 1024;

/**
 * Every metric name this adapter reads. A scrape containing none of these
 * is not a dcgm-exporter response — an empty body or the wrong loopback
 * service answering on {@link DCGM_EXPORTER_ADDR} both look the same
 * otherwise.
 */
const DCGM_EXPECTED_METRIC_NAMES = [
  "DCGM_FI_DEV_GPU_UTIL",
  "DCGM_FI_DEV_FB_USED",
  "DCGM_FI_DEV_GPU_TEMP",
  "DCGM_FI_DEV_POWER_USAGE",
] as const;

/**
 * Normalize DCGM's `pci_bus_id` label (`00000000:XX:YY.Z`, an 8-hex-digit
 * domain) to the same `0000:XX:YY.Z` (4-hex-digit domain) shape sysfs'
 * `PCI_SLOT_NAME` produces (`topology/identity.ts`'s `parsePciSlotName`),
 * so both sides compare equal.
 */
export function normalizeDcgmPciBusId(pciBusId: string): string {
  const trimmed = pciBusId.trim().toLowerCase();
  const parts = trimmed.split(":");
  if (parts.length !== 3) return trimmed;
  const [domain, bus, deviceFunction] = parts as [string, string, string];
  return `${domain.slice(-4).padStart(4, "0")}:${bus}:${deviceFunction}`;
}

function samplesForGpu(
  samples: readonly PromSample[],
  pciPath: string,
): PromSample[] {
  const target = pciPath.toLowerCase();
  return samples.filter((sample) => {
    const raw = sample.labels.pci_bus_id;
    return raw !== undefined && normalizeDcgmPciBusId(raw) === target;
  });
}

function firstValue(
  samples: readonly PromSample[],
  name: string,
): number | undefined {
  return samples.find((sample) => sample.name === name)?.value;
}

/**
 * Pure per-GPU field extraction from an already-scraped, already-gated
 * sample set — exported for fixture tests. `null` when no series names
 * `gpu.pciPath` at all (this GPU is absent from the exposition, e.g. a
 * driver reload mid-scrape); otherwise every present field is set and every
 * absent one is left unset (never a fabricated `0`).
 */
export function parseDcgmGpuReading(
  samples: readonly PromSample[],
  gpu: GpuTopology,
  ctx: GpuReadContext,
): GpuReading | null {
  if (!gpu.pciPath) return null;
  const own = samplesForGpu(samples, gpu.pciPath);
  if (own.length === 0) return null;

  const reading: GpuReading = {};

  const utilization = firstValue(own, "DCGM_FI_DEV_GPU_UTIL");
  if (utilization !== undefined) reading.utilizationPercent = utilization;

  const framebufferUsedMib = firstValue(own, "DCGM_FI_DEV_FB_USED");
  if (framebufferUsedMib !== undefined) {
    reading.memoryUsedBytes = framebufferUsedMib * BYTES_PER_MIB;
  }

  const memoryActivity = firstValue(own, "DCGM_FI_DEV_MEM_COPY_UTIL");
  if (memoryActivity !== undefined) {
    reading.memoryActivityPercent = memoryActivity;
  }

  const temperature = firstValue(own, "DCGM_FI_DEV_GPU_TEMP");
  if (temperature !== undefined) reading.temperatureCelsius = temperature;

  const memoryTemperature = firstValue(own, "DCGM_FI_DEV_MEMORY_TEMP");
  if (memoryTemperature !== undefined) {
    reading.memoryTemperatureCelsius = memoryTemperature;
  }

  const power = firstValue(own, "DCGM_FI_DEV_POWER_USAGE");
  if (power !== undefined) reading.powerWatts = power;

  const pcieRx = firstValue(own, "DCGM_FI_PROF_PCIE_RX_BYTES");
  if (pcieRx !== undefined) reading.pcieReceiveBytesPerSecond = pcieRx;

  const pcieTx = firstValue(own, "DCGM_FI_PROF_PCIE_TX_BYTES");
  if (pcieTx !== undefined) reading.pcieTransmitBytesPerSecond = pcieTx;

  const thermalViolationMicroseconds = firstValue(
    own,
    "DCGM_FI_DEV_THERMAL_VIOLATION",
  );
  if (thermalViolationMicroseconds !== undefined) {
    const rate = ctx.tracker.rate(
      `gpu:dcgm:${gpu.gpuId}:violation`,
      thermalViolationMicroseconds,
      ctx.bootGeneration,
      ctx.seconds,
    );
    reading.throttlePercent = rate === null
      ? null
      : Math.min(100, Math.max(0, (rate / 1e6) * 100));
  }

  return reading;
}

export class DcgmGpuAdapter implements GpuAdapter {
  readonly id = "dcgm" as const;
  readonly #scrape: () => Promise<PromSample[] | null>;

  constructor(deps?: {
    addr?: string;
    now?: () => number;
    fetchText?: (addr: string, path: string) => Promise<string | undefined>;
  }) {
    const addr = deps?.addr ?? DCGM_EXPORTER_ADDR;
    const fetchText = deps?.fetchText ?? fetchLoopbackText;
    this.#scrape = createRetryBoundedProbe(async () => {
      const text = await fetchText(addr, "/metrics");
      if (text === undefined) return null;
      const samples = parsePrometheusExposition(text);
      if (!containsAnyMetricName(samples, DCGM_EXPECTED_METRIC_NAMES)) {
        return null;
      }
      return samples;
    }, deps?.now);
  }

  async probe(): Promise<void> {
    // Reachability is re-checked every tick via the retry-bounded scrape
    // itself — there is nothing separate to memoize up front.
  }

  async read(
    gpu: GpuTopology,
    ctx: GpuReadContext,
  ): Promise<GpuReading | null> {
    if (gpu.vendor !== "nvidia") return null;
    const samples = await this.#scrape();
    if (!samples) return null;
    try {
      return parseDcgmGpuReading(samples, gpu, ctx);
    } catch {
      return null;
    }
  }
}
