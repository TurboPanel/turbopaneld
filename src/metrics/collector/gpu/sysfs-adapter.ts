/**
 * Sysfs/DRM/hwmon GPU adapter — AMD and Intel utilization/power/temperature,
 * built on the same hwmon/DRM discovery `sensors/discovery.ts` already
 * performs for the fixed-contract v3 sensor snapshot. NVIDIA GPUs are never
 * routed through this adapter (see `gpu/index.ts`'s vendor-scoped adapter
 * order) — NVIDIA telemetry comes from DCGM/NVML only.
 *
 * `memoryActivityPercent`, PCIe throughput, and `throttlePercent` stay
 * `null` — there is no stable AMD/Intel consumer-part sysfs source for any
 * of them.
 */
import {
  defaultSensorIo,
  discoverSensors,
  type GpuDeviceCandidates,
  type SensorIo,
} from "../sensors/discovery.ts";
import { readGpuPower } from "../sensors/power.ts";
import {
  readTemperatureValue,
  resolveTemperature,
} from "../sensors/temperature.ts";
import { readGpuUtilization } from "../sensors/utilization.ts";
import { parsePciSlotName } from "../../topology/identity.ts";
import type { GpuTopology } from "../../topology/types.ts";
import type { GpuAdapter, GpuReadContext, GpuReading } from "./adapter.ts";

const AMD_HWMON_CHIP = "amdgpu";
/** amdgpu's distinct VRAM-junction hwmon label (RDNA2+) — never `junction`, which is the GPU-die hotspot, not memory. */
const MEMORY_TEMPERATURE_LABEL = "mem";

async function devicePciPath(
  device: GpuDeviceCandidates,
  io: SensorIo,
): Promise<string | undefined> {
  const uevent = await io.readFile(`${device.path}/device/uevent`);
  return uevent ? parsePciSlotName(uevent) : undefined;
}

/**
 * Correlate a topology GPU to its discovered hwmon/DRM device candidates by
 * PCI slot path — the same identity topology already derived — rather than
 * re-deriving `gpuId`. A hash-fallback identity (no PCI path resolvable)
 * falls back to chip-name matching, which is only unambiguous on a
 * single-GPU host of that chip; multi-GPU hosts of the same chip always
 * have a resolvable PCI path in practice.
 */
async function matchDevice(
  devices: GpuDeviceCandidates[],
  gpu: GpuTopology,
  io: SensorIo,
): Promise<GpuDeviceCandidates | undefined> {
  if (gpu.pciPath) {
    for (const device of devices) {
      if ((await devicePciPath(device, io)) === gpu.pciPath) return device;
    }
    return undefined;
  }
  return devices.find((device) => device.chip === gpu.chip);
}

async function readAmdVramUsedBytes(
  device: GpuDeviceCandidates,
  io: SensorIo,
): Promise<number | null> {
  if (device.chip !== AMD_HWMON_CHIP) return null;
  const raw = await io.readFile(`${device.path}/device/mem_info_vram_used`);
  const bytes = Number(raw?.trim());
  return Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
}

/**
 * True memory temperature: only AMD's distinct `mem` hwmon label (RDNA2+
 * VRAM-junction sensor), never `junction` — that label is the GPU-die
 * hotspot proxy, a different physical sensor, and reporting it as memory
 * temperature would fabricate a reading this device never took. Guards
 * against naming the same sensor already selected as the primary GPU
 * temperature, though `mem` never legitimately collides with `edge`/
 * `junction` on real hardware.
 */
async function readMemoryTemperatureCelsius(
  device: GpuDeviceCandidates,
  primarySensor: string | undefined,
  io: SensorIo,
): Promise<number | null> {
  const memory = device.temperature.find((c) =>
    c.label === MEMORY_TEMPERATURE_LABEL
  );
  if (!memory) return null;
  const memoryId = `${memory.chip}:${memory.label}`;
  if (memoryId === primarySensor) return null;
  return await readTemperatureValue(memory.path, io);
}

/**
 * Tracker-backed reduction of Intel DRM engine busy-ns counters to a 0-100
 * utilization percent — the busiest engine wins (engines run in parallel,
 * so a sum can exceed 100). Each engine's cumulative counter routes through
 * the shared `CounterBaselineTracker` (first sample / boot change / counter
 * decrease all correctly yield `null` for that engine) instead of a raw
 * two-snapshot diff.
 */
function utilizationFromEngineBusy(
  gpuId: string,
  engines: Record<string, number>,
  ctx: GpuReadContext,
): number | null {
  let sawEngine = false;
  let maxRatio = 0;
  for (const [engine, nanoseconds] of Object.entries(engines)) {
    const rate = ctx.tracker.rate(
      `gpu:sysfs:${gpuId}:engine:${engine}`,
      nanoseconds,
      ctx.bootGeneration,
      ctx.seconds,
    );
    if (rate === null) continue;
    sawEngine = true;
    maxRatio = Math.max(maxRatio, rate / 1e9);
  }
  if (!sawEngine) return null;
  return Math.min(100, maxRatio * 100);
}

export class SysfsGpuAdapter implements GpuAdapter {
  readonly id = "sysfs" as const;
  readonly #io: SensorIo;
  readonly #sysRoot: string;

  constructor(deps?: { io?: SensorIo; sysRoot?: string }) {
    this.#io = deps?.io ?? defaultSensorIo();
    this.#sysRoot = deps?.sysRoot ?? "/sys";
  }

  async probe(): Promise<void> {
    // Sysfs is always reachable on Linux; there is nothing to memoize up
    // front — per-GPU device correlation happens lazily in `read`.
  }

  async read(
    gpu: GpuTopology,
    ctx: GpuReadContext,
  ): Promise<GpuReading | null> {
    try {
      const capabilities = await discoverSensors(this.#sysRoot, this.#io);
      const device = await matchDevice(
        capabilities.gpuDevices,
        gpu,
        this.#io,
      );
      if (!device) return null;

      const [temperature, power, utilization, memoryUsedBytes] = await Promise
        .all([
          resolveTemperature(device.temperature, undefined, this.#io),
          readGpuPower(device.power, undefined, this.#io),
          readGpuUtilization(device.utilization, undefined, this.#io),
          readAmdVramUsedBytes(device, this.#io),
        ]);

      const memoryTemperatureCelsius = await readMemoryTemperatureCelsius(
        device,
        temperature.sensor,
        this.#io,
      );

      const utilizationPercent = utilization.percent ??
        (utilization.busy
          ? utilizationFromEngineBusy(gpu.gpuId, utilization.busy.engines, ctx)
          : null);

      return {
        utilizationPercent,
        memoryUsedBytes,
        memoryActivityPercent: null,
        temperatureCelsius: temperature.celsius,
        memoryTemperatureCelsius,
        powerWatts: power.watts,
        pcieReceiveBytesPerSecond: null,
        pcieTransmitBytesPerSecond: null,
        throttlePercent: null,
      };
    } catch {
      return null;
    }
  }
}
