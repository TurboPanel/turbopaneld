/**
 * Sensor discovery: enumerate temperature/power sources under sysfs.
 *
 * Sources, all async file reads (no subprocess per interval):
 * - hwmon (`/sys/class/hwmon`) — chip `name` plus `tempN_input`/`tempN_label`
 *   (CPU chips like coretemp/k10temp; GPU chips like amdgpu/nouveau, which
 *   register here too, so a separate DRM `card` node traversal under
 *   `/sys/class/drm` would only rediscover the same devices) and GPU
 *   `power1_average` gauges.
 * - thermal zones (`/sys/class/thermal`) — `{type,temp}` CPU zones for
 *   boards without a dedicated hwmon CPU chip.
 * - RAPL (`/sys/class/powercap`, `intel-rapl:N` package domains) — energy
 *   counters (`energy_uj`), consumed as two-snapshot deltas by `power.ts`.
 *
 * NVIDIA GPU power is only answerable via `nvidia-smi`, which would violate
 * the no-subprocess-per-interval rule — it stays unsupported (`null`).
 *
 * Every candidate carries a stable identity `{ chip, label, path }` — never a
 * bare `hwmonN` index. On a multi-GPU system exactly one GPU (first
 * enumerated, or the admin-override match) feeds the fixed contract.
 */
import { readProcFile } from "../proc-read.ts";
import type { SensorCandidate } from "../types.ts";

/** Injectable sysfs access for fixture-driven tests. */
export type SensorIo = {
  /** Entry names in a directory; `[]` when missing/unreadable. */
  listDir: (path: string) => Promise<string[]> | string[];
  readFile: (path: string) => Promise<string | undefined> | string | undefined;
};

export function defaultSensorIo(): SensorIo {
  return {
    async listDir(path: string): Promise<string[]> {
      try {
        const names: string[] = [];
        for await (const entry of Deno.readDir(path)) {
          names.push(entry.name);
        }
        return names.sort((a, b) => a.localeCompare(b));
      } catch {
        return [];
      }
    },
    readFile: (path: string) => readProcFile(path),
  };
}

/**
 * One physical GPU's candidates, grouped by its hwmon chip directory (a
 * within-snapshot device identity). Selection picks one device first, then
 * resolves temperature AND power from that same device — a v2 sample never
 * mixes two GPUs.
 */
export type GpuDeviceCandidates = {
  /** hwmon chip directory backing this device — stable within a snapshot. */
  path: string;
  chip: string;
  temperature: SensorCandidate[];
  power: SensorCandidate[];
};

export type SensorCapabilities = {
  cpuTemperature: SensorCandidate[];
  gpuTemperature: SensorCandidate[];
  cpuPower: SensorCandidate[];
  gpuPower: SensorCandidate[];
  /** GPU candidates grouped per device; flat arrays above are the concatenation. */
  gpuDevices: GpuDeviceCandidates[];
};

const CPU_HWMON_CHIPS: ReadonlySet<string> = new Set([
  "coretemp",
  "k10temp",
  "zenpower",
  "cpu_thermal",
]);

const GPU_HWMON_CHIPS: ReadonlySet<string> = new Set([
  "amdgpu",
  "nouveau",
  "radeon",
]);

const CPU_THERMAL_ZONE_TYPES: ReadonlySet<string> = new Set([
  "x86_pkg_temp",
  "cpu-thermal",
  "cpu_thermal",
]);

/** Package-level labels sort first so auto-detection picks the die/package probe. */
const PREFERRED_CPU_TEMP_LABELS = ["Package id 0", "Tctl", "Tdie"] as const;
const PREFERRED_GPU_TEMP_LABELS = ["edge", "junction"] as const;

const TEMP_INPUT_RE = /^temp(\d+)_input$/;
const RAPL_PACKAGE_DIR_RE = /^intel-rapl:\d+$/;

function labelRank(label: string, preferred: readonly string[]): number {
  const index = preferred.indexOf(label);
  return index === -1 ? preferred.length : index;
}

async function hwmonTempCandidates(
  dir: string,
  chip: string,
  entries: string[],
  io: SensorIo,
  preferred: readonly string[],
): Promise<SensorCandidate[]> {
  const candidates: SensorCandidate[] = [];
  for (const entry of entries) {
    const match = TEMP_INPUT_RE.exec(entry);
    if (!match) continue;
    const labelRaw = await io.readFile(`${dir}/temp${match[1]}_label`);
    const label = labelRaw?.trim() || `temp${match[1]}`;
    candidates.push({ chip, label, path: `${dir}/${entry}` });
  }
  candidates.sort((a, b) =>
    labelRank(a.label, preferred) - labelRank(b.label, preferred) ||
    a.path.localeCompare(b.path)
  );
  return candidates;
}

/** One hwmon GPU chip's grouped candidates (temperature plus `power1_average`). */
async function hwmonGpuDevice(
  dir: string,
  chip: string,
  files: string[],
  io: SensorIo,
): Promise<GpuDeviceCandidates> {
  const temperature = await hwmonTempCandidates(
    dir,
    chip,
    files,
    io,
    PREFERRED_GPU_TEMP_LABELS,
  );
  const power: SensorCandidate[] = [];
  if (files.includes("power1_average")) {
    const labelRaw = await io.readFile(`${dir}/power1_label`);
    power.push({
      chip,
      label: labelRaw?.trim() || "power1",
      path: `${dir}/power1_average`,
    });
  }
  return { path: dir, chip, temperature, power };
}

async function discoverHwmonSensors(
  root: string,
  io: SensorIo,
  capabilities: SensorCapabilities,
): Promise<void> {
  const hwmonRoot = `${root}/class/hwmon`;
  for (const entry of await io.listDir(hwmonRoot)) {
    const dir = `${hwmonRoot}/${entry}`;
    const chip = (await io.readFile(`${dir}/name`))?.trim();
    if (!chip) continue;
    const files = await io.listDir(dir);

    if (CPU_HWMON_CHIPS.has(chip)) {
      capabilities.cpuTemperature.push(
        ...await hwmonTempCandidates(
          dir,
          chip,
          files,
          io,
          PREFERRED_CPU_TEMP_LABELS,
        ),
      );
    }
    if (GPU_HWMON_CHIPS.has(chip)) {
      const device = await hwmonGpuDevice(dir, chip, files, io);
      capabilities.gpuTemperature.push(...device.temperature);
      capabilities.gpuPower.push(...device.power);
      if (device.temperature.length > 0 || device.power.length > 0) {
        capabilities.gpuDevices.push(device);
      }
    }
  }
}

async function discoverThermalZoneSensors(
  root: string,
  io: SensorIo,
  capabilities: SensorCapabilities,
): Promise<void> {
  const thermalRoot = `${root}/class/thermal`;
  for (const entry of await io.listDir(thermalRoot)) {
    if (!entry.startsWith("thermal_zone")) continue;
    const dir = `${thermalRoot}/${entry}`;
    const type = (await io.readFile(`${dir}/type`))?.trim();
    if (!type) continue;
    if (!CPU_THERMAL_ZONE_TYPES.has(type)) continue;
    capabilities.cpuTemperature.push({
      chip: "thermal",
      label: type,
      path: `${dir}/temp`,
    });
  }
}

async function discoverRaplSensors(
  root: string,
  io: SensorIo,
  capabilities: SensorCapabilities,
): Promise<void> {
  const powercapRoot = `${root}/class/powercap`;
  for (const entry of await io.listDir(powercapRoot)) {
    // Top-level package domains only — `intel-rapl:0:0` subdomains (core,
    // uncore, dram) would double-count the package counter.
    if (!RAPL_PACKAGE_DIR_RE.test(entry)) continue;
    const dir = `${powercapRoot}/${entry}`;
    const name = (await io.readFile(`${dir}/name`))?.trim();
    if (!name?.startsWith("package")) continue;
    capabilities.cpuPower.push({
      chip: "intel-rapl",
      label: name,
      path: `${dir}/energy_uj`,
    });
  }
}

/** Enumerate all candidate sensors under `root` (default `/sys`). */
export async function discoverSensors(
  root = "/sys",
  io: SensorIo = defaultSensorIo(),
): Promise<SensorCapabilities> {
  const capabilities: SensorCapabilities = {
    cpuTemperature: [],
    gpuTemperature: [],
    cpuPower: [],
    gpuPower: [],
    gpuDevices: [],
  };
  await discoverHwmonSensors(root, io, capabilities);
  await discoverThermalZoneSensors(root, io, capabilities);
  await discoverRaplSensors(root, io, capabilities);
  return capabilities;
}

/** Stable sensor identity string for dimensions — `chip:label`, never `hwmonN`. */
export function sensorId(candidate: SensorCandidate): string {
  return `${candidate.chip}:${candidate.label}`;
}

/**
 * Pick exactly one GPU device to feed the fixed contract: the device owning
 * an admin-override path when one matches, else the first enumerated device
 * exposing both temperature and power, else the first device. Temperature
 * and power then both resolve from the returned device only.
 */
export function selectGpuDevice(
  devices: GpuDeviceCandidates[],
  overrides: { gpuTemperature?: string; gpuPower?: string },
): GpuDeviceCandidates | undefined {
  for (const path of [overrides.gpuTemperature, overrides.gpuPower]) {
    if (!path) continue;
    const matched = devices.find((device) =>
      device.temperature.some((c) => c.path === path) ||
      device.power.some((c) => c.path === path)
    );
    if (matched) return matched;
  }
  return devices.find((device) =>
    device.temperature.length > 0 && device.power.length > 0
  ) ?? devices[0];
}

/**
 * Pick exactly one candidate: the admin override when set (matched against
 * discovered candidates by path, or taken verbatim so an operator can point
 * at any readable file), else the first auto-detected candidate, else none.
 */
export function selectCandidate(
  candidates: SensorCandidate[],
  overridePath: string | undefined,
): SensorCandidate | undefined {
  if (overridePath) {
    const matched = candidates.find((c) => c.path === overridePath);
    if (matched) return matched;
    return { chip: "override", label: overridePath, path: overridePath };
  }
  return candidates[0];
}
