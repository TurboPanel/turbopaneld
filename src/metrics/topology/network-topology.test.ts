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
