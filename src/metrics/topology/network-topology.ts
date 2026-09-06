/**
 * Network device topology: wraps `collector/network.ts`'s classification
 * (fabric/uplink/container-bridge/loopback — this module only adds stable
 * identity) with `/sys/class/net/<name>/{address,speed,mtu}` reads.
 */
import { parseNetDev } from "../collector/parse-net-dev.ts";
import { classifyInterface } from "../collector/network.ts";
import { deriveNetworkDeviceIdentity, type IdentityIo } from "./identity.ts";
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

/** Enumerate every network device with stable identity, current classification, speed, and MTU. */
export async function collectNetworkTopology(
  deps: NetworkTopologyDeps,
): Promise<NetworkDeviceTopology[]> {
  const root = deps.sysRoot ?? "/sys";
  const [netDevText, fabricInterfaces] = await Promise.all([
    deps.readProcFile("/proc/net/dev"),
    deps.resolveFabricInterfaces().catch(() => [] as string[]),
  ]);
  const parsed = netDevText ? parseNetDev(netDevText) : null;
  if (!parsed) return [];

  const names = Object.keys(parsed).sort((a, b) => a.localeCompare(b));
  return await Promise.all(
    names.map(async (name): Promise<NetworkDeviceTopology> => {
      const [{ deviceId, identity }, speedMbps, mtu] = await Promise.all([
        deriveNetworkDeviceIdentity(name, deps.io, root),
        readOptionalNumber(`${root}/class/net/${name}/speed`, deps.io),
        readOptionalNumber(`${root}/class/net/${name}/mtu`, deps.io),
      ]);
      return {
        deviceId,
        kind: classifyInterface(name, fabricInterfaces),
        name,
        identity,
        ...(speedMbps !== undefined ? { speedMbps } : {}),
        ...(mtu !== undefined ? { mtu } : {}),
      };
    }),
  );
}
