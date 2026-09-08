/**
 * Network domain: interface classification (used by topology discovery to
 * stamp each device's `kind`) and per-device directional stats keyed by
 * stable topology `deviceId`.
 */
import type { CounterBaselineTracker } from "./baseline.ts";
import type { NetworkDeviceSample } from "../contract.ts";
import {
  type NetInterfaceDetailedCounters,
  parseNetDevDetailedCounters,
} from "./parse-net-dev.ts";
import type { SensorIo } from "./sensors/discovery.ts";
import type {
  NetworkDeviceKind,
  NetworkDeviceTopology,
} from "../topology/types.ts";

/** Container/bridge/virtual interface prefixes (Docker, libvirt, taps). */
const CONTAINER_BRIDGE_PREFIXES = [
  "veth",
  "docker",
  "br-",
  "virbr",
  "vnet",
  "tap",
] as const;

/**
 * Classify one interface. Fabric membership comes from the injected
 * TurboFabric interface list (seeded with `tp0`), checked before the
 * container-bridge prefixes so a fabric tunnel named like a bridge still
 * counts as fabric. Everything unmatched is an uplink.
 */
export function classifyInterface(
  name: string,
  fabricInterfaces: string[],
): NetworkDeviceKind {
  if (name === "lo") return "loopback";
  if (fabricInterfaces.includes(name)) return "fabric";
  if (CONTAINER_BRIDGE_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return "container-bridge";
  }
  // Generic tunnel devices (tun/tap without fabric registration) carry
  // overlay traffic already counted on the underlying uplink.
  if (name.startsWith("tun")) return "container-bridge";
  return "uplink";
}

async function readOptionalCounter(
  io: SensorIo,
  path: string,
): Promise<number | undefined> {
  const raw = await io.readFile(path);
  if (raw === undefined) return undefined;
  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Per-NIC directional counters preferring `/sys/class/net/<name>/statistics/
 * *` (per-file async reads) over `/proc/net/dev` parsing. Sysfs statistics
 * files are the chosen source; rtnetlink (which would need a raw netlink
 * socket, not available from Deno without a subprocess) is deferred unless a
 * concrete gap is found. Returns `null` when any sysfs statistics file is
 * missing — the caller falls back to `/proc/net/dev` for that device (some
 * virtual devices expose no `statistics/` directory).
 */
export async function readNetInterfaceDetailedCounters(
  name: string,
  io: SensorIo,
  sysRoot = "/sys",
): Promise<NetInterfaceDetailedCounters | null> {
  const base = `${sysRoot}/class/net/${name}/statistics`;
  const [rx, tx, rxErrors, txErrors, rxDropped, txDropped] = await Promise.all(
    [
      readOptionalCounter(io, `${base}/rx_bytes`),
      readOptionalCounter(io, `${base}/tx_bytes`),
      readOptionalCounter(io, `${base}/rx_errors`),
      readOptionalCounter(io, `${base}/tx_errors`),
      readOptionalCounter(io, `${base}/rx_dropped`),
      readOptionalCounter(io, `${base}/tx_dropped`),
    ],
  );
  if (
    rx === undefined || tx === undefined || rxErrors === undefined ||
    txErrors === undefined || rxDropped === undefined ||
    txDropped === undefined
  ) {
    return null;
  }
  return { rx, tx, rxErrors, txErrors, rxDropped, txDropped };
}

const EMPTY_NETWORK_DEVICE_RATES: Omit<NetworkDeviceSample, "deviceId"> = {
  receiveBytesPerSecond: null,
  transmitBytesPerSecond: null,
  receiveErrorsPerSecond: null,
  transmitErrorsPerSecond: null,
  receiveDropsPerSecond: null,
  transmitDropsPerSecond: null,
};

/** Every baseline field {@link buildNetworkDeviceSamples} tracks per device. */
const NETWORK_DEVICE_BASELINE_FIELDS = [
  "rx",
  "tx",
  "rxErrors",
  "txErrors",
  "rxDrops",
  "txDrops",
] as const;

/**
 * Build one `NetworkDeviceSample` per topology-enumerated device — TurboFabric
 * interfaces included as ordinary entries, never pre-aggregated. Keyed by the
 * stable `deviceId` (not the current kernel `name`), so a rename between
 * ticks doesn't fabricate a rate: a device whose counters are unreadable this
 * tick stays present in the output with every field `null`, and its baseline
 * entries are explicitly invalidated — the next readable tick re-origins
 * (`null` again) instead of diffing against a stale pre-gap value and
 * compressing however many missed intervals elapsed into one fabricated
 * rate. Topology said the device exists, so the entry is never dropped.
 */
export async function buildNetworkDeviceSamples(
  topology: NetworkDeviceTopology[],
  deps: { io: SensorIo; sysRoot?: string; netDevText?: string },
  tracker: CounterBaselineTracker,
  bootGeneration: number,
  seconds: number,
): Promise<NetworkDeviceSample[]> {
  const root = deps.sysRoot ?? "/sys";
  const fallback = deps.netDevText
    ? parseNetDevDetailedCounters(deps.netDevText)
    : {};

  return await Promise.all(topology.map(async (device) => {
    const sysfsCounters = await readNetInterfaceDetailedCounters(
      device.name,
      deps.io,
      root,
    );
    const counters = sysfsCounters ?? fallback[device.name] ?? null;
    const key = (field: string) => `net:${device.deviceId}:${field}`;
    if (!counters) {
      for (const field of NETWORK_DEVICE_BASELINE_FIELDS) {
        tracker.invalidate(key(field));
      }
      return { deviceId: device.deviceId, ...EMPTY_NETWORK_DEVICE_RATES };
    }

    return {
      deviceId: device.deviceId,
      receiveBytesPerSecond: tracker.rate(
        key("rx"),
        counters.rx,
        bootGeneration,
        seconds,
      ),
      transmitBytesPerSecond: tracker.rate(
        key("tx"),
        counters.tx,
        bootGeneration,
        seconds,
      ),
      receiveErrorsPerSecond: tracker.rate(
        key("rxErrors"),
        counters.rxErrors,
        bootGeneration,
        seconds,
      ),
      transmitErrorsPerSecond: tracker.rate(
        key("txErrors"),
        counters.txErrors,
        bootGeneration,
        seconds,
      ),
      receiveDropsPerSecond: tracker.rate(
        key("rxDrops"),
        counters.rxDropped,
        bootGeneration,
        seconds,
      ),
      transmitDropsPerSecond: tracker.rate(
        key("txDrops"),
        counters.txDropped,
        bootGeneration,
        seconds,
      ),
    };
  }));
}
