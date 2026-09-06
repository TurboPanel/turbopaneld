/**
 * Sysfs-driven network device classification — the physical-only rule
 * behind which devices may be monitored as NIC slots (`slot-mapping.ts`)
 * and offered in the server-settings picker.
 *
 * Name prefixes (`collector/network.ts`'s `classifyInterface`) still decide
 * `loopback` / `fabric` / `container-bridge`. Everything that would have
 * been a plain `uplink` by name is then refined from `/sys/class/net`:
 *
 *  - **hardware-backed**: `<name>/device/uevent` is readable (PCI, USB,
 *    virtio, Xen netfront, Hyper-V netvsc — anything with a bus device).
 *  - **aggregate**: a bond/bridge/team master — `bonding/` or `bridge/`
 *    directory, `DEVTYPE` bond/bridge/team, or (for a team, which sets no
 *    DEVTYPE) a software device with `lower_*` links that is not a known
 *    single-parent child type (vlan/macvlan/macvtap/ipvlan/ipvtap).
 *  - **physical-backed**: hardware-backed, or has a physical-backed device
 *    somewhere below it via `lower_*` (a bond over two ports, a bridge over
 *    a bond, a VLAN child of a port).
 *
 * Kinds, in order:
 *
 *  1. physical-backed with a physical-backed aggregate somewhere *above* it
 *     → `member` (bond ports, bridge members, a bond nested under a bridge,
 *     a VLAN child sitting between a port and a bridge). Its bytes are
 *     already counted on the aggregate that tops the stack.
 *  2. physical-backed hardware device or physical-backed aggregate with
 *     nothing aggregating it → `uplink` — the one device per physical link
 *     that charts once.
 *  3. any other physical-backed software device (a VLAN/macvlan child of an
 *     uplink) → `virtual`: its traffic rolls into the parent.
 *  4. an aggregate with no physical backing (a bridge of veths that escaped
 *     the name-prefix rule) → `container-bridge`.
 *  5. a plain Ethernet device with **no** evidence of being virtual — sysfs
 *     entry present, no `DEVTYPE`, no `lower_*`, ARPHRD type Ethernet, and
 *     no container prefix — → `uplink`. This is the container case: an LXC
 *     / Proxmox CT / veth-networked VPS sees its veth peer renamed to `eth0`
 *     with no bus device behind it, and that is the host's only link.
 *     Every genuinely virtual device either sets `DEVTYPE` (vlan, bond,
 *     bridge, wireguard, vxlan, gre, sit, …), has lowers, is non-Ethernet
 *     (tun/tap ARPHRD_NONE), or matches a name prefix.
 *  6. everything else (WireGuard, tun, vxlan, a device whose sysfs entry
 *     vanished mid-tick, …) → `virtual`.
 *
 * `eth0:1`-style IP aliases never appear here at all — they are secondary
 * addresses on `eth0`, not devices, and carry no counters of their own.
 */
import { classifyInterface } from "../collector/network.ts";
import type { IdentityIo } from "./identity.ts";
import type { NetworkDeviceKind } from "./types.ts";

/** Sysfs facts for one interface — see `readNetworkDeviceFacts`. */
export type NetworkDeviceFacts = {
  name: string;
  /** `/sys/class/net/<name>` answered at all (`uevent`, `device/uevent`, or `address`). */
  present: boolean;
  /** `<name>/device/uevent` is readable — a bus-backed (hardware or paravirtual) NIC. */
  hardwareBacked: boolean;
  /** ARPHRD link type from `<name>/type` (`1` = Ethernet, `65534` = none/tun), when readable. */
  arphrdType?: number;
  /** `DEVTYPE=` from `<name>/uevent`, when the driver sets one (vlan, bond, bridge, wireguard, …). */
  devType?: string;
  /** Names of the devices this one is stacked on (`lower_<name>` entries). */
  lowers: string[];
  /** `bonding/` or `bridge/` directory present — an aggregate master regardless of DEVTYPE. */
  aggregateHint: boolean;
};

const AGGREGATE_DEVTYPES = new Set(["bond", "bridge", "team"]);
const SINGLE_PARENT_CHILD_DEVTYPES = new Set([
  "vlan",
  "macvlan",
  "macvtap",
  "ipvlan",
  "ipvtap",
]);

/** `DEVTYPE=<name>` line from a sysfs `uevent` file. */
export function parseDevType(uevent: string): string | undefined {
  const line = uevent.split("\n").find((entry) => entry.startsWith("DEVTYPE="));
  const value = line?.slice("DEVTYPE=".length).trim();
  return value && value.length > 0 ? value : undefined;
}

/**
 * Read one interface's sysfs facts. A device with no readable sysfs entry at
 * all (a `/proc/net/dev` row whose `/sys/class/net` directory vanished
 * mid-tick, or a test fixture that omits it) is treated as a bare software
 * device — no bus backing, no links — so it can never be mistaken for an
 * uplink; the directory is only listed once one of its files answered, so
 * a missing entry never falls through to `SensorIo`'s `ls` subprocess.
 */
export async function readNetworkDeviceFacts(
  name: string,
  io: IdentityIo,
  root = "/sys",
): Promise<NetworkDeviceFacts> {
  const base = `${root}/class/net/${name}`;
  const [uevent, deviceUevent, address, linkType] = await Promise.all([
    io.readFile(`${base}/uevent`),
    io.readFile(`${base}/device/uevent`),
    io.readFile(`${base}/address`),
    io.readFile(`${base}/type`),
  ]);
  const present = uevent !== undefined || deviceUevent !== undefined ||
    address !== undefined;
  if (!present) {
    return {
      name,
      present: false,
      hardwareBacked: false,
      lowers: [],
      aggregateHint: false,
    };
  }
  const arphrdType = linkType === undefined
    ? undefined
    : Number(linkType.trim());
  const entries = await Promise.resolve(io.listDir(base)).catch(
    () => [] as string[],
  );
  const lowers = entries
    .filter((entry) => entry.startsWith("lower_"))
    .map((entry) => entry.slice("lower_".length))
    .filter((lower) => lower.length > 0);
  const devType = uevent ? parseDevType(uevent) : undefined;
  return {
    name,
    present: true,
    hardwareBacked: deviceUevent !== undefined,
    ...(arphrdType !== undefined && Number.isFinite(arphrdType)
      ? { arphrdType }
      : {}),
    ...(devType ? { devType } : {}),
    lowers,
    aggregateHint: entries.includes("bonding") || entries.includes("bridge"),
  };
}

function isAggregate(facts: NetworkDeviceFacts): boolean {
  if (facts.aggregateHint) return true;
  if (facts.devType && AGGREGATE_DEVTYPES.has(facts.devType)) return true;
  if (facts.hardwareBacked || facts.lowers.length === 0) return false;
  return !(facts.devType && SINGLE_PARENT_CHILD_DEVTYPES.has(facts.devType));
}

/** Memoized, cycle-guarded predicate over the `lower_*`/`upper_*` graph. */
function graphPredicate(
  compute: (name: string, recurse: (next: string) => boolean) => boolean,
): (name: string) => boolean {
  const memo = new Map<string, boolean>();
  const visiting = new Set<string>();
  const evaluate = (name: string): boolean => {
    const cached = memo.get(name);
    if (cached !== undefined) return cached;
    if (visiting.has(name)) return false;
    visiting.add(name);
    const result = compute(name, evaluate);
    visiting.delete(name);
    memo.set(name, result);
    return result;
  };
  return evaluate;
}

export type NetworkClassification = {
  kinds: Map<string, NetworkDeviceKind>;
  /**
   * The `uplink` that carries `routeInterface`'s traffic, or `undefined`
   * when the route sits on a device with no monitorable uplink under or
   * over it (a WireGuard tunnel, a Docker bridge). Walks `lower_*` first
   * (VLAN child → port, bridge → bond → port) then `upper_*` (a bond port
   * or nested bond → the bridge that tops the stack).
   */
  resolveUplinkFor: (routeInterface: string) => string | undefined;
};

/** Classify every enumerated interface from its sysfs facts (pure — no I/O). */
export function classifyNetworkDevices(
  allFacts: readonly NetworkDeviceFacts[],
  fabricInterfaces: readonly string[],
): NetworkClassification {
  const byName = new Map(allFacts.map((facts) => [facts.name, facts]));
  const uppers = new Map<string, string[]>();
  for (const facts of allFacts) {
    for (const lower of facts.lowers) {
      const list = uppers.get(lower) ?? [];
      list.push(facts.name);
      uppers.set(lower, list);
    }
  }

  const physicalBacked = graphPredicate((name, recurse) => {
    const facts = byName.get(name);
    if (!facts) return false;
    if (facts.hardwareBacked) return true;
    return facts.lowers.some(recurse);
  });
  const isPhysicalAggregate = (name: string): boolean => {
    const facts = byName.get(name);
    return facts !== undefined && isAggregate(facts) && physicalBacked(name);
  };
  const hasAggregateAbove = graphPredicate((name, recurse) =>
    (uppers.get(name) ?? []).some((upper) =>
      isPhysicalAggregate(upper) || recurse(upper)
    )
  );

  const kinds = new Map<string, NetworkDeviceKind>();
  for (const facts of allFacts) {
    const byPrefix = classifyInterface(facts.name, [...fabricInterfaces]);
    if (byPrefix !== "uplink") {
      kinds.set(facts.name, byPrefix);
      continue;
    }
    kinds.set(
      facts.name,
      refineUplinkKind(facts, {
        physicalBacked: physicalBacked(facts.name),
        aggregate: isAggregate(facts),
        aggregateAbove: hasAggregateAbove(facts.name),
      }),
    );
  }

  const resolveUplinkFor = (routeInterface: string): string | undefined => {
    const queue = [routeInterface];
    const seen = new Set<string>(queue);
    while (queue.length > 0) {
      const name = queue.shift()!;
      if (kinds.get(name) === "uplink") return name;
      const next = [
        ...(byName.get(name)?.lowers ?? []),
        ...(uppers.get(name) ?? []),
      ];
      for (const candidate of next) {
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        queue.push(candidate);
      }
    }
    return undefined;
  };

  return { kinds, resolveUplinkFor };
}

function refineUplinkKind(
  facts: NetworkDeviceFacts,
  graph: {
    physicalBacked: boolean;
    aggregate: boolean;
    aggregateAbove: boolean;
  },
): NetworkDeviceKind {
  if (graph.physicalBacked) {
    if (graph.aggregateAbove) return "member";
    if (facts.hardwareBacked || graph.aggregate) return "uplink";
    return "virtual";
  }
  if (graph.aggregate) return "container-bridge";
  if (isBareEthernet(facts)) return "uplink";
  return "virtual";
}

const ARPHRD_ETHER = 1;

/**
 * A present, plain Ethernet device that nothing marks as virtual — the
 * renamed veth peer a container sees as its `eth0`. Missing `type` (older
 * fixtures) counts as Ethernet; a non-Ethernet link type (tun/tap, sit,
 * gre) never does. Also tells `identity.ts` to keep the `mac:` id for such
 * a device (nothing shares its MAC — no stack above or below it).
 */
export function isBareEthernet(facts: NetworkDeviceFacts): boolean {
  return facts.present && !facts.hardwareBacked &&
    facts.devType === undefined &&
    facts.lowers.length === 0 &&
    (facts.arphrdType === undefined || facts.arphrdType === ARPHRD_ETHER);
}
