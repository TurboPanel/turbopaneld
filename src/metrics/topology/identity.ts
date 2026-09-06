/**
 * Stable-identity derivation for topology entities — the daemon-internal
 * building block every `*-topology.ts` module calls before assembling its
 * `TopologySnapshot` slice. An identity is derived once per collection tick
 * from hardware-level facts (MAC, PCI path, model/serial/WWN, dm UUID) that
 * survive a rename/renumber/hotplug — never a bare kernel/interface name.
 *
 * Reuses the `SensorIo`-shaped `{ listDir, readFile }` seam
 * (`collector/sensors/discovery.ts`) rather than a second sysfs-access
 * implementation — `defaultSensorIo()` already carries the Deno-2
 * `/sys` `readDir` → `ls -1` fallback this module also needs.
 */
import type {
  FilesystemId,
  NetworkDeviceIdentity,
  TopologyDeviceId,
} from "./types.ts";

/** Sysfs access seam — identical shape to `collector/sensors/discovery.ts`'s `SensorIo`. */
export type IdentityIo = {
  listDir: (path: string) => Promise<string[]> | string[];
  readFile: (path: string) => Promise<string | undefined> | string | undefined;
};

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** Deterministic, dependency-free 32-bit hash for virtual-device identity keys. */
export function fnv1aHex(input: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.codePointAt(i) ?? 0;
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const ZERO_MAC = "00:00:00:00:00:00";

/** `PCI_SLOT_NAME=0000:00:1f.6` line from a sysfs `uevent` file. */
export function parsePciSlotName(uevent: string): string | undefined {
  const line = uevent.split("\n").find((entry) =>
    entry.startsWith("PCI_SLOT_NAME=")
  );
  const value = line?.slice("PCI_SLOT_NAME=".length).trim();
  return value && value.length > 0 ? value : undefined;
}

/** `DRIVER=<name>` line from a sysfs `uevent` file. */
export function parseDriverName(uevent: string): string | undefined {
  const line = uevent.split("\n").find((entry) => entry.startsWith("DRIVER="));
  const value = line?.slice("DRIVER=".length).trim();
  return value && value.length > 0 ? value : undefined;
}

/**
 * One network interface's stable identity. Reads `/sys/class/net/<name>/
 * address` (permanent-enough MAC for topology purposes — a bonded/virtual
 * MAC still identifies the device consistently across a rename) and the
 * backing `device/uevent` for a PCI slot path; a device with neither (pure
 * software devices — `lo`, `tap`/`veth`/`tp0`-shaped names) falls back to a
 * hash of name+driver, which is stable as long as the driver doesn't change
 * underneath the same logical device.
 */
export async function deriveNetworkDeviceIdentity(
  name: string,
  io: IdentityIo,
  root = "/sys",
): Promise<{ deviceId: TopologyDeviceId; identity: NetworkDeviceIdentity }> {
  const [macRaw, uevent] = await Promise.all([
    io.readFile(`${root}/class/net/${name}/address`),
    io.readFile(`${root}/class/net/${name}/device/uevent`),
  ]);
  const mac = macRaw?.trim().toLowerCase();
  const pciPath = uevent ? parsePciSlotName(uevent) : undefined;

  if (mac && mac.length > 0 && mac !== ZERO_MAC) {
    return {
      deviceId: `mac:${mac}`,
      identity: { mac, ...(pciPath ? { pciPath } : {}) },
    };
  }
  if (pciPath) {
    return { deviceId: `pci:${pciPath}`, identity: { pciPath } };
  }
  const driver = uevent ? parseDriverName(uevent) : undefined;
  const virtualKey = fnv1aHex(`${name}:${driver ?? "unknown"}`);
  return { deviceId: `virtual:${virtualKey}`, identity: { virtualKey } };
}

/** Convenience wrapper when only the id (not the display identity struct) is needed. */
export async function deriveNetworkDeviceId(
  name: string,
  io: IdentityIo,
  root = "/sys",
): Promise<TopologyDeviceId> {
  return (await deriveNetworkDeviceIdentity(name, io, root)).deviceId;
}

export type BlockDeviceIdentity = {
  deviceId: TopologyDeviceId;
  model?: string;
  serial?: string;
  wwn?: string;
};

/**
 * One block device's stable identity: a WWN (`/sys/block/<name>/wwn_id`)
 * wins outright when present, else `model:serial` from `device/{model,
 * serial}`, else a hash of the device's `dev` (major:minor) plus kernel
 * name — the last resort is only as stable as major:minor allocation,
 * which is why WWN/model+serial are preferred whenever the kernel exposes
 * them.
 */
export async function deriveBlockDeviceIdentity(
  name: string,
  io: IdentityIo,
  root = "/sys",
): Promise<BlockDeviceIdentity> {
  const [modelRaw, serialRaw, wwnRaw, devRaw] = await Promise.all([
    io.readFile(`${root}/block/${name}/device/model`),
    io.readFile(`${root}/block/${name}/device/serial`),
    io.readFile(`${root}/block/${name}/wwn_id`),
    io.readFile(`${root}/block/${name}/dev`),
  ]);
  const model = modelRaw?.trim() || undefined;
  const serial = serialRaw?.trim() || undefined;
  const wwn = wwnRaw?.trim() || undefined;

  if (wwn) return { deviceId: `wwn:${wwn}`, model, serial, wwn };
  if (model && serial) {
    return { deviceId: `disk:${model}:${serial}`, model, serial };
  }

  const majorMinor = devRaw?.trim() ?? "";
  const identityKey = `${majorMinor}:${name}`;
  return {
    deviceId: `blk:${fnv1aHex(identityKey)}`,
    model,
    serial,
  };
}

/** Convenience wrapper when only the id is needed. */
export async function deriveBlockDeviceId(
  name: string,
  io: IdentityIo,
  root = "/sys",
): Promise<TopologyDeviceId> {
  return (await deriveBlockDeviceIdentity(name, io, root)).deviceId;
}

/**
 * One filesystem's stable identity: a device-mapper UUID
 * (`/sys/class/block/<dev>/dm/uuid`) when the backing device is LVM/dm,
 * else the resolved backing device path, else the normalized mountpoint.
 * The mountpoint fallback is documented as unstable — a bind mount, tmpfs,
 * or network filesystem with no resolvable backing device will re-derive a
 * *different* id only if the mountpoint itself changes, but two distinct
 * such filesystems mounted at the same path across a remount are
 * indistinguishable by this identity alone.
 */
export async function deriveFilesystemId(
  params: {
    sourceDevice: string | null;
    /** Kernel block-device name backing `sourceDevice`, when resolved (e.g. `dm-0`). */
    deviceName: string | null;
    mountpoint: string;
  },
  io: IdentityIo,
  root = "/sys",
): Promise<FilesystemId> {
  if (params.deviceName) {
    const dmUuid = await io.readFile(
      `${root}/class/block/${params.deviceName}/dm/uuid`,
    );
    const trimmed = dmUuid?.trim();
    if (trimmed) return `fs:dm:${trimmed}`;
  }
  if (params.sourceDevice) return `fs:dev:${params.sourceDevice}`;
  return `fs:path:${params.mountpoint}`;
}
