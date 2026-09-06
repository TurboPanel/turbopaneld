/**
 * Network device topology: sysfs-refined classification
 * (`network-classifier.ts` — hardware-backed uplinks and the aggregates
 * stacked on them versus members/virtual children/container bridges/
 * loopback/fabric), stable identity (`identity.ts`), the default-route
 * flag, and `/sys/class/net/<name>/{speed,mtu}` reads.
 */
import {
  parseIpv4DefaultRouteInterface,
  parseIpv6DefaultRouteInterface,
} from "../../server-addresses.ts";
import { parseNetDev } from "../collector/parse-net-dev.ts";
import { deriveNetworkDeviceIdentity, type IdentityIo } from "./identity.ts";
import {
  classifyNetworkDevices,
  isBareEthernet,
  readNetworkDeviceFacts,
} from "./network-classifier.ts";
import type { NetworkDeviceTopology } from "./types.ts";

export type NetworkTopologyDeps = {
  readProcFile: (
    path: string,
  ) => string | undefined | Promise<string | undefined>;
  resolveFabricInterfaces: () => Promise<string[]>;
  io: IdentityIo;
  sysRoot?: string;
};

async function readOptionalNumber(
  path: string,
  io: IdentityIo,
): Promise<number | undefined> {
  const raw = await io.readFile(path);
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * The interface name carrying the host's default route — IPv4 first (the
 * lowest-metric `0.0.0.0/0` row in `/proc/net/route`), IPv6 `::/0` as the
 * fallback. `undefined` when neither table is readable or has a default.
 */
async function readDefaultRouteInterface(
  readProcFile: NetworkTopologyDeps["readProcFile"],
): Promise<string | undefined> {
  const [v4, v6] = await Promise.all([
    readProcFile("/proc/net/route"),
    readProcFile("/proc/net/ipv6_route"),
  ]);
  const fromV4 = v4 ? parseIpv4DefaultRouteInterface(v4) : undefined;
  if (fromV4) return fromV4;
  return v6 ? parseIpv6DefaultRouteInterface(v6) : undefined;
}

/**
 * Enumerate every network device with stable identity, current
 * classification, speed, MTU, and — on exactly one `uplink` at most — the
 * `defaultRoute` flag `slot-mapping.ts` uses to pick the auto-monitored NIC.
 */
export async function collectNetworkTopology(
  deps: NetworkTopologyDeps,
): Promise<NetworkDeviceTopology[]> {
  const root = deps.sysRoot ?? "/sys";
  const [netDevText, fabricInterfaces, routeInterface] = await Promise.all([
    deps.readProcFile("/proc/net/dev"),
    deps.resolveFabricInterfaces().catch(() => [] as string[]),
    readDefaultRouteInterface(deps.readProcFile).catch(() => undefined),
  ]);
  const parsed = netDevText ? parseNetDev(netDevText) : null;
  if (!parsed) return [];

  const names = Object.keys(parsed).sort((a, b) => a.localeCompare(b));
  const facts = await Promise.all(
    names.map((name) => readNetworkDeviceFacts(name, deps.io, root)),
  );
  const factsByName = new Map(facts.map((entry) => [entry.name, entry]));
  const classification = classifyNetworkDevices(facts, fabricInterfaces);
  const defaultRouteUplink = routeInterface
    ? classification.resolveUplinkFor(routeInterface)
    : undefined;

  return await Promise.all(
    names.map(async (name): Promise<NetworkDeviceTopology> => {
      const [{ deviceId, identity }, speedMbps, mtu] = await Promise.all([
        deriveNetworkDeviceIdentity(name, deps.io, root, {
          macIdentity: isBareEthernet(factsByName.get(name)!),
        }),
        readOptionalNumber(`${root}/class/net/${name}/speed`, deps.io),
        readOptionalNumber(`${root}/class/net/${name}/mtu`, deps.io),
      ]);
      return {
        deviceId,
        kind: classification.kinds.get(name) ?? "virtual",
        name,
        identity,
        ...(speedMbps !== undefined ? { speedMbps } : {}),
        ...(mtu !== undefined ? { mtu } : {}),
        ...(name === defaultRouteUplink ? { defaultRoute: true } : {}),
      };
    }),
  );
}
