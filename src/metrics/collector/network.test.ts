import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import {
  classifiedNetRates,
  classifyInterface,
  interfaceNamesByClass,
  namedInterfaceRates,
  readNetCounters,
} from "./network.ts";

function fixture(name: string): string {
  return Deno.readTextFileSync(
    new URL(`./testdata/${name}`, import.meta.url),
  );
}

const FABRIC = ["tp0"];

it("classifyInterface maps loopback, fabric, bridges, and uplinks", () => {
  assertEquals(classifyInterface("lo", FABRIC), "loopback");
  assertEquals(classifyInterface("tp0", FABRIC), "fabric");
  assertEquals(classifyInterface("veth123", FABRIC), "container-bridge");
  assertEquals(classifyInterface("docker0", FABRIC), "container-bridge");
  assertEquals(classifyInterface("br-abc", FABRIC), "container-bridge");
  assertEquals(classifyInterface("virbr0", FABRIC), "container-bridge");
  assertEquals(classifyInterface("vnet0", FABRIC), "container-bridge");
  assertEquals(classifyInterface("tap0", FABRIC), "container-bridge");
  assertEquals(classifyInterface("tun0", FABRIC), "container-bridge");
  assertEquals(classifyInterface("eth0", FABRIC), "uplink");
  assertEquals(classifyInterface("wlan0", FABRIC), "uplink");
  assertEquals(classifyInterface("enp3s0", FABRIC), "uplink");
  // A fabric registration wins over a prefix match.
  assertEquals(classifyInterface("tun9", ["tun9"]), "fabric");
});

it("readNetCounters preserves all three traffic classes independently", () => {
  const net = readNetCounters(
    fixture("proc-net-dev-with-fabric-tunnel.txt"),
    FABRIC,
  );
  if (!net) throw new TypeError("expected classified interfaces");
  assertEquals(interfaceNamesByClass(net, "uplink"), ["eth0"]);
  assertEquals(interfaceNamesByClass(net, "fabric"), ["tp0"]);
  assertEquals(interfaceNamesByClass(net, "container-bridge"), [
    "docker0",
    "veth123",
  ]);
  assertEquals(interfaceNamesByClass(net, "loopback"), ["lo"]);
  assertEquals(net.interfaces.tp0.classification, "fabric");
  assertEquals(net.interfaces.tp0.receiveBytes, 400_000);
});

it("classifiedNetRates aggregates uplink and fabric separately, never combined", () => {
  const prev = readNetCounters(
    fixture("proc-net-dev-with-fabric-tunnel.txt"),
    FABRIC,
  );
  const currText = fixture("proc-net-dev-with-fabric-tunnel.txt")
    .replace("  eth0: 5000000", "  eth0: 5600000")
    .replace("3000000    2000", "3300000    2100")
    .replace("   tp0: 400000", "   tp0: 460000")
    .replace("300000      150", "330000      160");
  const curr = readNetCounters(currText, FABRIC);

  const uplink = classifiedNetRates(prev, curr, "uplink", 60);
  const fabric = classifiedNetRates(prev, curr, "fabric", 60);
  assertEquals(uplink.receiveBytesPerSecond, 600_000 / 60);
  assertEquals(uplink.transmitBytesPerSecond, 300_000 / 60);
  assertEquals(fabric.receiveBytesPerSecond, 60_000 / 60);
  assertEquals(fabric.transmitBytesPerSecond, 30_000 / 60);
});

it("veth churn nulls only the container-bridge class, not uplink or fabric", () => {
  const prev = readNetCounters(
    fixture("proc-net-dev-with-fabric-tunnel.txt"),
    FABRIC,
  );
  const withoutVeth = fixture("proc-net-dev-with-fabric-tunnel.txt")
    .split("\n")
    .filter((line) => !line.includes("veth123"))
    .join("\n");
  const curr = readNetCounters(withoutVeth, FABRIC);

  const uplink = classifiedNetRates(prev, curr, "uplink", 60);
  const bridge = classifiedNetRates(prev, curr, "container-bridge", 60);
  assertEquals(uplink.receiveBytesPerSecond, 0);
  assertEquals(bridge.receiveBytesPerSecond, null);
});

it("classifiedNetRates nulls a class with no interfaces instead of reporting 0", () => {
  const noFabric = readNetCounters(fixture("proc-net-dev.txt"), FABRIC);
  const rates = classifiedNetRates(noFabric, noFabric, "fabric", 60);
  assertEquals(rates.receiveBytesPerSecond, null);
  assertEquals(rates.transmitBytesPerSecond, null);
});

it("readNetCounters returns null when nothing is parsable", () => {
  assertEquals(readNetCounters("", FABRIC), null);
});

it("namedInterfaceRates nulls an unassigned slot", () => {
  const net = readNetCounters(fixture("proc-net-dev.txt"), FABRIC);
  const rates = namedInterfaceRates(net, net, null, 60);
  assertEquals(rates.receiveBytesPerSecond, null);
  assertEquals(rates.transmitBytesPerSecond, null);
});

it("namedInterfaceRates nulls on the first sample", () => {
  const net = readNetCounters(
    fixture("proc-net-dev-with-fabric-tunnel.txt"),
    FABRIC,
  );
  const rates = namedInterfaceRates(null, net, "eth0", 60);
  assertEquals(rates.receiveBytesPerSecond, null);
  assertEquals(rates.transmitBytesPerSecond, null);
});

it("namedInterfaceRates computes an assigned slot's rate independently of class aggregation", () => {
  const prev = readNetCounters(
    fixture("proc-net-dev-with-fabric-tunnel.txt"),
    FABRIC,
  );
  const currText = fixture("proc-net-dev-with-fabric-tunnel.txt")
    .replace("  eth0: 5000000", "  eth0: 5600000")
    .replace("3000000    2000", "3300000    2100")
    .replace("   tp0: 400000", "   tp0: 460000")
    .replace("300000      150", "330000      160");
  const curr = readNetCounters(currText, FABRIC);

  const nic1 = namedInterfaceRates(prev, curr, "eth0", 60);
  assertEquals(nic1.receiveBytesPerSecond, 600_000 / 60);
  assertEquals(nic1.transmitBytesPerSecond, 300_000 / 60);

  // eth0 is also part of the uplink class aggregate — both agree here
  // because it's the only uplink member, but the two lookups are
  // independent paths.
  const uplink = classifiedNetRates(prev, curr, "uplink", 60);
  assertEquals(nic1.receiveBytesPerSecond, uplink.receiveBytesPerSecond);
});

it("namedInterfaceRates nulls only the vanished slot when an assigned interface disappears", () => {
  const prev = readNetCounters(
    fixture("proc-net-dev-with-fabric-tunnel.txt"),
    FABRIC,
  );
  const withoutVeth = fixture("proc-net-dev-with-fabric-tunnel.txt")
    .split("\n")
    .filter((line) => !line.includes("veth123"))
    .join("\n");
  const curr = readNetCounters(withoutVeth, FABRIC);

  const vanished = namedInterfaceRates(prev, curr, "veth123", 60);
  assertEquals(vanished.receiveBytesPerSecond, null);
  assertEquals(vanished.transmitBytesPerSecond, null);

  // eth0's counters are unchanged between prev and this veth-stripped curr
  // (same fixture, only the veth123 line removed) — 0, not null: a present,
  // unchanged interface is a real zero-traffic reading.
  const stillPresent = namedInterfaceRates(prev, curr, "eth0", 60);
  assertEquals(stillPresent.receiveBytesPerSecond, 0);
});
