import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { defaultSensorIo } from "../collector/sensors/discovery.ts";
import { collectNetworkTopology } from "./network-topology.ts";

const test = Deno.test.bind(Deno);

function fixtureRoot(name: string): string {
  return fromFileUrl(new URL(`./testdata/${name}`, import.meta.url));
}

function fixtureText(name: string): string {
  return Deno.readTextFileSync(
    new URL(`../collector/testdata/${name}`, import.meta.url),
  );
}

test("collectNetworkTopology classifies uplink/fabric/container-bridge/loopback exactly as the v3 collector does", async () => {
  const devices = await collectNetworkTopology({
    readProcFile: (path) =>
      path === "/proc/net/dev"
        ? fixtureText("proc-net-dev-with-fabric-tunnel.txt")
        : undefined,
    resolveFabricInterfaces: () => Promise.resolve(["tp0"]),
    io: defaultSensorIo(),
    sysRoot: fixtureRoot("net-topology"),
  });

  const byName = new Map(devices.map((d) => [d.name, d]));
  assertEquals(byName.get("lo")?.kind, "loopback");
  assertEquals(byName.get("tp0")?.kind, "fabric");
  assertEquals(byName.get("docker0")?.kind, "container-bridge");
  assertEquals(byName.get("veth123")?.kind, "container-bridge");
  assertEquals(byName.get("eth0")?.kind, "uplink");
});

test("collectNetworkTopology: a renamed interface (same MAC) keeps the same deviceId across ticks", async () => {
  const before = await collectNetworkTopology({
    readProcFile: (path) =>
      path === "/proc/net/dev"
        ? "Inter-|   Receive\n face |bytes\n  eth0: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n"
        : undefined,
    resolveFabricInterfaces: () => Promise.resolve([]),
    io: defaultSensorIo(),
    sysRoot: fixtureRoot("net-topology"),
  });
  const after = await collectNetworkTopology({
    readProcFile: (path) =>
      path === "/proc/net/dev"
        ? "Inter-|   Receive\n face |bytes\n  eth1: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n"
        : undefined,
    resolveFabricInterfaces: () => Promise.resolve([]),
    io: defaultSensorIo(),
    sysRoot: fixtureRoot("net-topology"),
  });

  assertEquals(before.length, 1);
  assertEquals(after.length, 1);
  assertEquals(before[0].name, "eth0");
  assertEquals(after[0].name, "eth1");
  assertEquals(before[0].deviceId, after[0].deviceId);
});

function netDevFor(names: string[]): string {
  const rows = names.map((name) =>
    `  ${name}: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0`
  );
  return `Inter-|   Receive\n face |bytes\n${rows.join("\n")}\n`;
}

/** `/proc/net/route` with one default route on `iface` (metric 100) and one non-default row. */
function routeTableFor(iface: string): string {
  return [
    "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT",
    `${iface}\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0`,
    `${iface}\t0001A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0`,
  ].join("\n") + "\n";
}

const BOND_FIXTURE_NAMES = [
  "lo",
  "bond0",
  "eth0",
  "eth1",
  "br0",
  "eth2",
  "eth3",
  "eth3.100",
  "wg0",
  "docker0",
  "veth1",
  "lxdbr0",
];

function bondFixtureDeps(routeInterface: string) {
  return {
    readProcFile: (path: string) => {
      if (path === "/proc/net/dev") return netDevFor(BOND_FIXTURE_NAMES);
      if (path === "/proc/net/route") return routeTableFor(routeInterface);
      return undefined;
    },
    resolveFabricInterfaces: () => Promise.resolve(["tp0"]),
    io: defaultSensorIo(),
    sysRoot: fixtureRoot("net-topology-bond"),
  };
}

test("collectNetworkTopology: bonds and bridges over physical ports are the uplink, their ports are members, VLAN children and tunnels are virtual, veth-only bridges are container bridges", async () => {
  const devices = await collectNetworkTopology(bondFixtureDeps("bond0"));
  const kinds = new Map(devices.map((d) => [d.name, d.kind]));
  assertEquals(kinds.get("lo"), "loopback");
  assertEquals(kinds.get("bond0"), "uplink");
  assertEquals(kinds.get("eth0"), "member");
  assertEquals(kinds.get("eth1"), "member");
  assertEquals(kinds.get("br0"), "uplink");
  assertEquals(kinds.get("eth2"), "member");
  assertEquals(kinds.get("eth3"), "uplink");
  assertEquals(kinds.get("eth3.100"), "virtual");
  assertEquals(kinds.get("wg0"), "virtual");
  assertEquals(kinds.get("docker0"), "container-bridge");
  assertEquals(kinds.get("veth1"), "container-bridge");
  assertEquals(kinds.get("lxdbr0"), "container-bridge");
});

test("collectNetworkTopology: the default-route flag lands on exactly the uplink carrying the route", async () => {
  const devices = await collectNetworkTopology(bondFixtureDeps("bond0"));
  const flagged = devices.filter((d) => d.defaultRoute === true);
  assertEquals(flagged.map((d) => d.name), ["bond0"]);
  assertEquals(devices.find((d) => d.name === "bond0")?.speedMbps, 2000);
  assertEquals(devices.find((d) => d.name === "bond0")?.mtu, 1500);
});

test("collectNetworkTopology: a default route on a VLAN child resolves down to its physical parent uplink", async () => {
  const devices = await collectNetworkTopology(bondFixtureDeps("eth3.100"));
  const flagged = devices.filter((d) => d.defaultRoute === true);
  assertEquals(flagged.map((d) => d.name), ["eth3"]);
});

test("collectNetworkTopology: a default route on a tunnel or container bridge flags nothing", async () => {
  for (const routeInterface of ["wg0", "docker0", "missing0"]) {
    const devices = await collectNetworkTopology(
      bondFixtureDeps(routeInterface),
    );
    assertEquals(
      devices.filter((d) => d.defaultRoute === true),
      [],
      `route on ${routeInterface}`,
    );
  }
});

test("collectNetworkTopology: bond ports sharing the bond's MAC keep distinct ids, and the bond/bridge/VLAN stack never collides with them", async () => {
  const devices = await collectNetworkTopology(bondFixtureDeps("bond0"));
  const ids = new Map(devices.map((d) => [d.name, d.deviceId]));
  assertEquals(ids.get("eth0"), "mac:aa:bb:cc:00:00:01");
  assertEquals(ids.get("eth1"), "mac:aa:bb:cc:00:00:02");
  assertEquals(ids.get("eth2"), "mac:aa:bb:cc:00:00:03");
  assertEquals(ids.get("bond0")?.startsWith("virtual:"), true);
  assertEquals(ids.get("br0")?.startsWith("virtual:"), true);
  assertEquals(ids.get("eth3.100")?.startsWith("virtual:"), true);
  assertEquals(new Set(ids.values()).size, devices.length);
});

const BRIDGE_OVER_BOND_NAMES = [
  "lo",
  "eth0",
  "eth1",
  "bond0",
  "bond0.5",
  "vmbr0",
  "team0",
  "eth2",
];

function bridgeOverBondDeps(routeInterface: string) {
  return {
    readProcFile: (path: string) => {
      if (path === "/proc/net/dev") return netDevFor(BRIDGE_OVER_BOND_NAMES);
      if (path === "/proc/net/route") return routeTableFor(routeInterface);
      return undefined;
    },
    resolveFabricInterfaces: () => Promise.resolve([]),
    io: defaultSensorIo(),
    sysRoot: fixtureRoot("net-topology-bridge-over-bond"),
  };
}

test("collectNetworkTopology: only the topmost aggregate is the uplink — a bond nested under a bridge (through a VLAN child) is a member, and a team without DEVTYPE still aggregates", async () => {
  const devices = await collectNetworkTopology(bridgeOverBondDeps("vmbr0"));
  const kinds = new Map(devices.map((d) => [d.name, d.kind]));
  assertEquals(kinds.get("vmbr0"), "uplink");
  assertEquals(kinds.get("bond0.5"), "member");
  assertEquals(kinds.get("bond0"), "member");
  assertEquals(kinds.get("eth0"), "member");
  assertEquals(kinds.get("eth1"), "member");
  assertEquals(kinds.get("team0"), "uplink");
  assertEquals(kinds.get("eth2"), "member");
  assertEquals(
    devices.filter((d) => d.defaultRoute === true).map((d) => d.name),
    ["vmbr0"],
  );
});

test("collectNetworkTopology: a default route on a bond port walks up to the bridge that tops its stack", async () => {
  const devices = await collectNetworkTopology(bridgeOverBondDeps("eth1"));
  assertEquals(
    devices.filter((d) => d.defaultRoute === true).map((d) => d.name),
    ["vmbr0"],
  );
});

test("collectNetworkTopology: IPv6 default route is the fallback when IPv4 has none", async () => {
  const devices = await collectNetworkTopology({
    readProcFile: (path: string) => {
      if (path === "/proc/net/dev") return netDevFor(BOND_FIXTURE_NAMES);
      if (path === "/proc/net/ipv6_route") {
        return "00000000000000000000000000000000 00 00000000000000000000000000000000 00 fe800000000000000000000000000001 00000400 00000001 00000000 00000003     eth3\n";
      }
      return undefined;
    },
    resolveFabricInterfaces: () => Promise.resolve([]),
    io: defaultSensorIo(),
    sysRoot: fixtureRoot("net-topology-bond"),
  });
  assertEquals(
    devices.filter((d) => d.defaultRoute === true).map((d) => d.name),
    ["eth3"],
  );
});

const CONTAINER_FIXTURE_NAMES = ["lo", "eth0", "wg0", "tailscale0", "sit0"];

function containerFixtureDeps(routeInterface: string) {
  return {
    readProcFile: (path: string) => {
      if (path === "/proc/net/dev") return netDevFor(CONTAINER_FIXTURE_NAMES);
      if (path === "/proc/net/route") return routeTableFor(routeInterface);
      return undefined;
    },
    resolveFabricInterfaces: () => Promise.resolve([]),
    io: defaultSensorIo(),
    sysRoot: fixtureRoot("net-topology-container"),
  };
}

test("collectNetworkTopology: a container's renamed veth peer (no bus device, no DEVTYPE, Ethernet) is the uplink and carries the default route; tun/sit/WireGuard stay virtual", async () => {
  const devices = await collectNetworkTopology(containerFixtureDeps("eth0"));
  const kinds = new Map(devices.map((d) => [d.name, d.kind]));
  assertEquals(kinds.get("lo"), "loopback");
  assertEquals(kinds.get("eth0"), "uplink");
  assertEquals(kinds.get("wg0"), "virtual");
  assertEquals(kinds.get("tailscale0"), "virtual");
  assertEquals(kinds.get("sit0"), "virtual");
  const eth0 = devices.find((d) => d.name === "eth0");
  assertEquals(eth0?.defaultRoute, true);
  assertEquals(eth0?.deviceId, "mac:0a:1b:2c:3d:4e:5f");
  assertEquals(eth0?.speedMbps, 10000);
  assertEquals(devices.filter((d) => d.defaultRoute === true).length, 1);
});

test("collectNetworkTopology: missing /proc/net/dev yields no devices", async () => {
  const devices = await collectNetworkTopology({
    readProcFile: () => undefined,
    resolveFabricInterfaces: () => Promise.resolve(["tp0"]),
    io: defaultSensorIo(),
    sysRoot: fixtureRoot("net-topology"),
  });
  assertEquals(devices, []);
});

test("collectNetworkTopology: a throwing fabric resolver degrades to no fabric names", async () => {
  const devices = await collectNetworkTopology({
    readProcFile: (path) =>
      path === "/proc/net/dev" ? netDevFor(["eth0", "tp0"]) : undefined,
    resolveFabricInterfaces: () => Promise.reject(new Error("wg dump failed")),
    io: defaultSensorIo(),
    sysRoot: fixtureRoot("net-topology"),
  });
  const tp0 = devices.find((d) => d.name === "tp0");
  if (!tp0) throw new TypeError("expected tp0 to still be enumerated");
  assertEquals(tp0.kind === "fabric", false);
});

test("collectNetworkTopology: invalid or missing speed/mtu are omitted rather than coerced", async () => {
  const devices = await collectNetworkTopology({
    readProcFile: (path) =>
      path === "/proc/net/dev" ? netDevFor(["eth0"]) : undefined,
    resolveFabricInterfaces: () => Promise.resolve([]),
    io: {
      listDir: defaultSensorIo().listDir,
      readFile: (path) => {
        if (path.endsWith("/speed")) return " -1\n";
        if (path.endsWith("/mtu")) return "not-a-number\n";
        return defaultSensorIo().readFile(path);
      },
    },
    sysRoot: fixtureRoot("net-topology"),
  });
  assertEquals(devices.length, 1);
  assertEquals(devices[0].speedMbps, undefined);
  assertEquals(devices[0].mtu, undefined);
});

test("collectNetworkTopology: a throwing default-route read leaves defaultRoute unset", async () => {
  const devices = await collectNetworkTopology({
    readProcFile: (path) => {
      if (path === "/proc/net/dev") return netDevFor(["eth0"]);
      throw new Error("route tables unreadable");
    },
    resolveFabricInterfaces: () => Promise.resolve([]),
    io: defaultSensorIo(),
    sysRoot: fixtureRoot("net-topology"),
  });
  assertEquals(devices[0]?.defaultRoute, undefined);
});

test("collectNetworkTopology: defaults sysRoot to /sys when omitted", async () => {
  const readPaths: string[] = [];
  const devices = await collectNetworkTopology({
    readProcFile: (path) =>
      path === "/proc/net/dev" ? netDevFor(["lo"]) : undefined,
    resolveFabricInterfaces: () => Promise.resolve([]),
    io: {
      listDir: () => [],
      readFile: (path) => {
        readPaths.push(path);
        return undefined;
      },
    },
  });
  assertEquals(devices.length, 1);
  assertEquals(devices[0].kind, "loopback");
  assertEquals(
    readPaths.some((path) => path.startsWith("/sys/class/net/lo/")),
    true,
  );
});

test("collectNetworkTopology: an uplink-named device with no sysfs entry at all is virtual, never an uplink", async () => {
  const devices = await collectNetworkTopology({
    readProcFile: (path: string) => {
      if (path === "/proc/net/dev") return netDevFor(["eth0", "eth9"]);
      if (path === "/proc/net/route") return routeTableFor("eth9");
      return undefined;
    },
    resolveFabricInterfaces: () => Promise.resolve([]),
    io: defaultSensorIo(),
    sysRoot: fixtureRoot("net-topology-container"),
  });
  const byName = new Map(devices.map((d) => [d.name, d]));
  assertEquals(byName.get("eth9")?.kind, "virtual");
  assertEquals(byName.get("eth9")?.defaultRoute, undefined);
  assertEquals(byName.get("eth0")?.kind, "uplink");
  assertEquals(byName.get("eth0")?.defaultRoute, undefined);
});
