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
 * One network interface's stable identity.
 *
 * Hardware-backed devices (a readable `device/uevent` — PCI/USB/virtio/Xen/
 * Hyper-V backing) identify by MAC, preferring `bonding_slave/perm_hwaddr`
 * when the device is enslaved to a bond: every active-backup bond port
 * reports the bond's MAC as its `address`, so the permanent hardware MAC is
 * the only thing that keeps two ports distinct. A MAC-less hardware device
 * falls back to its PCI slot path.
 *
 * Software devices (bonds, bridges, teams, VLAN/macvlan children, tunnels,
 * veth legs — no `device` backing) never identify by MAC: a bond, its VLAN
 * children, and a bridge on top of it all share one MAC, which would
 * collapse them onto one id and one counter baseline. They hash name+driver
 * instead, stable for as long as the operator keeps the same device name.
 *
 * The one exception is `options.macIdentity`: the caller (network topology,
 * from `network-classifier.ts`'s `isBareEthernet`) sets it for a plain
 * Ethernet device with no bus backing and no stack above or below it — a
 * container's renamed veth peer. Nothing shares its MAC, and it is that
 * host's only uplink, so it keeps the `mac:` id it always had.
 */
export async function deriveNetworkDeviceIdentity(
  name: string,
  io: IdentityIo,
  root = "/sys",
  options: { macIdentity?: boolean } = {},
): Promise<{ deviceId: TopologyDeviceId; identity: NetworkDeviceIdentity }> {
  const base = `${root}/class/net/${name}`;
  const [macRaw, uevent, permanentMacRaw] = await Promise.all([
    io.readFile(`${base}/address`),
    io.readFile(`${base}/device/uevent`),
    io.readFile(`${base}/bonding_slave/perm_hwaddr`),
  ]);
  const hardwareBacked = uevent !== undefined;
  const driver = uevent ? parseDriverName(uevent) : undefined;

  if (hardwareBacked || options.macIdentity === true) {
    const permanentMac = normalizeMac(permanentMacRaw);
    const mac = permanentMac ?? normalizeMac(macRaw);
    const pciPath = uevent ? parsePciSlotName(uevent) : undefined;
    if (mac) {
      return {
        deviceId: `mac:${mac}`,
        identity: { mac, ...(pciPath ? { pciPath } : {}) },
      };
    }
    if (pciPath) {
      return { deviceId: `pci:${pciPath}`, identity: { pciPath } };
    }
  }

  const virtualKey = fnv1aHex(`${name}:${driver ?? "unknown"}`);
  return { deviceId: `virtual:${virtualKey}`, identity: { virtualKey } };
}

/** Lower-cased MAC, or `undefined` for a missing/blank/all-zero address. */
function normalizeMac(raw: string | undefined): string | undefined {
  const mac = raw?.trim().toLowerCase();
  if (!mac || mac === ZERO_MAC) return undefined;
  return mac;
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
