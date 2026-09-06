/**
 * GPU topology: enumeration only — no telemetry-capability fields, no
 * physical/bare-metal classification. This module never imports from
 * `physical-classifier.ts`; `topology.ts` calls both as independent
 * siblings, so a GPU's presence can never influence physical classification
 * (a GPU passthrough VM must not read as bare metal).
 *
 * Sources: DRM cards under `/sys/class/drm/card*` (vendor/PCI-id read
 * pattern shared with `sensors/discovery.ts`'s `discoverDrmIntelGpuDevices`)
 * and hwmon GPU chips (`sensors/discovery.ts`'s `GPU_HWMON_CHIPS`)
 * correlated to their DRM card via the same `device` symlink resolution.
 */
import { GPU_HWMON_CHIPS } from "../collector/sensors/discovery.ts";
import {
  fnv1aHex,
  type IdentityIo,
  parseDriverName,
  parsePciSlotName,
} from "./identity.ts";
import type { GpuTopology } from "./types.ts";

const DRM_CARD_DIR_RE = /^card\d+$/;

const VENDOR_NAMES: ReadonlyMap<string, string> = new Map([
  ["0x8086", "intel"],
  ["8086", "intel"],
  ["0x1002", "amd"],
  ["1002", "amd"],
  ["0x10de", "nvidia"],
  ["10de", "nvidia"],
]);

function vendorName(vendorId: string): string {
  const normalized = vendorId.trim().toLowerCase();
  return VENDOR_NAMES.get(normalized) ?? normalized;
}

export type GpuTopologyDeps = {
  io: IdentityIo;
  sysRoot?: string;
};

async function collectDrmCards(
  io: IdentityIo,
  root: string,
): Promise<GpuTopology[]> {
  const drmRoot = `${root}/class/drm`;
  const gpus: GpuTopology[] = [];
  for (const entry of await io.listDir(drmRoot)) {
    if (!DRM_CARD_DIR_RE.test(entry)) continue;
    const cardPath = `${drmRoot}/${entry}`;
    const [vendorRaw, uevent] = await Promise.all([
      io.readFile(`${cardPath}/device/vendor`),
      io.readFile(`${cardPath}/device/uevent`),
    ]);
    const vendorId = vendorRaw?.trim();
    if (!vendorId) continue;
    const pciPath = uevent ? parsePciSlotName(uevent) : undefined;
    const chip = (uevent ? parseDriverName(uevent) : undefined) ?? "unknown";
    const identityKey = `${entry}:${chip}`;
    const gpuId = pciPath ? `pci:${pciPath}` : `drm:${fnv1aHex(identityKey)}`;
    gpus.push({
      gpuId,
      kind: "drm",
      pciPath: pciPath ?? "",
      vendor: vendorName(vendorId),
      chip,
    });
  }
  return gpus;
}

async function collectHwmonGpuChips(
  io: IdentityIo,
  root: string,
  existing: GpuTopology[],
): Promise<GpuTopology[]> {
  const hwmonRoot = `${root}/class/hwmon`;
  const gpus: GpuTopology[] = [];
  for (const entry of await io.listDir(hwmonRoot)) {
    const dir = `${hwmonRoot}/${entry}`;
    const chip = (await io.readFile(`${dir}/name`))?.trim();
    if (!chip || !GPU_HWMON_CHIPS.has(chip)) continue;
    const [vendorRaw, uevent] = await Promise.all([
      io.readFile(`${dir}/device/vendor`),
      io.readFile(`${dir}/device/uevent`),
    ]);
    const pciPath = uevent ? parsePciSlotName(uevent) : undefined;
    const identityKey = `${entry}:${chip}`;
    const gpuId = pciPath ? `pci:${pciPath}` : `hwmon:${fnv1aHex(identityKey)}`;
    if (
      existing.some((g) => g.gpuId === gpuId) ||
      gpus.some((g) => g.gpuId === gpuId)
    ) {
      continue;
    }
    const vendor = vendorRaw ? vendorName(vendorRaw) : chip;
    gpus.push({ gpuId, kind: "sysfs", pciPath: pciPath ?? "", vendor, chip });
  }
  return gpus;
}

/** Enumerate every discoverable GPU device — identity only, no telemetry, no physical/VM classification. */
export async function collectGpuTopology(
  deps: GpuTopologyDeps,
): Promise<GpuTopology[]> {
  const root = deps.sysRoot ?? "/sys";
  const drmGpus = await collectDrmCards(deps.io, root);
  const hwmonGpus = await collectHwmonGpuChips(deps.io, root, drmGpus);
  return [...drmGpus, ...hwmonGpus].sort((a, b) =>
    a.gpuId.localeCompare(b.gpuId)
  );
}
