/**
 * Sensor discovery: enumerate temperature/power sources under sysfs.
 *
 * Sources, all async file reads (no subprocess per interval). Deno 2
 * `NotCapable`s `Deno.readDir` on `/sys` under `--allow-read` (compiled
 * binaries ask for `--allow-all`); listing uses the same `ls -1` fallback
 * as `/proc` (`processes.ts`). Individual sysfs files already go through
 * {@link readProcFile}'s `cat` fallback.
 *
 * - hwmon (`/sys/class/hwmon`) — chip `name` plus `tempN_input`/`tempN_label`
 *   (CPU chips like coretemp/k10temp; GPU chips like amdgpu/nouveau/i915,
 *   which register here too, so a separate DRM `card` node traversal under
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
import { parsePciSlotName } from "../../topology/identity.ts";
import type { SensorCandidate } from "../types.ts";

/** Injectable sysfs access for fixture-driven tests. */
export type SensorIo = {
  /** Entry names in a directory; `[]` when missing/unreadable. */
  listDir: (path: string) => Promise<string[]> | string[];
  readFile: (path: string) => Promise<string | undefined> | string | undefined;
};

type ListDirIo = {
  readDir?: (path: string) => AsyncIterable<{ name: string }>;
  runLs?: (
    path: string,
  ) => Promise<{ code: number; stdout: Uint8Array }>;
};

async function lsDirNames(
  path: string,
  runLs?: ListDirIo["runLs"],
): Promise<string[] | null> {
  try {
    const run = runLs ?? ((p) =>
      new Deno.Command("ls", {
        args: ["-1", p],
        stdout: "piped",
        stderr: "null",
        // Scoped --allow-run=ls cannot inherit LD_* / DYLD_* (Deno 2.9).
        clearEnv: true,
      }).output());
    const { code, stdout } = await run(path);
    if (code !== 0) return null;
    return new TextDecoder().decode(stdout).split("\n").filter((n) =>
      n.length > 0
    );
  } catch {
    return null;
  }
}

/**
 * List a directory, falling back to `ls -1` when `Deno.readDir` throws.
 * Deno 2 blocks `/sys` (and `/proc`) directory listing under `--allow-read`.
 */
async function listDirectoryNames(
  path: string,
  io?: ListDirIo,
): Promise<string[]> {
  try {
    const readDir = io?.readDir ?? ((p) => Deno.readDir(p));
    const names: string[] = [];
    for await (const entry of readDir(path)) {
      names.push(entry.name);
    }
    return names;
  } catch {
    // Deno 2 NotCapable on /sys (and /proc) under --allow-read.
  }
  return (await lsDirNames(path, io?.runLs)) ?? [];
}

export function defaultSensorIo(io?: ListDirIo): SensorIo {
  return {
    async listDir(path: string): Promise<string[]> {
      const names = await listDirectoryNames(path, io);
      return names.sort((a, b) => a.localeCompare(b));
    },
    readFile: (path: string) => readProcFile(path),
  };
}

/**
 * One physical GPU's candidates, grouped by its hwmon chip directory (a
 * within-snapshot device identity). Selection picks one device first, then
 * resolves temperature/power/utilization/fan from that same device — a
 * sample never mixes two GPUs.
 */
export type GpuDeviceCandidates = {
  /** hwmon chip directory backing this device — stable within a snapshot. */
  path: string;
  chip: string;
  temperature: SensorCandidate[];
  power: SensorCandidate[];
  /** Vendor busy-percent gauge (`amdgpu`/i915); empty on NVIDIA (unsupported). */
  utilization: SensorCandidate[];
  fan: SensorCandidate[];
};

export type SensorCapabilities = {
  cpuTemperature: SensorCandidate[];
  gpuTemperature: SensorCandidate[];
  cpuPower: SensorCandidate[];
  gpuPower: SensorCandidate[];
  /** GPU candidates grouped per device; flat arrays above are the concatenation. */
  gpuDevices: GpuDeviceCandidates[];
  /** NVMe (`nvme`) and SATA/SAS (`drivetemp`) drive temperatures. */
  diskTemperature: SensorCandidate[];
  /** CPU- and system-chip fan tachometers (`chip` distinguishes CPU from system); GPU fans live on {@link GpuDeviceCandidates.fan}. */
  fan: SensorCandidate[];
  /** Board/ambient temperature candidates — every `tempN_input` not claimed by CPU, GPU, or disk. */
  ambientTemperature: SensorCandidate[];
  /** Explanation for an empty category the control plane can surface, when known. */
  reasons?: {
    diskTemperature?: string;
  };
};

export const CPU_HWMON_CHIPS: ReadonlySet<string> = new Set([
  "coretemp",
  "k10temp",
  "zenpower",
  "cpu_thermal",
]);

export const GPU_HWMON_CHIPS: ReadonlySet<string> = new Set([
  "amdgpu",
  "nouveau",
  "radeon",
  // Intel discrete/integrated GPUs register an "i915" hwmon chip on newer
  // kernels when CONFIG_DRM_I915_HWMON is on *and* the platform exposes the
  // PCODE mailbox. Alder Lake-N / Twin Lake (N150) often loads i915 but
  // never registers this chip — utilization then comes from DRM engine
  // busy counters in {@link discoverDrmIntelGpuDevices}, not hwmon.
  "i915",
]);

/**
 * Vendor busy-percent gauge filenames, probed in order under a GPU device's
 * `device` symlink. AMD's `gpu_busy_percent` is a confirmed kernel sysfs
 * attribute; `gt_busy_percent` is a best-effort i915 placeholder that real
 * kernels typically do not expose. Intel i915/Xe utilization on ADL-N and
 * similar iGPUs is the accumulating engine busy nanosecond counter
 * under `/sys/class/drm/cardN/engine/<name>/busy` — see
 * {@link discoverDrmIntelGpuDevices}.
 */
const GPU_UTILIZATION_FILENAMES: readonly string[] = [
  "gpu_busy_percent",
  "gt_busy_percent",
];

const INTEL_PCI_VENDOR_IDS: ReadonlySet<string> = new Set([
  "0x8086",
  "8086",
]);
const DRM_CARD_DIR_RE = /^card\d+$/;

const NVME_HWMON_CHIP = "nvme";
const DRIVETEMP_HWMON_CHIP = "drivetemp";

const CPU_THERMAL_ZONE_TYPES: ReadonlySet<string> = new Set([
  "x86_pkg_temp",
  "cpu-thermal",
  "cpu_thermal",
]);

/** Package-level labels sort first so auto-detection picks the die/package probe. */
const PREFERRED_CPU_TEMP_LABELS = ["Package id 0", "Tctl", "Tdie"] as const;
const PREFERRED_GPU_TEMP_LABELS = ["edge", "junction"] as const;

const TEMP_INPUT_RE = /^temp(\d+)_input$/;
const FAN_INPUT_RE = /^fan(\d+)_input$/;
const RAPL_PACKAGE_DIR_RE = /^intel-rapl:\d+$/;
const NVME_BLOCK_DEVICE_RE = /^nvme\d+n\d+$/;
const SATA_BLOCK_DEVICE_RE = /^sd[a-z]+$/;

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

async function hwmonFanCandidates(
  dir: string,
  chip: string,
  entries: string[],
  io: SensorIo,
): Promise<SensorCandidate[]> {
  const candidates: SensorCandidate[] = [];
  for (const entry of entries) {
    const match = FAN_INPUT_RE.exec(entry);
    if (!match) continue;
    const labelRaw = await io.readFile(`${dir}/fan${match[1]}_label`);
    const label = labelRaw?.trim() || `fan${match[1]}`;
    candidates.push({ chip, label, path: `${dir}/${entry}` });
  }
  candidates.sort((a, b) => a.path.localeCompare(b.path));
  return candidates;
}

/** One hwmon GPU chip's grouped candidates (temperature, power, utilization, fan). */
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
  const fan = await hwmonFanCandidates(dir, chip, files, io);
  const utilization: SensorCandidate[] = [];
  for (const filename of GPU_UTILIZATION_FILENAMES) {
    const path = `${dir}/device/${filename}`;
    const busyPercent = await io.readFile(path);
    if (busyPercent === undefined) continue;
    utilization.push({ chip, label: filename, path });
    break;
  }
  return { path: dir, chip, temperature, power, utilization, fan };
}

/**
 * Correlate an anonymous `nvme`/`drivetemp` hwmon chip to a stable block
 * device name via its `device` symlink, so two drives never collide on the
 * same generic chip identity. Falls back to the generic chip name (still
 * unique per hwmon directory in single-drive fixtures/hosts) when the
 * device topology isn't resolvable.
 */
async function resolveDiskDeviceName(
  dir: string,
  chip: string,
  io: SensorIo,
): Promise<string | undefined> {
  if (chip === NVME_HWMON_CHIP) {
    const entries = await io.listDir(`${dir}/device`);
    return entries.find((name) => NVME_BLOCK_DEVICE_RE.test(name));
  }
  if (chip === DRIVETEMP_HWMON_CHIP) {
    const entries = await io.listDir(`${dir}/device/block`);
    return entries[0];
  }
  return undefined;
}

async function hwmonDiskTempCandidates(
  dir: string,
  chip: string,
  files: string[],
  io: SensorIo,
): Promise<SensorCandidate[]> {
  const deviceName = await resolveDiskDeviceName(dir, chip, io);
  return hwmonTempCandidates(dir, deviceName ?? chip, files, io, []);
}

async function discoverHwmonSensors(
  root: string,
  io: SensorIo,
  capabilities: SensorCapabilities,
): Promise<{ hwmonRootHadEntries: boolean; sawDrivetempChip: boolean }> {
  const hwmonRoot = `${root}/class/hwmon`;
  const entries = await io.listDir(hwmonRoot);
  let sawDrivetempChip = false;

  for (const entry of entries) {
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
      capabilities.fan.push(...await hwmonFanCandidates(dir, chip, files, io));
      continue;
    }
    if (GPU_HWMON_CHIPS.has(chip)) {
      const device = await hwmonGpuDevice(dir, chip, files, io);
      capabilities.gpuTemperature.push(...device.temperature);
      capabilities.gpuPower.push(...device.power);
      if (
        device.temperature.length > 0 || device.power.length > 0 ||
        device.utilization.length > 0 || device.fan.length > 0
      ) {
        capabilities.gpuDevices.push(device);
      }
      continue;
    }
    if (chip === NVME_HWMON_CHIP || chip === DRIVETEMP_HWMON_CHIP) {
      if (chip === DRIVETEMP_HWMON_CHIP) sawDrivetempChip = true;
      capabilities.diskTemperature.push(
        ...await hwmonDiskTempCandidates(dir, chip, files, io),
      );
      continue;
    }
    // Everything else: unclaimed temps are ambient/board candidates, fans
    // are system fans (chip identity distinguishes them from CPU fans).
    capabilities.ambientTemperature.push(
      ...await hwmonTempCandidates(dir, chip, files, io, []),
    );
    capabilities.fan.push(...await hwmonFanCandidates(dir, chip, files, io));
  }

  return { hwmonRootHadEntries: entries.length > 0, sawDrivetempChip };
}

function drmDriverName(uevent: string): string {
  const line = uevent.split("\n").find((entry) => entry.startsWith("DRIVER="));
  const name = line?.slice("DRIVER=".length).trim();
  return name && name.length > 0 ? name : "i915";
}

function engineSort(a: string, b: string): number {
  if (a === b) return 0;
  if (a === "rcs0") return -1;
  if (b === "rcs0") return 1;
  if (a.startsWith("ccs") !== b.startsWith("ccs")) {
    return a.startsWith("ccs") ? -1 : 1;
  }
  return a.localeCompare(b);
}

/** A hwmon-sourced GPU device's own PCI identity, for correlation to a DRM card representing the same physical GPU. */
async function hwmonDevicePciPath(
  device: GpuDeviceCandidates,
  io: SensorIo,
): Promise<string | undefined> {
  const uevent = await io.readFile(`${device.path}/device/uevent`);
  return uevent ? parsePciSlotName(uevent) : undefined;
}

/**
 * Find the pre-existing (hwmon-sourced) GPU device this DRM card's engine
 * counters belong to, so a second card can never be folded into — or
 * silently drop behind — a device this function already created for an
 * earlier card. Only devices with no utilization candidates yet are
 * eligible (an already-fed device is either a distinct GPU or already
 * complete); `drmCreated` further excludes any device this same discovery
 * pass created for a *different* card, since two DRM cards must never
 * correlate to each other.
 *
 * PCI identity (shared between a card's `device/uevent` and its hwmon
 * counterpart's `device/uevent`) is the correlation key whenever it
 * resolves. When it doesn't (older kernels, or a fixture with no
 * `PCI_SLOT_NAME` line), chip-name matching is only safe when it is
 * unambiguous — exactly one eligible same-chip device — otherwise this
 * card gets its own new device rather than guessing.
 */
async function findExistingIntelHwmonDevice(
  devices: readonly GpuDeviceCandidates[],
  drmCreated: ReadonlySet<GpuDeviceCandidates>,
  chip: string,
  pciPath: string | undefined,
  io: SensorIo,
): Promise<GpuDeviceCandidates | undefined> {
  const eligible = devices.filter((device) =>
    !drmCreated.has(device) && device.utilization.length === 0
  );

  if (pciPath) {
    for (const device of eligible) {
      if ((await hwmonDevicePciPath(device, io)) === pciPath) return device;
    }
    return undefined;
  }

  const sameChip = eligible.filter((device) => device.chip === chip);
  return sameChip.length === 1 ? sameChip[0] : undefined;
}

/**
 * Intel iGPU utilization when hwmon never registered an `i915`/`xe` chip:
 * DRM engine busy files (accumulating nanoseconds, world-readable). AMD
 * already has `gpu_busy_percent`; NVIDIA stays unsupported. Cards whose
 * vendor is not Intel are skipped. When an i915 hwmon device already
 * exists with no utilization gauge, the engine counters attach to that
 * device (via {@link findExistingIntelHwmonDevice}) so one GPU still feeds
 * every measurement — correlated by PCI identity, never by driver name
 * alone, so a second same-driver card is never merged into or skipped
 * behind the first.
 */
async function discoverDrmIntelGpuDevices(
  root: string,
  io: SensorIo,
  capabilities: SensorCapabilities,
): Promise<void> {
  const drmRoot = `${root}/class/drm`;
  const drmCreated = new Set<GpuDeviceCandidates>();
  for (const entry of await io.listDir(drmRoot)) {
    if (!DRM_CARD_DIR_RE.test(entry)) continue;
    const cardPath = `${drmRoot}/${entry}`;
    const vendor = (await io.readFile(`${cardPath}/device/vendor`))?.trim()
      .toLowerCase();
    if (!vendor || !INTEL_PCI_VENDOR_IDS.has(vendor)) continue;

    const uevent = (await io.readFile(`${cardPath}/device/uevent`))?.trim() ??
      "";
    const chip = drmDriverName(uevent);
    const pciPath = parsePciSlotName(uevent);
    const engineRoot = `${cardPath}/engine`;
    const engineNames = [...await io.listDir(engineRoot)].sort(engineSort);
    const utilization: SensorCandidate[] = [];
    for (const engine of engineNames) {
      const path = `${engineRoot}/${engine}/busy`;
      if ((await io.readFile(path)) === undefined) continue;
      utilization.push({ chip, label: engine, path });
    }
    if (utilization.length === 0) continue;

    const existing = await findExistingIntelHwmonDevice(
      capabilities.gpuDevices,
      drmCreated,
      chip,
      pciPath,
      io,
    );
    if (existing) {
      existing.utilization.push(...utilization);
      continue;
    }

    const created: GpuDeviceCandidates = {
      path: cardPath,
      chip,
      temperature: [],
      power: [],
      utilization,
      fan: [],
    };
    capabilities.gpuDevices.push(created);
    drmCreated.add(created);
  }
}

/** SATA/SAS whole-disk devices under `/sys/block` (`sd*`), for the drivetemp-not-loaded reason. */
async function hasSataBlockDevices(
  root: string,
  io: SensorIo,
): Promise<boolean> {
  const entries = await io.listDir(`${root}/block`);
  return entries.some((name) => SATA_BLOCK_DEVICE_RE.test(name));
}

async function diskTemperatureReason(
  root: string,
  io: SensorIo,
  hwmonRootHadEntries: boolean,
  sawDrivetempChip: boolean,
): Promise<string | undefined> {
  if (!hwmonRootHadEntries) return "no_hwmon";
  if (!sawDrivetempChip && await hasSataBlockDevices(root, io)) {
    return "drivetemp_not_loaded";
  }
  return "no_disk_temperature_source";
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
    diskTemperature: [],
    fan: [],
    ambientTemperature: [],
  };
  const { hwmonRootHadEntries, sawDrivetempChip } = await discoverHwmonSensors(
    root,
    io,
    capabilities,
  );
  await discoverDrmIntelGpuDevices(root, io, capabilities);
  await discoverThermalZoneSensors(root, io, capabilities);
  await discoverRaplSensors(root, io, capabilities);

  if (capabilities.diskTemperature.length === 0) {
    capabilities.reasons = {
      diskTemperature: await diskTemperatureReason(
        root,
        io,
        hwmonRootHadEntries,
        sawDrivetempChip,
      ),
    };
  }

  return capabilities;
}

/** Stable sensor identity string for dimensions — `chip:label`, never `hwmonN`. */
export function sensorId(candidate: SensorCandidate): string {
  return `${candidate.chip}:${candidate.label}`;
}

/** True when `value` matches `candidate` by stable `chip:label` identity or by literal sysfs path. */
function candidateMatches(candidate: SensorCandidate, value: string): boolean {
  return candidate.path === value || sensorId(candidate) === value;
}

/**
 * Pick exactly one GPU device to feed the fixed contract: the device owning
 * an admin-override match when one matches, else the first enumerated device
 * exposing both temperature and power, else the first device. Temperature,
 * power, and utilization then all resolve from the returned device only.
 *
 * An override may be a stable `chip:label` identity (the hardware-profile
 * format — see `overrides.ts`) or a literal sysfs path (the pre-profile
 * escape hatch); both are matched here via {@link candidateMatches} against
 * temperature, power, *and* utilization candidates (Intel DRM-only iGPUs
 * have utilization identities and no temp/power).
 */
export function selectGpuDevice(
  devices: GpuDeviceCandidates[],
  overrides: { gpuTemperature?: string; gpuPower?: string },
): GpuDeviceCandidates | undefined {
  for (const value of [overrides.gpuTemperature, overrides.gpuPower]) {
    if (!value) continue;
    const matched = devices.find((device) =>
      device.temperature.some((c) => candidateMatches(c, value)) ||
      device.power.some((c) => candidateMatches(c, value)) ||
      device.utilization.some((c) => candidateMatches(c, value))
    );
    if (matched) return matched;
  }
  return devices.find((device) =>
    device.temperature.length > 0 && device.power.length > 0
  ) ?? devices[0];
}

/**
 * Pick exactly one candidate: the admin override when set (matched against
 * discovered candidates by stable `chip:label` identity or literal sysfs
 * path), else the first auto-detected candidate, else none. A literal path
 * that matches nothing is still honored verbatim — an operator's escape
 * hatch to point at any readable file. A `chip:label` identity that matches
 * nothing degrades to "no reading" (`undefined`) rather than being opened as
 * a literal (and broken) path — see `overrides.ts` on why a stale
 * hardware-profile assignment must read `null`, never crash.
 */
export function selectCandidate(
  candidates: SensorCandidate[],
  overridePath: string | undefined,
): SensorCandidate | undefined {
  if (overridePath) {
    const matched = candidates.find((c) => candidateMatches(c, overridePath));
    if (matched) return matched;
    if (overridePath.startsWith("/")) {
      return { chip: "override", label: overridePath, path: overridePath };
    }
    return undefined;
  }
  return candidates[0];
}

/**
 * Narrow a GPU-device-level override to the specific candidate pool a
 * per-measurement resolver (temperature/power/utilization/fan) selects
 * from. `overrides.gpuTemperature/gpuPower/gpuUtilization/gpuFan` often
 * carry the SAME device-representative `chip:label` identity — see
 * `resolveAdminSensorOverrides` in `overrides.ts`, which fans one assigned
 * `gpuDevice` slot out to all four keys. That identity picks the *device*
 * (via {@link selectGpuDevice}) and only incidentally also names one of its
 * candidates (typically its temperature label) — passed straight through to
 * {@link selectCandidate} for gpuPower/gpuUtilization/gpuFan, it would name
 * nothing in those pools and (per `selectCandidate`'s non-path fallback)
 * resolve to no reading, even though the device itself was correctly
 * selected. This narrows the override to `undefined` in that case so
 * `selectCandidate` falls through to auto-detection within the already-
 * pinned device instead. A literal sysfs path is always passed through
 * unchanged — that's the operator's per-file escape hatch, never a device
 * identity, and it may legitimately point outside this pool too.
 */
export function withinDeviceOverride(
  candidates: SensorCandidate[],
  overridePath: string | undefined,
): string | undefined {
  if (!overridePath) return undefined;
  if (overridePath.startsWith("/")) return overridePath;
  return candidates.some((c) => sensorId(c) === overridePath)
    ? overridePath
    : undefined;
}

export type CandidateSelectionOptions = {
  /** Auto-detection fallback index into `candidates` (default `0`). */
  index?: number;
  /**
   * Whether auto-detection may fall back to a positional candidate at all
   * when no override is set. `false` for slots with no natural default
   * (e.g. board temperature) — an unassigned slot then reads `null` rather
   * than silently duplicating another slot's auto-selected candidate.
   */
  positionalDefault?: boolean;
};

/**
 * {@link selectCandidate} generalized for paired slots (disk1/2, ambient1/2,
 * systemFan1/2) that auto-detect from different positions in the same
 * discovered pool, and for slots with no positional default at all.
 */
export function selectCandidateWithOptions(
  candidates: SensorCandidate[],
  overridePath: string | undefined,
  options?: CandidateSelectionOptions,
): SensorCandidate | undefined {
  if (overridePath) return selectCandidate(candidates, overridePath);
  if (options?.positionalDefault === false) return undefined;
  return candidates[options?.index ?? 0];
}
